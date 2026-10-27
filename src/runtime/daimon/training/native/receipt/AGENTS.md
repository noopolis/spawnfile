# Native launch receipts

Owns versioned preparation receipts, exact candidate/config identity and fresh
mount projection validation. The caller compiles and prepares; this module never
rewrites native config or decides project policy. Keep evaluator roots excluded,
private controls under /run and credential ingress separate from writable data.
Verify malformed receipts and actual filesystem effects with adjacent tests.

`artifacts.ts` derives where one trial's private control artifacts live: the
control root for Codex, and a per-trial directory inside it for Grok, whose slot
control root is fixed, shared between trials and already holds Daimon's own store.

launch.v1 stays Codex-only and still parses. launch.v2 selects `codex` (at most one
ingress credential) or `grok` (no credentials, broker slot inputs, five required
evaluator roots, exactly one projection — the slot runtime home). `grok.ts` mirrors Daimon's projection/slot receipt shapes and
canonical digest for re-binding without Daimon; Daimon remains the resolver and verifier.
Projection v3 requires an explicit worker config variant, its independent
slot/model/effort digest pin and exact per-slot clock metadata for the clocked variant.
`grok-clocked-pins.ts` records all eight slots from Daimon's public config renderer;
the optional-peer parity test exercises every slot/model/effort combination.
A Grok launch with taskClock requires the clocked variant before any subject starts.

Both versions accept optional `delivery: direct | transport` (absence remains
direct without adding a default to old receipts) and `taskClock: { origin,
anchorEpochMs, libfaketimePath }`. The caller supplies one safe-integer real launch
anchor shared with its transport. `task-clock.ts` preserves that anchor inside the
running worker before host creation, refusing anchors more than 1000 ms ahead of
real time or older than the worker's trial timeout window. Never mint another
anchor, add preload to worker launch arguments or
derive FAKETIME here: Daimon owns child clock gating and engine clock removal.
Keep the origin/anchor evidence; the library path is installation input only.

The launch engine vocabulary consumes the same pinned declaration published by the runtime registry. Engine-specific launch variants retain their own required fields and refuse unimplemented execution paths.

Codex launches carry exactly one `subscription` projection and one bootstrap credential. Their private persistent sources are outside trial homes and evaluator roots. Standalone Docker uses actual host sources with the fixed native mount targets; child execution uses canonical already-mounted paths. This account projection survives trial cleanup.
