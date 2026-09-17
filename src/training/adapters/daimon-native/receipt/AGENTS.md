# Native launch receipts

Owns versioned preparation receipts, exact candidate/config identity and fresh
mount projection validation. The caller compiles and prepares; this module never
rewrites native config or decides project policy. Keep evaluator roots excluded,
private controls under /run and credential ingress separate from writable data.
Verify malformed receipts and actual filesystem effects with adjacent tests.

launch.v1 stays Codex-only and still parses. launch.v2 selects `codex` (at most one
ingress credential) or `grok` (no credentials, broker slot inputs, five required
evaluator roots). `grok.ts` mirrors Daimon's projection/slot receipt shapes and
canonical digest for re-binding without Daimon; Daimon remains the resolver and verifier.
