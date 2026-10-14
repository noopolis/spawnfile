# Evaluation Engine

Owns evaluator registration, execution and the shared result contract.

- Compose logic/, mechanical/, semantic/ and embedding/ through public interfaces.
  Categories are organizational, not a closed list of possible evaluators.
- Trusted custom TypeScript evaluators register schemas and capabilities; YAML
  cannot embed executable code. Untrusted plugins need an explicit boundary.
- Keep immutable evidence, cancellation and budgets available to evaluators.
- Separate subject event relationships from evaluator execution dependencies.
- Apply the [initial live policy](../../docs/live-evaluation.md). Verdict and temporal
  finality are distinct. Only explicitly selected decisive mechanical failures may
  stop work; validate eligibility across nested rules and evaluator dependencies.
  Semantic/embedding observations stay advisory while terminal quality gates remain.
- Pass, fail, unknown, error and skipped remain distinguishable with evidence.
  Never hide incomplete coverage or let scores compensate mandatory gates.
- Test malformed evaluator output, unknown registrations, cancellation and versioned
  rescoring. A rescore cannot invoke the subject or count as another native trial.

Stage checks run concurrently only when every evaluator in the check opts in with
`concurrency` (it never reads sibling results) and no node references another result.
The bound is `checkConcurrency` (default 2, max 8; 1 allows one slotted check at a time). Checks
start in declaration order, checks sharing a declared resource (a judge cache, an
embedding provider) never overlap, and results, scores and measurements commit in
declaration order, so a plan is identical to sequential evaluation apart from random
call IDs. Protected judge.attempt audits are still awaited before acceptance, so they
persist in arrival order across concurrent judges; each judge's own attempts stay
ordered. A bounded slot or shared resource passes to the next check only after its
holder's ordered commit outcome is known, so no run starts after a known commit
failure; started work settles first. Mechanical-only checks spend no inference and
take no slot; the exemption is recorded when createEvaluationRegistry builds its frozen
built-ins, so custom evaluators always take a slot whatever kind they declare. A test enforces that opted-in builtins never read results or scores.
Cancellation leaves checks that already finished with their own outcome.

The grader builtin consumes host-injected routes keyed by resolved grader path and
checks their definition/calibration digests against the resolved plan. Missing trial
context remains missing. The engine evaluates nested grader gates on the same
snapshot and supplies `gradedArtifact` to project evaluators. Grader results retain
coverage, per-question results, identity and actual judge calls. Shared backend
resources and nested gate resources serialize; gates without concurrency opt-in
make the enclosing grader sequential. No inference or CLI imports belong here.
Failed mechanical gates stop grader inference immediately, retaining gate evidence
and calls; unknown gates continue grading with an unknown aggregate status.

Atomic routes bind only accepted artifacts and declared observed context. Freeze
the neutral route policy; match definition/template digests before extraction.
Failed acceptance gates stop inference; atomicGrading retains receipts and probabilities.
Acceptance gates with nested errors emit atomicFailure with their gate ID and no score before
extraction. Preserve gate children and actual judge calls; never fabricate a grade.

Atomic admission errors retain the spend-cap reason and omit the evaluator score; aggregation diagnostics are not measured behavioral scores.

Isolated grader backends retain billing capabilities so paid receipts survive
the builtin route. Named passed references and selective repair preserve receipt
requestId even when the enclosing check or measurement identity changes.

The grader builtin catches DecisionAccountingError at its owning boundary and
returns an error with allowlisted decisionAccounting, gate children and their calls.
Never turn paid failure into a grade or discard receipts in the generic error path.
