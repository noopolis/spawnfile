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

Both versions accept optional `delivery: direct | transport` (absence remains
direct without adding a default to old receipts) and `taskClock: { origin,
libfaketimePath }`. `task-clock.ts` validates the public task-clock environment
contract and installs its origin plus a real-time anchor inside the running
worker, before host creation. Never add preload to worker launch arguments or
derive FAKETIME here: Daimon owns child clock gating and engine clock removal.
Keep the origin/anchor evidence; the library path is installation input only.
