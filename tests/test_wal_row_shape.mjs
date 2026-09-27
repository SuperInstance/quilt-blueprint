// tests/test_wal_row_shape.mjs — fleet WAL ROW-SHAPE pin (queue item 3).
// Run: node tests/test_wal_row_shape.mjs   (exit 0 = all green)
//
// The exporter's own verifyWal() can drift in lockstep with walLine() — a
// shared bug would blind both. This pin re-derives the row shape with a
// DELIBERATELY INDEPENDENT reimplementation (own fnv1a, own canonicalizer,
// zero imports from tools/) and enforces the fleet spine shape agreed by the
// three canonical sites:
//   - canonical producer: SuperInstance/git-agent PR #1 quilt_emit
//   - exporter pattern:   SuperInstance/pong-quilt R36 wal-export (PR #46)
//   - canonical reader:   quilt_doctor/substrate.py QuiltSubstrate
// Row law: top-level keys are EXACTLY {args, cell, hash, op, prev_hash, seq};
// op vocabulary is {BIND, LINK, VIEW}; seq is a contiguous integer from 0;
// prev_hash/hash are 16-char lowercase hex; genesis prev is 16 zeros;
// hash = fnv1a-64 over canonical JSON of the body (sorted keys, no spaces),
// canonical JSON matching python json.dumps(sort_keys, separators=(",",":")).
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { exportWal } from "../tools/wal-export.mjs";

let n = 0, bad = 0, skipped = 0;
const check = (name, cond) => { n++; if (!cond) { bad++; console.log(`not ok — ${name}`); } else console.log(`ok — ${name}`); };
const skip = (name, why) => { skipped++; console.log(`ok — ${name} # SKIP ${why}`); };

// --- independent primitives (NOT imported from tools/) ---------------------
const MASK64 = (1n << 64n) - 1n;
function fnvIndep(s) {
  let h = 0xcbf29ce484222325n;
  for (const b of new TextEncoder().encode(s)) h = ((h ^ BigInt(b)) * 0x100000001b3n) & MASK64;
  return h.toString(16).padStart(16, "0");
}
function canonIndep(d) {
  if (d === null || typeof d !== "object") return JSON.stringify(d);
  if (Array.isArray(d)) return "[" + d.map(canonIndep).join(",") + "]";
  return "{" + Object.keys(d).sort().map(k => JSON.stringify(k) + ":" + canonIndep(d[k])).join(",") + "}";
}

const ROW_KEYS = ["args", "cell", "hash", "op", "prev_hash", "seq"]; // exact, sorted
const OPS = new Set(["BIND", "LINK", "VIEW"]);
const HEX16 = /^[0-9a-f]{16}$/;

const sdl = `
type CellState {
  seq: Int! @join(max) @primary
  weight: Float! @join(max)
  fingerprint: Int! @join(xor)
  note: String
}
`;
const rows = exportWal(sdl);

// --- structural pins (independent of verifyWal's code path) -----------------
check("every row has EXACTLY the fleet key set {args,cell,hash,op,prev_hash,seq}",
  rows.every(r => JSON.stringify(Object.keys(r).sort()) === JSON.stringify(ROW_KEYS)));
check("op vocabulary is exactly within {BIND,LINK,VIEW}",
  rows.every(r => OPS.has(r.op)));
check("seq is an integer contiguous from 0",
  rows.every((r, i) => Number.isInteger(r.seq) && r.seq === i));
check("hash and prev_hash are 16-char lowercase hex",
  rows.every(r => HEX16.test(r.hash) && HEX16.test(r.prev_hash)));
check("genesis prev_hash is 16 zeros", rows[0].prev_hash === "0".repeat(16));
check("args is a plain object on every row",
  rows.every(r => typeof r.args === "object" && r.args !== null && !Array.isArray(r.args)));
check("independent fnv1a recompute matches every row hash",
  rows.every(r => { const { hash, ...body } = r; return fnvIndep(canonIndep(body)) === hash; }));
check("independent chain recompute: prev_hash links to previous hash",
  rows.every((r, i) => (i === 0 ? r.prev_hash === "0".repeat(16) : r.prev_hash === rows[i - 1].hash)));

// --- cross-tool parity (LIVE; abstain-by-skip, never fake green) ------------
const doctorPath = process.env.QUILT_DOCTOR_PATH || "/tmp/quilt-doctor";
const substrate = doctorPath + "/quilt_doctor/substrate.py";
if (!existsSync(substrate)) {
  skip("quilt-doctor append() row key set matches the fleet shape", `doctor checkout absent (${doctorPath})`);
  skip("independent verifier accepts a quilt-doctor-produced row", `doctor checkout absent (${doctorPath})`);
} else {
  const walPath = "/tmp/qb-row-shape-doctor.wal";
  writeFileSync(walPath, ""); // fresh chain
  const py = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(doctorPath)})`,
    "from quilt_doctor.substrate import QuiltSubstrate",
    `q = QuiltSubstrate(${JSON.stringify(walPath)})`,
    `r = q.append("BIND", "shape/probe", {"tool": "row-shape-pin"})`,
    "print(json.dumps(r))",
  ].join("\n");
  const doctorRow = JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }));
  check("quilt-doctor append() row key set matches the fleet shape",
    JSON.stringify(Object.keys(doctorRow).sort()) === JSON.stringify(ROW_KEYS));
  const { hash, ...body } = doctorRow;
  const chainOk = fnvIndep(canonIndep(body)) === hash;
  const seqOk = Number.isInteger(doctorRow.seq) && doctorRow.seq === 0;
  const prevOk = doctorRow.prev_hash === "0".repeat(16);
  const opOk = OPS.has(doctorRow.op);
  check("independent verifier accepts a quilt-doctor-produced row",
    chainOk && seqOk && prevOk && opOk);
}

// --- wiring pins (README names this lane and keeps live counts) -------------
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
check("README names the row-shape pin command", /node tests\/test_wal_row_shape\.mjs/.test(readme));
const walOut = execFileSync("node", [new URL("./test_wal_export.mjs", import.meta.url).pathname], { encoding: "utf8" });
const walChecks = (walOut.match(/^ok — /gm) || []).length;
check(`README wal-export check count matches live run (${walChecks})`,
  new RegExp(`test_wal_export\\.mjs\\s+# ${walChecks} checks`).test(readme));

console.log(`\n${n - bad}/${n} checks green${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(bad ? 1 : 0);
