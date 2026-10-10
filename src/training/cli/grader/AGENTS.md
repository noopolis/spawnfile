# Grader commands

Owns local grader validation, teacher labeling, raw-score caching and calibration
artifact/report orchestration. Public seam: index.ts. Consume neutral grader rules
and decision providers through public barrels; do not duplicate scoring semantics.
Never publish, download models, use API fallback, or place credentials in artifacts.
Exclusions apply before inference. Cache identities include question, projection,
backend and versioned prompt. Tests inject providers/fetch and keep artifacts local.
Run adjacent tests plus grader/provider suites, ESLint, typecheck and per-file coverage.
