// tools/wal-export.mjs — re-anchor blueprint compile receipts into the fleet
// five-opcode quilt WAL (BIND/LINK/VIEW, fnv1a-64 hash chain, genesis prev 0×16).
//
// Canonical producer of the spine: SuperInstance/git-agent PR #1 quilt_emit.
// Exporter pattern: SuperInstance/pong-quilt R36 wal-export (PR #46) — the
// exporter lives in the CONSUMER repo; verification runs through the reader
// (quilt_doctor/substrate.py QuiltSubstrate.verify()).
//
// Usage:
//   node tools/wal-export.mjs schema.graphql [-o receipts.wal.jsonl]
// Prints the WAL lines and the local verify verdict (tamper-evident at seq).

import { readFileSync, writeFileSync } from "node:fs";
import { parseSDL, layout, emit, receipt } from "../blueprint.mjs";

// fnv1a-64 over UTF-8 BYTES — matches quilt_doctor/substrate.py fnv1a exactly
// (blueprint.mjs's own fnv1a64 walks UTF-16 code units; identical for ASCII,
// divergent for non-ASCII, so the cross-tool chain uses the byte form).
export function fnv1a64utf8(str) {
  const h0 = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  let h = h0;
  for (const b of new TextEncoder().encode(str)) {
    h = ((h ^ BigInt(b)) * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

// canonical JSON: sorted keys, no whitespace — matches python
// json.dumps(d, sort_keys=True, separators=(",", ":"))
export function canonical(d) {
  if (d === null || typeof d !== "object") return JSON.stringify(d);
  if (Array.isArray(d)) return "[" + d.map(canonical).join(",") + "]";
  return "{" + Object.keys(d).sort().map(k => JSON.stringify(k) + ":" + canonical(d[k])).join(",") + "}";
}

export function walLine(op, cell, args, seq, prevHash) {
  const body = { op, cell, args, seq, prev_hash: prevHash };
  return { ...body, hash: fnv1a64utf8(canonical(body)) };
}

// verify: recompute every hash + chain link; returns {ok, divergences:[{seq,why}]}
export function verifyWal(lines) {
  const divergences = [];
  let prev = "0".repeat(16);
  lines.forEach((line, i) => {
    const { hash, ...body } = line;
    if (hash !== fnv1a64utf8(canonical(body))) divergences.push({ seq: i, why: "hash_mismatch" });
    if (line.prev_hash !== prev) divergences.push({ seq: i, why: "chain_break" });
    if (line.seq !== i) divergences.push({ seq: i, why: "seq_gap" });
    prev = line.hash;
  });
  return { ok: divergences.length === 0, divergences };
}

// exportWal: compile the SDL and re-anchor every emitter receipt into the WAL.
export function exportWal(sdl) {
  const types = parseSDL(sdl);
  const lines = [];
  let prev = "0".repeat(16);
  const push = (op, cell, args) => {
    const line = walLine(op, cell, args, lines.length, prev);
    lines.push(line);
    prev = line.hash;
  };
  push("BIND", "blueprint/session", {
    tool: "quilt-blueprint",
    spine: "five-opcode quilt WAL (BIND/LINK/VIEW)",
    canonical_producer: "SuperInstance/git-agent PR #1 quilt_emit",
    exporter_pattern: "SuperInstance/pong-quilt R36 wal-export (PR #46)",
  });
  const ids = [];
  for (const t of types) {
    for (const lang of ["zig", "c", "json"]) {
      const r = receipt(t, lang);
      ids.push(r);
      push("LINK", "blueprint/receipt", {
        type: t.name, lang, receipt: r, layout_size: layout(t).size,
      });
    }
  }
  push("VIEW", "blueprint/summary", {
    types: types.length, receipts: ids.length, receipt_ids: ids,
  });
  return lines;
}

// CLI
const isMain = process.argv[1] && process.argv[1].endsWith("wal-export.mjs");
if (isMain) {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("-o");
  const positional = args.filter((a, i) => a !== "-o" && i !== outIdx + 1);
  const schemaPath = positional[0];
  if (!schemaPath) {
    console.error("usage: node tools/wal-export.mjs <schema.graphql> [-o out.jsonl]");
    process.exit(2);
  }
  const sdl = readFileSync(schemaPath, "utf8");
  const lines = exportWal(sdl);
  const jsonl = lines.map(l => canonical(l)).join("\n") + "\n";
  if (outIdx >= 0) writeFileSync(args[outIdx + 1], jsonl);
  else process.stdout.write(jsonl);
  const v = verifyWal(lines);
  console.error(`wal-export: ${lines.length} lines, verify ok=${v.ok}` + (v.ok ? "" : ` divergences=${JSON.stringify(v.divergences)}`));
  process.exit(v.ok ? 0 : 1);
}
