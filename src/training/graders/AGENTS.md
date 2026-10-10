# Grader core

Owns runtime-neutral grader parsing, instance projections, label consensus,
calibration and aggregation. Public seam: index.ts and focused child barrels.
Never import inference, adapters, experiments, optimization or CLI code.
Provider invocation and deep Paideia check validation belong to callers.

Run targeted Vitest, ESLint and TypeScript checks. Preserve all declared weights,
fail closed on missing evidence and pin calibration identities. Tests live beside
source; verify 90% per-file coverage and negative guards with real mutations.
