# Grader core

Owns runtime-neutral grader parsing, instance projections, label consensus,
calibration, aggregation and calibrated runtime orchestration. Public seam:
index.ts and focused child barrels. Runtime decisions use injected contracts.
Never import inference, adapters, experiments, optimization or CLI code.
Provider construction/transports and deep Paideia check validation belong to callers.
Runtime identity checks precede scoring; escalation groups share one call per
projection and overflow remains missing. The neutral admission planner orders only
requested projections by first instance, including forced-teacher requests. Labels never enter grading projections.

Run targeted Vitest, ESLint and TypeScript checks. Preserve all declared weights,
fail closed on missing evidence and pin calibration identities. Tests live beside
source; verify 90% per-file coverage and negative guards with real mutations.
