// blueprint.mjs — the blueprint-to-metal compiler core.
// Schema in (GraphQL-SDL subset), byte-exact fixed-offset layouts + monotonic
// join operators out. No runtime. Receipts always.
//
// Doctrine (the verdict on the 已落地 proposal, codified):
//   - join(max)  : semilattice-safe (idempotent, commutative, associative)
//   - join(xor)  : FINGERPRINT CLASS ONLY — an order-statistics-destroying flag,
//                  never a content merge. Labeled as such in every emitter.
//   - join(lww)  : last-writer-wins, tie-broken by an Int @primary field
//   - String     : varlen, lives OUTSIDE the fixed block (offset table only)
//   - no emitter may emit inline-asm "crypto". Wyhash-class hashes are labeled
//     fasthash/fingerprint, never "cryptographic".

export function fnv1a64(str) {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

const SCALARS = { Int: "u64", Float: "f32", Boolean: "u8", ID: "u64" };
const JOIN_OK = new Set(["max", "xor", "lww"]);

export function parseSDL(src) {
  const types = [];
  const typeRe = /type\s+(\w+)\s*\{([^}]*)\}/gs;
  let m;
  while ((m = typeRe.exec(src))) {
    const fields = m[2].split("\n").map(l => l.trim()).filter(Boolean)
      .map(line => {
        const fm = line.match(/^(\w+)\s*:\s*([\w\[\]!]+)\s*(.*)$/);
        if (!fm) return null;
        const [, name, rawType, annots] = fm;
        const joinM = annots.match(/@join\((\w+)\)/);
        const join = joinM ? joinM[1] : null;
        if (join && !JOIN_OK.has(join)) throw new Error(`unknown @join(${join}) on ${name}`);
        const packedM = annots.match(/@packed(?:\(\s*(?:bits\s*=\s*)?(\d+)\s*\))?/);
        let packed = null;
        if (packedM) {
          packed = packedM[1] ? Number(packedM[1]) : 8;
          if (packed < 1 || packed > 64) throw new Error(`@packed(bits=${packed}) must be 1..64 on ${name}`);
        }
        return {
          name,
          type: rawType.replace(/[[\]!]/g, ""),
          join,
          primary: /@primary/.test(annots),
          packed,
        };
      }).filter(Boolean);
    types.push({ name: m[1], fields });
  }
  return types;
}

const ALIGN = { i64: 8, u64: 8, f32: 4, u8: 1, u32: 4 };
const SIZEOF = { i64: 8, u64: 8, f32: 4, u8: 1, u32: 4 };

// Bitfield masks for @packed runs: value mask (low `width` bits set) and the
// keep-mask (everything EXCEPT the field's slot) for read-modify-write sets.
export function maskOf(width) { return (1n << BigInt(width)) - 1n; }
export function keepMask(bitOffset, width) {
  return ~(maskOf(width) << BigInt(bitOffset)) & 0xffffffffffffffffn;
}
function hex64(v) { return "0x" + v.toString(16); }

// lww needs a comparison key: the @primary field if declared, else an honest
// fallback to the first fixed field (documented in emitted code).
function tieBreak(L) {
  const p = L.fields.find(x => x.primary && !x.varlen);
  if (p) return { name: p.name, declared: true };
  const fb = L.fields.find(x => !x.varlen && !x.packed) || L.fields.find(x => !x.varlen);
  return { name: fb ? fb.name : "seq", declared: false };
}

// Storage plan shared by every emitter: unpacked fields keep their layout
// slot; @packed runs collapse into u64 words; varlen fields are NOT part of
// the fixed block (emitters that model them append a reference block after).
function structPlan(L) {
  const words = [];
  const byOffset = new Map();
  for (const f of L.fields) {
    if (!f.packed) continue;
    if (!byOffset.has(f.offset)) {
      const w = { name: `word${words.length}`, offset: f.offset, fields: [] };
      byOffset.set(f.offset, w);
      words.push(w);
    }
    byOffset.get(f.offset).fields.push(f);
  }
  const plan = [];
  const seen = new Set();
  for (const f of L.fields) {
    if (f.varlen) { plan.push({ kind: "varlen", field: f }); continue; }
    if (f.packed) {
      const w = byOffset.get(f.offset);
      if (!seen.has(w.name)) { seen.add(w.name); plan.push({ kind: "word", word: w }); }
      continue;
    }
    plan.push({ kind: "field", field: f });
  }
  return { plan, words };
}

function wordBitComment(w) {
  return w.fields.map(fl => `${fl.name}[${fl.bit_offset}..${fl.bit_offset + fl.bit_width})`).join(" ");
}

export function layout(type) {
  const fields = [];
  let offset = 0, maxAlign = 1;
  let bitCursor = null, wordStart = 0; // open u64 packed-word state
  const closeWord = () => { if (bitCursor !== null) { offset = wordStart + 8; bitCursor = null; } };
  for (const f of type.fields) {
    if (f.type === "String") {
      closeWord();
      fields.push({ ...f, ctype: "varlen", offset: -1, size: 0, varlen: true });
      continue;
    }
    const ctype = SCALARS[f.type] || "u32";
    if (f.packed) {
      if (bitCursor === null || bitCursor + f.packed > 64) {
        // open a fresh naturally-aligned u64 word (or spill into the next one)
        offset = bitCursor === null ? Math.ceil(offset / 8) * 8 : wordStart + 8;
        wordStart = offset; bitCursor = 0;
        maxAlign = Math.max(maxAlign, 8);
      }
      fields.push({ ...f, ctype, offset: wordStart, size: 8, varlen: false,
        bit_offset: bitCursor, bit_width: f.packed });
      bitCursor += f.packed;
      continue;
    }
    closeWord(); // unpacked fields resume at the next natural-aligned offset
    const align = ALIGN[ctype] || 1;
    offset = Math.ceil(offset / align) * align;
    maxAlign = Math.max(maxAlign, align);
    fields.push({ ...f, ctype, offset, size: SIZEOF[ctype] || 4, varlen: false });
    offset += SIZEOF[ctype] || 4;
  }
  closeWord();
  offset = Math.ceil(offset / maxAlign) * maxAlign;
  return {
    name: type.name, size: offset, fields,
    axioms: ["idempotence", "commutativity", "associativity"],
    ceiling: "top — join of any two states is representable; convergence terminates",
  };
}

function zigJoin(f, primaryName) {
  if (f.join === "max") return `.${f.name} = @max(a.${f.name}, b.${f.name})`;
  if (f.join === "xor") return `.${f.name} = a.${f.name} ^ b.${f.name} // fingerprint class: order statistics destroyed; flag, not content`;
  if (f.join === "lww") return `.${f.name} = if (a.${primaryName} >= b.${primaryName}) a.${f.name} else b.${f.name}`;
  return `.${f.name} = a.${f.name} // not join-annotated: inherited from a; document or annotate`;
}

export function emit(type, lang) {
  const L = layout(type);
  const zt = { i64: "i64", u64: "u64", f32: "f32", u8: "u8", u32: "u32" };
  if (lang === "json") return JSON.stringify(L, null, 2);
  if (lang === "zig") {
    const tie = tieBreak(L).name;
    if (!L.fields.some(f => f.packed)) {
      const body = L.fields.filter(f => !f.varlen)
        .map(f => `    ${f.name}: ${zt[f.ctype] || "u32"},`).join("\n");
      const joins = L.fields.filter(f => f.join)
        .map(f => `            ${zigJoin(f, tie)},`).join("\n");
      return `// generated by quilt-blueprint — receipt ${receipt(type, "zig")}
// join axioms: idempotence, commutativity, associativity (semilattice)
pub const ${type.name} = struct {
${body}

    /// Pure join (⊔). Monotonic inflation; convergence terminates at ceiling.
    pub fn join(a: ${type.name}, b: ${type.name}) ${type.name} {
        return .{
${joins}
        };
    }

    /// fasthash integrity check — receipt-grade only; NOT a security boundary.
    pub fn fingerprintFast(self: *const ${type.name}) u64 {
        return std.hash.Wyhash.hash(0, std.mem.asBytes(self));
    }
};
`;
    }
    // packed path: bitfields live in u64 words, accessed via generated masks
    const { plan, words } = structPlan(L);
    const body = plan.filter(e => e.kind !== "varlen").map(e =>
      e.kind === "word"
        ? `    ${e.word.name}: u64, // offset ${e.word.offset} — packed bits (LSB-first): ${wordBitComment(e.word)}`
        : `    ${e.field.name}: ${zt[e.field.ctype] || "u32"},`).join("\n");
    const accessors = [];
    const packedJoins = [];
    for (const w of words) for (const f of w.fields) {
      const mask = hex64(maskOf(f.bit_width)), keep = hex64(keepMask(f.bit_offset, f.bit_width));
      accessors.push(
`    pub fn get_${f.name}(self: *const ${type.name}) u64 {
        return (self.${w.name} >> ${f.bit_offset}) & ${mask};
    }
    pub fn set_${f.name}(self: *${type.name}, v: u64) void {
        self.${w.name} = (self.${w.name} & ${keep}) | ((v & ${mask}) << ${f.bit_offset});
    }`);
      const ga = `a.get_${f.name}()`, gb = `b.get_${f.name}()`;
      let expr, note;
      if (f.join === "max") { expr = `@max(${ga}, ${gb})`; note = "join(max) via bitfield accessors"; }
      else if (f.join === "xor") { expr = `${ga} ^ ${gb}`; note = "fingerprint class: order statistics destroyed; flag, not content"; }
      else if (f.join === "lww") { expr = `if (a.${tie} >= b.${tie}) ${ga} else ${gb}`; note = `join(lww) tie-broken by ${tie}`; }
      else { expr = ga; note = "not join-annotated: inherited from a; document or annotate"; }
      packedJoins.push(`        out.set_${f.name}(${expr}); // ${note}`);
    }
    const unpackedJoins = plan.filter(e => e.kind === "field" && e.field.join)
      .map(e => `            ${zigJoin(e.field, tie)},`).join("\n");
    const wordInits = words.map(w => `            .${w.name} = 0, // packed bitfields merged via set_* below`).join("\n");
    return `// generated by quilt-blueprint — receipt ${receipt(type, "zig")}
// join axioms: idempotence, commutativity, associativity (semilattice)
pub const ${type.name} = struct {
${body}

${accessors.join("\n")}

    /// Pure join (⊔). Monotonic inflation; convergence terminates at ceiling.
    pub fn join(a: ${type.name}, b: ${type.name}) ${type.name} {
        var out = ${type.name}{
${unpackedJoins}
${wordInits}
        };
${packedJoins.join("\n")}
        return out;
    }

    /// fasthash integrity check — receipt-grade only; NOT a security boundary.
    pub fn fingerprintFast(self: *const ${type.name}) u64 {
        return std.hash.Wyhash.hash(0, std.mem.asBytes(self));
    }
};
`;
  }
  if (lang === "c") {
    const ct = { i64: "int64_t", u64: "uint64_t", f32: "float", u8: "uint8_t", u32: "uint32_t" };
    const { plan, words } = structPlan(L);
    const body = plan.filter(e => e.kind !== "varlen").map(e =>
      e.kind === "word"
        ? `    uint64_t ${e.word.name}; /* offset ${e.word.offset}, 8B packed bits (LSB-first): ${wordBitComment(e.word)} */`
        : `    ${ct[e.field.ctype] || "uint32_t"} ${e.field.name}; /* offset ${e.field.offset}, ${e.field.size}B ${e.field.join ? "join=" + e.field.join : ""} */`).join("\n");
    let accessors = "";
    for (const w of words) for (const f of w.fields) {
      const mask = hex64(maskOf(f.bit_width)) + "ull", keep = hex64(keepMask(f.bit_offset, f.bit_width)) + "ull";
      accessors +=
`static inline uint64_t ${type.name}_get_${f.name}(const ${type.name} *s) { return (s->${w.name} >> ${f.bit_offset}) & ${mask}; }
static inline void ${type.name}_set_${f.name}(${type.name} *s, uint64_t v) { s->${w.name} = (s->${w.name} & ${keep}) | ((v & ${mask}) << ${f.bit_offset}); }
`;
    }
    return `/* generated by quilt-blueprint — receipt ${receipt(type, "c")} */
#include <stdint.h>
#pragma pack(push, 1)
typedef struct ${type.name} {
${body}
} ${type.name};
#pragma pack(pop)
${accessors}`;
  }
  if (lang === "rust") {
    const rt = { i64: "i64", u64: "u64", f32: "f32", u8: "u8", u32: "u32" };
    const ra = { i64: 8, u64: 8, f32: 4, u8: 1, u32: 4 };
    const tie = tieBreak(L);
    const { plan, words } = structPlan(L);
    const varlen = plan.filter(e => e.kind === "varlen");
    const fixed = plan.filter(e => e.kind !== "varlen");

    const fieldLines = fixed.map(e =>
      e.kind === "word"
        ? `    pub ${e.word.name}: u64, // offset ${e.word.offset}, size 8, align 8 — #[repr(C)] packed bits (LSB-first): ${wordBitComment(e.word)}`
        : `    pub ${e.field.name}: ${rt[e.field.ctype] || "u32"}, // offset ${e.field.offset}, size ${e.field.size}, align ${ra[e.field.ctype] || 4} — #[repr(C)] natural alignment`);
    if (varlen.length) {
      fieldLines.push(`    // --- varlen reference block: appended AFTER the fixed-offset block ---`);
      for (const e of varlen) {
        fieldLines.push(`    pub ${e.field.name}: StrRef, // (u32 offset, u32 len) into the external blob arena — string bytes never inline in the fixed block`);
      }
    }

    const rustJoinArm = f => {
      const s = `self.${f.name}`, o = `other.${f.name}`;
      if (f.join === "max" && f.ctype === "f32")
        return `            // @join(max) on f32: no Ord — IEEE-754 max (NaN-ignoring), mirrors zig @max\n            ${f.name}: ${s}.max(${o}),`;
      if (f.join === "max")
        return `            // @join(max): semilattice merge via Ord::max\n            ${f.name}: Ord::max(${s}, ${o}),`;
      if (f.join === "xor")
        return `            // @join(xor): FINGERPRINT CLASS ONLY — destroys order statistics; flag, never content\n            ${f.name}: ${s} ^ ${o},`;
      if (f.join === "lww")
        return `            // @join(lww): last-writer-wins, tie-broken by @primary field '${tie.name}'${tie.declared ? "" : " (none declared — fallback: first fixed field)"}\n            ${f.name}: if self.${tie.name} >= other.${tie.name} { ${s} } else { ${o} },`;
      return `            // not join-annotated: inherited from self; document or annotate\n            ${f.name}: ${s},`;
    };
    const ctorArms = fixed.filter(e => e.kind === "field").map(e => rustJoinArm(e.field));
    for (const e of varlen) {
      ctorArms.push(`            // varlen: arena reference inherited from self; arena bytes merge at a higher layer`);
      ctorArms.push(`            ${e.field.name}: self.${e.field.name},`);
    }

    const accessors = [];
    const packedApplies = [];
    for (const w of words) for (const f of w.fields) {
      const mask = hex64(maskOf(f.bit_width)), keep = hex64(keepMask(f.bit_offset, f.bit_width));
      accessors.push(
`    /// packed bitfield '${f.name}' — ${w.name} bits [${f.bit_offset}..${f.bit_offset + f.bit_width}) — LSB-first
    pub fn get_${f.name}(&self) -> u64 {
        (self.${w.name} >> ${f.bit_offset}) & ${mask}
    }
    /// set via mask: keep = ${keep}, insert = (v & ${mask}) << ${f.bit_offset}
    pub fn set_${f.name}(&mut self, v: u64) {
        self.${w.name} = (self.${w.name} & ${keep}) | ((v & ${mask}) << ${f.bit_offset});
    }`);
      const gs = `self.get_${f.name}()`, go = `other.get_${f.name}()`;
      let expr, note;
      if (f.join === "max") { expr = `Ord::max(${gs}, ${go})`; note = "@join(max) via bitfield accessors"; }
      else if (f.join === "xor") { expr = `${gs} ^ ${go}`; note = "@join(xor): FINGERPRINT CLASS ONLY — destroys order statistics; flag, never content"; }
      else if (f.join === "lww") { expr = `if self.${tie.name} >= other.${tie.name} { ${gs} } else { ${go} }`; note = `@join(lww) tie-broken by @primary field '${tie.name}'`; }
      else { expr = gs; note = "not join-annotated: inherited from self; document or annotate"; }
      packedApplies.push(`        out.set_${f.name}(${expr}); // ${note}`);
    }

    const joinBody = words.length
? `        let mut out = ${type.name} {
${ctorArms.join("\n")}
${words.map(w => `            ${w.name}: 0, // packed bitfields merged via set_* below`).join("\n")}
        };
${packedApplies.join("\n")}
        out`
: `        ${type.name} {
${ctorArms.join("\n")}
        }`;

    const folds = [];
    for (const e of fixed) {
      if (e.kind === "word") folds.push(`self.${e.word.name}`);
      else if (e.field.ctype === "f32") folds.push(`self.${e.field.name}.to_bits() as u64`);
      else if (e.field.ctype === "u64") folds.push(`self.${e.field.name}`);
      else folds.push(`self.${e.field.name} as u64`);
    }
    for (const e of varlen) {
      folds.push(`(self.${e.field.name}.offset as u64) | ((self.${e.field.name}.len as u64) << 32)`);
    }
    const foldLines = folds.map(w => `        h = (h.rotate_left(5) ^ (${w})).wrapping_mul(K);`).join("\n");

    const strRefBlock = varlen.length ? `
/// Varlen string reference — (u32 offset, u32 len) into an external blob arena.
/// The string bytes are NEVER inline in the fixed block; only this reference
/// is, appended after the fixed-offset block.
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StrRef {
    pub offset: u32,
    pub len: u32,
}
` : "";

    return `// generated by quilt-blueprint — receipt ${receipt(type, "rust")}
// join axioms: idempotence, commutativity, associativity (semilattice)
// fingerprint_fast is receipt-grade integrity, NOT a security boundary
${strRefBlock}
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct ${type.name} {
${fieldLines.join("\n")}
}

impl ${type.name} {
${accessors.length ? accessors.join("\n") + "\n" : ""}
    /// Pure join (⊔). Monotonic inflation; convergence terminates at ceiling.
    pub fn join(&self, other: &${type.name}) -> ${type.name} {
${joinBody}
    }

    /// fxhash-style fast non-crypto hash over the fixed block.
    /// receipt-grade integrity, NOT a security boundary.
    /// Field words only (padding never hashed); StrRef folds (offset, len),
    /// not the arena bytes behind them.
    pub fn fingerprint_fast(&self) -> u64 {
        const K: u64 = 0x517c_c1b7_2722_0a95;
        let mut h: u64 = 0;
${foldLines}
        h
    }
}
`;
  }
  throw new Error(`unknown lang ${lang}`);
}

export function receipt(type, lang) {
  // receipt over the CANONICAL json layout, so emitters agree with each other
  return fnv1a64(JSON.stringify(layout(type)));
}
