# quilt-blueprint

**The blueprint-to-metal compiler.** GraphQL-shaped schema goes in; byte-exact
fixed-offset memory layouts and monotonic join operators come out. No runtime.
Receipts always.

Born from a verdict. An agent pitched the fleet a full "已落地" stack — GraphQL
as compile-time blueprint, semilattice CRDTs, OTOC chaos floors, Zig/C/CUDA/WGSL
all the way down. Some of it was right. Some of it was costume jewelry: inline
assembly pretending to be ChaCha20 (it was `vpxor` + `vptest` — a compare, not a
cipher), a `memcpy` inside a module named "zero-copy," Wyhash labeled
"cryptographic," Zig that wouldn't compile (`nil` isn't Zig), and an MSS chaos
bound quoted for a classical system with no temperature defined.

This repo keeps the shape and files off the slop. Every emitter output is
pinned by tests that assert what we *refuse* to generate.

```
node tests/test_blueprint.mjs    # 32/32 checks green
```

## The contract

```graphql
type CellState {
  seq: Int! @join(max) @primary     # semilattice-safe: idempotent, commutative, associative
  weight: Float! @join(max)         # monotonic inflation
  fingerprint: Int! @join(xor)      # FINGERPRINT CLASS ONLY — flag, never content
  note: String                      # varlen: lives outside the fixed block
}
```

- `blueprint.mjs parseSDL` — SDL-subset parser (types, scalars, `@join(...)`, `@primary`, `@packed`)
- `layout(type)` — natural-alignment offset table; Strings flagged varlen; axioms attached
- `emit(type, "zig" | "c" | "json")` — struct + honest `join(⊔)` per emitter
- `receipt(type, lang)` — fnv1a-64 over the canonical layout (fleet receipt idiom); identical schemas hash identically across whitespace

Join strategies we trust: `max`, `lww` (tie-broken by the `@primary` field).
`xor` exists but is stamped *fingerprint-class* in every emitter — it destroys
order statistics and must never merge content.

## What no emitter may do (honesty pins, enforced in tests)

1. No inline-assembly "crypto." Ever.
2. No hash may be labeled cryptographic unless it is one. Wyhash is a fasthash.
3. No varlen field may silently occupy fixed offset space.
4. Every layout carries its axioms: idempotence, commutativity, associativity.

## Where this sits in the stack

This is Layer 1 of the blueprint→metal pipeline. The full-stack deep-research
document — what to build next, what to verify before building, and which parts
of the pitch were theater — lives at [`docs/ADSP-DEEP-RESEARCH.md`](docs/ADSP-DEEP-RESEARCH.md).

---

*The blueprint is yours; the metal is ours; the receipt proves which is which.*
