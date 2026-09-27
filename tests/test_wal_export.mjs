// tests/test_wal_export.mjs — FAIL-first pins for the fleet-WAL receipt export.
// Run: node tests/test_wal_export.mjs   (exit 0 = all green)
//
// The exporter re-anchors blueprint compile receipts into the five-opcode
// quilt WAL (canonical producer SuperInstance/git-agent PR #1 quilt_emit;
// exporter pattern SuperInstance/pong-quilt R36 PR #46). Cross-tool law:
// the exported chain must verify through quilt_doctor/substrate.py's OWN
// QuiltSubstrate.verify() — the doctor is the reader, never a JS mock.
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fnv1a64utf8, canonical, walLine, verifyWal, exportWal } from "../tools/wal-export.mjs";

let n = 0, bad = 0, skipped = 0;
const check = (name, cond) => { n++; if (!cond) { bad++; console.log(`not ok — ${name}`); } else console.log(`ok — ${name}`); };
const skip = (name, why) => { skipped++; console.log(`ok — ${name} # SKIP ${why}`); };

const sdl = `
type CellState {
  seq: Int! @join(max) @primary
  weight: Float! @join(max)
  fingerprint: Int! @join(xor)
  note: String
}
`;

// --- 1. fnv1a-64 byte form matches the python substrate vectors ------------
check("fnv1a64utf8 matches python fnv1a vector", fnv1a64utf8('{"a":1,"b":"x"}') === "cfcc937b86ef6c1d");
check("walLine hash matches python canonical-dumps vector",
  walLine("BIND", "blueprint/session", { tool: "quilt-blueprint" }, 0, "0".repeat(16)).hash === "97c985085606d11a");

// --- 2. canonical form: sorted keys, no whitespace --------------------------
check("canonical sorts keys", canonical({ b: 1, a: 2 }) === '{"a":2,"b":1}');
check("canonical nests", canonical({ z: [{ y: 1, x: 2 }] }) === '{"z":[{"x":2,"y":1}]}');

// --- 3. export shape: BIND genesis, LINK per receipt, VIEW summary ---------
const wal = exportWal(sdl);
check("genesis prev is 0x16 zeros", wal[0].prev_hash === "0".repeat(16));
check("first line is BIND", wal[0].op === "BIND" && wal[0].cell === "blueprint/session");
check("last line is VIEW summary", wal[wal.length - 1].op === "VIEW" && wal[wal.length - 1].cell === "blueprint/summary");
check("one LINK per type x lang (1 type x 3 langs)", wal.filter(l => l.op === "LINK").length === 3);
check("LINKs carry the emitter receipts",
  wal.filter(l => l.op === "LINK").every(l => /^[0-9a-f]{16}$/.test(l.args.receipt)));
check("BIND names the canonical producer",
  wal[0].args.canonical_producer.includes("git-agent") && wal[0].args.canonical_producer.includes("quilt_emit"));

// --- 4. determinism: same schema, same WAL bytes ---------------------------
check("export is byte-deterministic", canonical(exportWal(sdl)) === canonical(wal));

// --- 5. local verify: clean chain ok; tamper named at exact seq ------------
check("clean chain verifies ok", verifyWal(wal).ok === true);
const tampered = JSON.parse(canonical(wal));
tampered[2].args.receipt = "0".repeat(16);
const tv = verifyWal(tampered);
check("content tamper caught as hash_mismatch at seq 2",
  !tv.ok && tv.divergences.some(d => d.seq === 2 && d.why === "hash_mismatch"));
const spliced = JSON.parse(canonical(wal));
spliced[2].prev_hash = "f".repeat(16);
const sv = verifyWal(spliced);
check("chain splice caught as chain_break at seq 2",
  !sv.ok && sv.divergences.some(d => d.seq === 2 && d.why === "chain_break"));

// --- 6. citation pin: the exporter names its sources in-repo ---------------
const src = readFileSync(new URL("../tools/wal-export.mjs", import.meta.url), "utf8");
check("exporter cites git-agent quilt_emit by name", /git-agent.*quilt_emit/.test(src));
check("exporter cites the pong-quilt R36 exporter pattern by name", /pong-quilt.*R36/.test(src));

// --- 7. LIVE cross-tool receipt: the doctor's OWN verify() over our bytes --
// (abstain-by-skip when the doctor checkout is absent — never fake green)
const doctorPath = process.env.QUILT_DOCTOR_PATH || "/tmp/quilt-doctor";
const substrate = doctorPath + "/quilt_doctor/substrate.py";
if (!existsSync(substrate)) {
  skip("quilt-doctor verify() over exported JSONL", `doctor checkout absent (${doctorPath})`);
  skip("quilt-doctor catches tampered export at exact seq", `doctor checkout absent (${doctorPath})`);
} else {
  const schemaPath = "/tmp/qb-wal-test.graphql";
  const out = "/tmp/qb-wal-test.jsonl";
  writeFileSync(schemaPath, sdl);
  execFileSync("node", [new URL("../tools/wal-export.mjs", import.meta.url).pathname, schemaPath, "-o", out], { stdio: "inherit" });
  const doctorVerify = (path) => {
    const py = [
      "import json, sys",
      `sys.path.insert(0, ${JSON.stringify(doctorPath)})`,
      "from quilt_doctor.substrate import QuiltSubstrate",
      `q = QuiltSubstrate(${JSON.stringify(path)})`,
      "print(json.dumps(q.verify()))",
    ].join("\n");
    return JSON.parse(execFileSync("python3", ["-c", py], { encoding: "utf8" }));
  };
  const res = doctorVerify(out);
  check("quilt-doctor verify() accepts the exported chain", res.ok === true);
  // tamper one LINK receipt post-hash; doctor must name hash_mismatch at that seq
  const lines = readFileSync(out, "utf8").trim().split("\n").map(JSON.parse);
  lines[2].args.receipt = "0".repeat(16);
  writeFileSync(out, lines.map(l => canonical(l)).join("\n") + "\n");
  const tres = doctorVerify(out);
  check("quilt-doctor catches tampered export at exact seq",
    tres.ok === false && tres.divergences.some(d => d.seq === 2 && d.why === "hash_mismatch"));
}

console.log(`\n${n - bad}/${n} checks green${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(bad ? 1 : 0);
