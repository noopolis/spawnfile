# Atomic grader commands

Own local decomposition, trap and council-reference orchestration. Public seam:
index.ts. Consume grader decomposition, traps and references through public entry
points; never duplicate their validation or reference semantics. Subscription
providers come from the parent grader seam; no API fallback or credentials in files.

Pin raw input bytes, extraction-only template declarations and selected model policies.
Share the allowlisted view between prompts and checkpoint identity: kinds/descriptions,
applies_to, locations, when field names, context rows/roles. Never expose grading
answers, criteria, traps or instructions. Grading-only edits reuse extraction receipts.
Checkpoint every extraction/audit response and failure receipt
atomically before decoding or cancellation; refuse changed inputs on resume. Extraction and omission auditing use
fresh independent calls. Inference failures are explicit, never empty success.
Verify adjacent tests with injected inference, command routing, cancellation,
stale-resume rejection and filesystem artifacts. Run scoped coverage and parent
CLI/grader checks. Common project rules apply.

Resume valid received responses locally. Retry malformed responses and native
schema failures, retaining typed failure classes, protected diagnostics and earlier
failure accounting. Persist rejected units; downstream commands require explicit
--allow-rejections and count these units as missing checks. Defect traps require
a completed base reference with expected good finals. Request
strict JSON schemas on Codex/Claude extraction and retain dropped field and citation
disagreement diagnostics. Pass kind descriptions to extractors and persist a local
instantiation report with declared location exclusions.

Assign unit IDs by response order (x1… extraction, a1… audit); retain extractor IDs
as labels. Drop audit repeats only when kind, normalized text and resolved occurrence
(location, paragraph, sentence and source character offset) match. Ordered pair
endpoint text and resolved occurrences also enter that identity. Pair extraction
requirements derive only from declared pair reads and enter checkpoint identity. Keep distinct
occurrences and unresolved spans for validation; record duplicate identities in
checkpoints and counts in command summaries. Protocol
changes invalidate earlier extraction checkpoints.

Reference --batch-size defaults to 40 and bounds council questions per output call.
--concurrency bounds output workers independently of concurrent teacher queues.
Report per-teacher retained calls, known/unknown tokens and summed call wall time;
resume preserves original receipts without counting reused calls twice.

runtime.ts integrates the existing extraction/audit command into accepted-artifact
trial grading. Snapshot templates in memory, default the shared extraction deadline
to 900s, preserve checkpoint receipts in atomicGrading, and remove temporary files.
Construct environment-only TypeSafe auth before consuming subscription calls.
Pass authored obligation kinds through prompts, checkpoint identity and extraction/
audit span validation; preserve standalone obligation defaults.
Verify backend-incompatible files fail during dataset resolution and runtime
construction without provider calls; payment errors stay errors under both
missing policies and stop queued decision requests.

A zero/exhausted spend cap is an admission error with null score and typed reason,
not missing content. Verify the real constructed route without dispatching HTTP.
