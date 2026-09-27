// tests/test_blueprint.mjs — FAIL-first pins for the blueprint compiler.
// Run: node tests/test_blueprint.mjs   (exit 0 = all green)
import { parseSDL, layout, emit, receipt, fnv1a64 } from "../blueprint.mjs";

let n = 0, bad = 0;
const check = (name, cond) => { n++; if (!cond) { bad++; console.log(`not ok — ${name}`); } else console.log(`ok — ${name}`); };

// --- 1. parse: a type with scalars and join annotations -------------------
const sdl = `
type CellState {
  seq: Int! @join(max) @primary
  weight: Float! @join(max)
  fingerprint: Int! @join(xor)
  note: String
}
`;
const types = parseSDL(sdl);
check("parse finds one type", types.length === 1);
check("type name survives", types[0].name === "CellState");
check("four fields parsed", types[0].fields.length === 4);
check("join(max) recorded on seq", types[0].fields[0].join === "max");
check("primary flag recorded", types[0].fields[0].primary === true);
check("join(xor) recorded on fingerprint", types[0].fields[2].join === "xor");
check("unannotated field joins nothing", types[0].fields[3].join === null);

// --- 2. layout: natural alignment, deterministic offsets ------------------
const L = layout(types[0]);
const f = Object.fromEntries(L.fields.map(x => [x.name, x]));
check("layout size = sum with alignment (8+4+8+? string is ptr)", L.size >= 24);
check("seq at offset 0", f.seq.offset === 0);
check("seq is i64/u64 class", f.seq.ctype === "u64");
check("weight is f32 class", f.weight.ctype === "f32");
check("offsets are monotonic over fixed fields", L.fields.filter(x => !x.varlen).every((x, i, a) => i === 0 || x.offset > a[i-1].offset));

// --- 3. zig emitter: struct + honest join (max, not fake crypto) ----------
const zig = emit(types[0], "zig");
check("zig emits pub const struct", /pub const CellState = struct/.test(zig));
check("zig join uses @max for seq", /@max\(.*seq/.test(zig));
check("zig join uses ^ for xor fingerprint", /\^/.test(zig));
check("zig does NOT claim cryptographic checksum", !/cryptographic/i.test(zig));
check("zig marks wyhash-class hash as non-crypto", /noncrypto|fasthash|fingerprint/i.test(zig));

// --- 4. c emitter: pragma pack, offsets as comments ------------------------
const c = emit(types[0], "c");
check("c emits pragma pack", /#pragma pack\(push, 1\)|#pragma pack\(1\)/.test(c));
check("c struct named after type", /typedef struct CellState/.test(c));
check("c field order matches layout", c.indexOf("seq") < c.indexOf("weight") && c.indexOf("weight") < c.indexOf("fingerprint"));

// --- 5. json layout: exact offsets, receipt-attachable ---------------------
const j = JSON.parse(emit(types[0], "json"));
check("json round-trips type name", j.name === "CellState");
check("json carries per-field offsets", j.fields.length === 4 && typeof j.fields[0].offset === "number");

// --- 6. receipts: fnv1a-64, deterministic, differs on change ----------------
const r1 = receipt(types[0], "zig");
const r2 = receipt(types[0], "zig");
const r3 = receipt(parseSDL(`type CellState { seq: Int! @join(max) @primary\n weight: Float! @join(max)\n fingerprint: Int! @join(xor)\n note: String\n }`)[0], "zig");
check("receipt deterministic", r1 === r2);
check("same schema same receipt across whitespace", r1 === r3);
const r4 = receipt(parseSDL("type CellState { seq: Int! @join(max) @primary }")[0], "zig");
check("different schema different receipt", r4 !== r1);
check("receipt is 16 hex chars", /^[0-9a-f]{16}$/.test(r1));

// --- 7. honesty pins: the slop we refuse to generate ------------------------
// 7a. no inline-asm "crypto" — ever
check("no inline assembly in any emitter", !/__asm__|asm volatile/.test(zig + c));
// 7b. xor-join fields must not be described as content merges
check("xor join labeled fingerprint-class", /fingerprint/i.test(zig));
// 7c. unbounded String fields are varlen and cannot live in fixed layout
check("String field flagged varlen in layout", f.note.varlen === true);

// --- 8. axioms documented: join strategies we trust -------------------------
check("layout lists trusted axioms", Array.isArray(L.axioms) && L.axioms.includes("commutativity") && L.axioms.includes("idempotence") && L.axioms.includes("associativity"));

// --- 9. type-level: second type in one schema, @join(lww) via seq -----------
const two = parseSDL("type A { s: Int! @join(max) }\ntype B { tag: Int! @join(lww) }");
check("multi-type schema parses", two.length === 2);
check("lww is a known join", two[1].fields[0].join === "lww");

// --- 10. rust emitter: #[repr(C)], honest joins, arena varlen refs ----------
const tryEmit = (t, lang) => { try { return emit(t, lang); } catch (e) { return `/* EMIT FAILED: ${e.message} */`; } };
const rust = tryEmit(types[0], "rust");
check("rust emits #[repr(C)] struct", /#\[repr\(C\)\][\s\S]*?pub struct CellState\b/.test(rust));
check("rust emits fingerprint_fast(&self) -> u64", /fn fingerprint_fast\(&self\) -> u64/.test(rust));
check("rust fingerprint is fxhash-style non-crypto", /fxhash/i.test(rust) && /rotate_left\(5\)/.test(rust));
check("rust fingerprint documented receipt-grade, NOT security boundary", /receipt-grade integrity, NOT a security boundary/.test(rust));
check("rust does NOT claim cryptographic anything", !/cryptographic/i.test(rust));
check("rust join uses Ord::max on seq", /Ord::max\(self\.seq, other\.seq\)/.test(rust));
check("rust join uses ^ for xor fingerprint", /self\.fingerprint \^ other\.fingerprint/.test(rust));
check("rust xor arm carries FINGERPRINT CLASS ONLY doc", /FINGERPRINT CLASS ONLY[^\n]*flag, never content/.test(rust));
check("rust field comments state repr(C) offsets/aligns", /offset 0, size 8, align 8/.test(rust));
check("rust varlen String becomes StrRef (u32 offset, u32 len)", /pub struct StrRef\s*\{[\s\S]*?pub offset: u32,[\s\S]*?pub len: u32/.test(rust));
check("rust StrRef documented as arena ref, never inline", /external blob arena[\s\S]*?never inline/i.test(rust));
check("no inline asm in rust emitter", !/__asm__|asm!|asm volatile/.test(rust));

// --- 11. rust lww: tie-break on the @primary field --------------------------
const lwwType = parseSDL("type LwwRec {\n rev: Int! @primary\n tag: Int! @join(lww)\n }")[0];
const rustLww = tryEmit(lwwType, "rust");
check("rust lww compares on @primary field", /if self\.rev >= other\.rev \{ self\.tag \} else \{ other\.tag \}/.test(rustLww));
check("rust lww arm documents tie-break field", /tie-broken by @primary/.test(rustLww));

// --- 12. @packed(bits=N): LSB-first u64 words in layout() -------------------
const packedSDL = `type PackedRec {
  a: Int! @packed(bits=48)
  b: Int! @packed(bits=32)
  c: Int! @packed(bits=4)
  tail: Float!
}`;
const packedType = parseSDL(packedSDL)[0];
check("packed bits=N parsed", packedType.fields[0].packed === 48);
check("unpacked field has no bits", packedType.fields[3].packed === null);
const PL = layout(packedType);
const pf = Object.fromEntries(PL.fields.map(x => [x.name, x]));
check("layout reports bit_offset/bit_width", pf.a.bit_offset === 0 && pf.a.bit_width === 48);
check("LSB-first: consecutive packed fields stack", pf.b.bit_offset === 0 && pf.c.bit_offset === 32);
check("packed run spills into next u64 word", pf.b.offset === pf.a.offset + 8);
check("fields in same word share its byte offset", pf.b.offset === pf.c.offset);
check("packed storage is u64 words", pf.a.ctype === "u64" && pf.a.size === 8);
check("unpacked after packed run: next natural-aligned offset", pf.tail.offset === pf.a.offset + 16 && pf.tail.offset % 4 === 0);
check("struct size rounds to max align", PL.size === 24);

// --- 13. packed get/set masks rendered in zig/c/rust ------------------------
const pzig = tryEmit(packedType, "zig");
check("zig emits u64 word storage", /word0: u64/.test(pzig) && /word1: u64/.test(pzig));
check("zig getter mask LSB-first", /get_a[\s\S]*?\(self\.word0 >> 0\) & 0xffffffffffff/.test(pzig));
check("zig setter clears keep-mask then ors", /set_c[\s\S]*?\(self\.word1 & 0xfffffff0ffffffff\) \| \(\(v & 0xf\) << 32\)/.test(pzig));
const pc = tryEmit(packedType, "c");
check("c emits u64 word storage", /uint64_t word0/.test(pc));
check("c getter renders mask", /PackedRec_get_a[\s\S]*?>> 0\) & 0xffffffffffffull/.test(pc));
check("c setter renders keep-mask", /PackedRec_set_c[\s\S]*?& 0xfffffff0ffffffffull/.test(pc));
const prust = tryEmit(packedType, "rust");
check("rust emits u64 word storage", /pub word0: u64/.test(prust));
check("rust getter renders mask", /fn get_a\(&self\) -> u64[\s\S]*?\(self\.word0 >> 0\) & 0xffffffffffff/.test(prust));
check("rust setter renders keep-mask", /fn set_c\(&mut self, v: u64\)[\s\S]*?\(self\.word1 & 0xfffffff0ffffffff\) \| \(\(v & 0xf\) << 32\)/.test(prust));

// --- 14. receipt parity: one canonical layout hash across langs -------------
check("receipt rust == zig for plain schema", receipt(types[0], "rust") === receipt(types[0], "zig"));
check("receipt parity holds for packed schema across all emitters", receipt(packedType, "zig") === receipt(packedType, "rust") && receipt(packedType, "rust") === receipt(packedType, "c"));
const bannerZ = /receipt ([0-9a-f]{16})/.exec(tryEmit(types[0], "zig"))[1];
const bannerR = (/receipt ([0-9a-f]{16})/.exec(tryEmit(types[0], "rust")) || [])[1];
check("emitters embed identical receipt in banner", bannerZ === bannerR && bannerZ === receipt(types[0], "zig"));

console.log(`\n${n - bad}/${n} checks green`);
process.exit(bad ? 1 : 0);
