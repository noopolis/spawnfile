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
Decision receipts carry originating attempt requestId; it survives copies and
repairs. Optionality accepts legacy captures, not permission to omit new IDs.

EvaluationResult retains paid failure receipts as decisionAccounting even when
no GradeResult exists. Error status and receipt ownership survive replay/repair.

Evaluation routes and results also carry typed atomic runtimes/atomicGrading.
EvaluationResult.atomicFailure identifies acceptance-gate infrastructure errors
that stopped inference before an atomic grade existed.
Decision requests include true/false Noul separately from yes/no legacy questions;
unknown usage is distinct from conservative admission estimates.

DecisionResult.failureCause identifies spend-cap admission and request-rejected infrastructure refusals independently of missing-content prose. Callers preserve it rather than applying a behavioral missing policy.

Dataset lineage names evidence ancestors across splits; authored validation paths remain dataset-relative controls.

`AtomicFeedback` is the optimizer-safe wire projection shared with the atomic
grader: failure/omission counts and template, unit text, nullable probability.
Keep it structurally compatible with the grader's public feedback type; extraction,
raw checks, identities and transport receipts never belong in this contract.
