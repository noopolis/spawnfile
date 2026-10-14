# Neutral Contracts

Owns versioned IDs, capabilities, interfaces and shared result schemas.

- No runtime SDKs, provider calls, filesystem access or product-specific corpora.
- Model incomplete observations, unsupported controls and unknown usage explicitly.
- Runtime and inference adapters are different contracts; do not merge them just
  because both can launch a CLI.
- Keep wire compatibility and validation versioned. Split schema families into
  cohesive children when they grow; do not centralize every type in one file.
- Tests should reject malformed, ambiguous and incompatible values while accepting
  the supported public contract. Shared contracts must work without Daimon.

Evaluation contexts may carry injected neutral grader runtimes. Nested gate
execution and the graded artifact are engine-owned capabilities; grader results
retain calibration identity and coverage. Judge calls distinguish local billing
and measured wall time without inventing usage.

Evaluation routes and results also carry typed atomic runtimes/atomicGrading.
Decision requests include true/false Noul separately from yes/no legacy questions;
unknown usage is distinct from conservative admission estimates.

DecisionResult.failureCause identifies spend-cap admission refusal independently of missing-content prose. Callers preserve it rather than applying a behavioral missing policy.
