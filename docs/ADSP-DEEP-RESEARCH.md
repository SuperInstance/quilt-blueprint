# ADSP / CLM Deep-Research Document

*Status: STORED FOR DEEP RESEARCH — do not build past Phase 0 until the
verification questions below have receipts. Source: an external agent's full
architecture pitch (2026-09-27), fleet-reviewed and distilled by kimi1.*

---

## 1. The pitch in one paragraph

A private, self-learning inference node that runs in a CPU-only GitHub
Codespace. A frozen low-bit (ternary/2-bit) Qwen3-8B backbone acts as a fixed
feature extractor; all learning lives in two 75MB dual-encoder projection
heads (W_state, W_action: 4096→512). Decisions are cosine-similarity argmax
over cached action vectors — no autoregressive decoding. Trajectories append
to a flat log; a drift detector triggers background InfoNCE training of the
heads; an async git loop pushes updated heads + trajectories back to the repo
("the codebase grows itself"). Distribution: sparse delta matrices as CRDT
packets over shared-memory rings (same host), UDP/mDNS (LAN), RFCOMM
(Bluetooth), gRPC (cloud). Adaptive epsilon throttling keeps narrow links
unsaturated.

## 2. What survives contact with the fleet (KEEP)

1. **Schema-only GraphQL as compile-time blueprint.** No runtime GraphQL
   engine. This is *already* our quilt doctrine (5-opcode kernel, receipts as
   cells). Layer 1 of this stack is now real: `SuperInstance/quilt-blueprint`.
2. **Semilattice CRDT state.** Idempotence/commutativity/associativity as
   enforced axioms — matches FleetVectorIndex/MeshVectorGossip work. The join
   operators in the pitch (max, lww-with-vector-clock) are sound *if* confined
   to scalars; see §4 risks.
3. **Frozen base + thin trainable heads.** Standard and sane (LoRA-adjacent).
   "Natural semantic regularization" claim (frozen base can't catastrophically
   forget) is genuinely true.
4. **Sparse delta serialization.** Coordinate-packed (row,col,float) triples
   are the right shape for low-bandwidth sync; packed-binary over Protobuf is
   reasonable.
5. **The 3-phase build order** (env → two-way index → git loop) is the right
   dependency order.

## 3. What is theater (REJECT, with receipts from the pitch itself)

| Claim in pitch | Why it's wrong |
|---|---|
| "ChaCha20/Poly1305 inline assembly" | The asm shown is `vmovdqu/vpxor/vptest` — a compare-XOR, not a cipher. No rounds, no MAC. "Verifies signatures in a single cycle" is false advertising. |
| "Zero-copy" si_wgpu.c | Contains `memcpy(wgpu_mapped_range, raw_file_memory_address, size)` — that IS the copy. Also wgpu-native API misuse: C++ lambda syntax in a `.c` file won't compile; requestAdapter/Device are async. |
| `cryptographic_checksum = Wyhash` | Wyhash is a fast non-crypto hash. Mislabeling is exactly the lie our honesty pins exist to catch. |
| "u256 vector_hash XOR as commutative merge" | XOR of hashes destroys order statistics — it's a parity flag, not a state merge. Fine as fingerprint; wrong as content. |
| MSS bound `λ_L ≤ 2πk_BT/ħ` | Quoted for a classical CRUD system with no Hamiltonian and no temperature. Metaphor, not mechanism. We have *actual* OTOC floor receipts from quilt-doctor's SPECTRAL lens if we want measured scrambling. |
| "Tarski bypasses the halting problem" | Word salad. Bounded join-semilattice termination is trivial and provable without halting cosplay. |
| Zig sample code | `nil` isn't Zig (it's `null`); UDP socket typed as `net.StreamServer`; the mmap flags are wrong. Decorate, not build. |
| "9x faster than autoregressive" | Plausible for *selection over cached candidates* (single forward pass + matvec) but unstated what baseline/CPU. Needs measurement, not assertion. |

## 4. Risks to resolve BEFORE building

1. **Embedding cost model.** Qwen3-8B 2-bit ≈ 2–3GB RAM. Feasible in a 4-core
   Codespace (8–16GB), but *per-request* embedding of N actions × one forward
   pass each is NOT free. The pitch's "9x" only holds if action embeddings are
   cached and only the state is encoded. Verify: measure llama.cpp embedding
   latency for 4096-dim Qwen3-8B on shared vCPU before any Phase-2 code.
2. **CRDT correctness for learned weights.** Sparse *additive* deltas commute;
   InfoNCE *gradient* updates do not merge conflict-free across nodes. The
   pitch silently switches from "merge deltas" (sound) to "shared learning
   quilt" (unsound as CRDT). Real answer: treat heads as single-writer per
   node and gossip *trajectories*; merge = retrain, or use a convergent
   optimizer (e.g., quorum-averaged delta with vector-clock ordering).
3. **Concurrent Codespace pushes.** The sync script's `merge -X union` on
   JSONL trajectories is fine; `git pull --rebase` with binary .npy heads from
   N nodes is a corruption machine. Needs LFS or a small custom object store
   for heads. (stone-v1 forward-format is a candidate substrate.)
4. **Auth model.** Bearer GITHUB_TOKEN equals the Codespace's own token —
   any process in the container can call the API, so the "auth" boundary is
   theater inside the trust domain. Fine for private dev, must be re-stated
   honestly (receipt-grade boundary, not security).
5. **Drift detector math.** The Lyapunov proof in the pitch actually
   demonstrates stability of the *queue*, not the *learner*. Training on
   self-labeled success (the trajectory log has no external reward) will
   drift toward whatever the argmax already picks — a self-confirming loop.
   Needs an external verifier hook (jev scores are the obvious fleet answer).

## 5. Build order (revised by the verdict)

- **Phase 0 (done):** `quilt-blueprint` — schema → fixed-offset layouts +
  honest joins. The Layer-1 transpiler the pitch gestured at.
- **Phase 1 — `clm-node` env:** devcontainer + llama.cpp build + FastAPI
  gateway with honest auth labeling. No learning. Deliverable: `/health`
  receipt + one measured embedding latency number (risk #1).
- **Phase 2 — selection engine:** frozen embedder + cached action matrix +
  cosine argmax + trajectory log. FAIL-first harness like every fleet repo.
  Deliverable: measured p50/p95 latency + accuracy vs the heuristic SysOne
  baselines we already ship in quilt-tools.
- **Phase 3 — learning loop:** InfoNCE trainer on projection heads ONLY after
  an external reward source (jev) is wired. Git sync via stone-v1-format
  receipts, not raw .npy rebase.
- **Phase 4 — distribution:** CRDT trajectory gossip (sound) before any
  weight gossip (unsound). qthe's ternary hyper-embeddings are the natural
  encoding partner — explore qthe first.

## 6. Verification questions (need receipts before Phase 1 code)

1. Qwen3-8B embedding latency on 2 vCPU, 2-bit quant: measure.
2. 75MB heads in L3: is the "cache pin" real on Codespace vCPUs? (L3 is
   per-CCX/shared — measure, don't assume.)
3. Ternary zeroing claim: what fraction of Qwen3-2bit weights are exactly 0,
   and does skipping them measurably speed the projection matvec?
4. CRDT: prove additive-delta merge ≡ retrain merge on a 2-node simulation
   with forced reordering. If they diverge, weight gossip is dead; document it.
5. Does jev scoring correlate with downstream task success well enough to
   serve as the reward signal? (pong-quilt/quilt-doctor data exists.)

## 7. Naming

Casey asked for a memorable name for the streamlined tool version of this.
Candidates: **tern** (ternary + the seabird — fleet aesthetic, short, a node
that fishes actions from a cached sea), **keel-cache**, **clm-node**. Fleet
vote leans **tern**: "the bird that dives without splashing — selection, not
generation."

## 8. Related fleet repos to iterate with (from the pitch + edge-watch)

- `SuperInstance/qthe` — QTHE ternary hyper-embeddings + A2UI live mirror;
  natural encoder partner. **Scout first.**
- `SuperInstance/quilt-tools` — the 10 heuristic tools are the SysOne
  baseline the CLM selector must beat to earn its keep.
- `SuperInstance/quilt-stone` — receipt format for the git-sync loop.
- `SuperInstance/jeviter` + `quilt-doctor` — external reward + diagnostics.
- `SuperInstance/git-agent` — quilt_emit WAL for trajectory receipts.

*Stored 2026-09-27 by kimi1. Deep-research before build. Receipts > adjectives.*
