# Native evidence collection

Own bounded evidence-file I/O, schema/identity checks and native ledger projection.
Use index.ts as the public seam; runtime execution and wake scheduling stay in the
parent worker. Never import evaluator or inference implementations.

Wake traces and usage retain their execution attribution. The optional accounting
member persists the cumulative trial ledger, including revisited executions; the
observer emits each execution once. Older frames without accounting retain their
original wake usage semantics. Complete trial usage requires a completed matching
trace and complete non-estimated usage for every execution.

Verify collection, malformed evidence and Grok tests here, plus parent worker and
child multi-wake tests. Keep filesystem bounds and negative identity tests intact.
