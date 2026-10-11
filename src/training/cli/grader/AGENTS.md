# Grader commands

Owns local grader validation, teacher labeling, raw-score caching and calibration
artifact/report orchestration and standalone grading. Public seam: index.ts. Consume neutral grader rules
and decision providers through public barrels; do not duplicate scoring semantics.
Never publish, download models, use API fallback, or place credentials in artifacts.
Exclusions apply before inference and splitting: dataset groups/IDs match lineages,
while examples match both dataset and ID. Cache identities include question, projection,
backend and versioned prompt. Tests inject providers/fetch and keep artifacts local.
Grade JSON inputs and explicit JSON/text context files through the shared runtime;
do not invent trial snapshots for mechanical gates. Grade exit zero requires pass.
Run adjacent tests plus grader/provider suites, ESLint, typecheck and per-file coverage.

Labeling writes only separate golden files, atomically after each completed output.
Resume retains completed votes and original call receipts, including partial groups;
compact receipt references must remain readable by stale checks and cost estimates.

Whole-command cancellation reaches identity probes, scoring and teacher calls;
label/calibrate/grade accept the existing bounded --timeout-ms control.
