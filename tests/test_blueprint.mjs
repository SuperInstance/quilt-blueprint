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

console.log(`\n${n - bad}/${n} checks green`);
process.exit(bad ? 1 : 0);
