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
The bound is `checkConcurrency` (default 2, max 8; 1 is strictly sequential). Checks
start in declaration order, checks sharing a declared resource (a judge cache, an
embedding provider) never overlap, and results, scores and measurements commit in
declaration order, so a plan is identical to sequential evaluation apart from random
call IDs. Protected judge.attempt audits are still awaited before acceptance, so they
persist in arrival order across concurrent judges; each judge's own attempts stay
ordered. After a commit failure nothing new starts and started work settles first.
Cancellation leaves checks that already finished with their own outcome.
