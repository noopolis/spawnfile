# Native evidence collection

Own bounded evidence-file I/O, schema/identity checks and native ledger projection.
Use index.ts as the public seam; runtime execution and wake scheduling stay in the
parent worker. Never import evaluator or inference implementations.

Wake traces and usage retain their execution attribution. The optional accounting
member persists the cumulative trial ledger, including revisited executions; the
observer emits each execution once. Older frames without accounting retain their
original wake usage semantics. Complete trial usage requires a completed matching
trace and complete non-estimated usage for every execution. A failed attempt with no usage row keeps trial coverage partial:
Daimon writes no row when an attempt dies before the engine reports usage, which is
not proof it spent nothing.

The complete native member already persists in each numbered wake evidence file
and the terminal diagnostic observation. `modelContexts` records model and policy
metadata; Grok `requests` records token counts and timing, not provider request
bodies. Optional `turnSeals` retains validated broker rows for the selected
execution(s). Its `provider_clock` records observed injected-date rewriting,
including counters and injected/task dates; absence remains absence. This proves
what the broker observed, not provider delivery or model compliance. The inspected
writer omits the protocol-only cleanup diagnostic; never synthesize it.
`seal.ts` mirrors the writer's closed vocabulary, bounds and diagnostic combinations.
Static fixtures run in CI; the installed-peer parity test invokes the real serializer
through a documented test-only import because Daimon's public index omits it.
Do not reconstruct
prompts or a rendered inbox allowance from current availability: Daimon computes
the inbox budget when the tool is read, and its public control API does not expose
that historical tool result.

Verify collection, malformed evidence and Grok tests here, plus parent worker and
child multi-wake tests. Keep filesystem bounds and negative identity tests intact.

Concurrent native JSON reads settle for at most one second, on a monotonic clock,
with 25 ms polling. Retry syntax faults and torn JSONL only; retain size, identity,
symlink and schema refusals. Errors name the file kind without its contents or the
original parser message. Read-only host receipt/activity/availability calls use
this policy too, including child HTTP observation routes; never replay acceptance
or stop mutations. Empty/missing append-only ledgers are valid before the first
row. An existing empty trace/usage/session file expected to contain closed work
settles too; absence cannot erase a previously observed incomplete record. Terminal frames
remain temp-file + fsync + rename + directory fsync with checked readback.
