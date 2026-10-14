# Executable atomic graders

A Spawnfile `training.graders: {quality: training/quality.grader.yaml}` entry
points to a **grader file**, not a check-template file. Paideia consumes the
protected lowered path through its existing `eval: grader` check. This contract implements
atomic grading without golden labels or a calibration file; probabilities are
uncalibrated JEV judgments, not established ground truth.

```yaml
schema: paideia.atomic-grader.v1
id: quality
templates: quality.templates.yaml
extractor:
  provider: codex
  model: your-subscription-model
  effort: high
  deadline_ms: 900000
decision:
  backend: typesafe
  model: jev-1.13.0
  max_spend_usd: 1
  price_per_mtok_usd: 0.042
missing: unknown
aggregation:
  method: gates-times-coverage-times-quality
  critical_pass_at: 0.8
  pass_at: 0.7
  obligation_kinds: [obligation]
  dimensions:
    accuracy: {weight: 3, budget: 2}
    coverage: {weight: 2, budget: 1}
  penalties: {critical: 1, major: 0.5, minor: 0.1}
feedback:
  max_checks: 20
  max_unit_chars: 300
  max_bytes: 8000
  failure_threshold: 0.8
```

`templates` is a contained path relative to the grader file, in the existing
[check-template format](grader-decomposition.md). Every template dimension needs
an aggregation budget; every obligation kind needs a template. Declared obligation
kinds may bind verbatim spans from context named assignment or marked role: assignment;
other kinds and relational endpoints remain bound to output spans. These kinds reach
both extraction/audit prompts and validation, and enter extraction checkpoint identity.
Context declarations
in that file require explicit trial bindings. Unknown fields, duplicate keys,
unsafe paths and invalid backend/model/budget settings fail before native execution.
Extractor effort, when declared, is `low`, `medium`, `high` or `xhigh`; `max`
is rejected. TypeSafe supports 2 Noul, 2–255 Choice and 2–10 Score options.
Dataset resolution and runtime construction reject templates outside these limits.
No key, auth path, provider fallback or organization-specific extraction code belongs
in this public contract. TypeSafe reads `TYPESAFE_API_KEY` from the host environment
only. The versioned model above is illustrative, not a current availability claim.

The host freezes grader/template bytes before subject construction and matches both
digests to dataset resolution. Each invocation binds only the selected **accepted
artifact**, including an optional JSON pointer, plus declared context selectors.
An unaccepted/missing artifact remains unknown; final chat text is never a fallback.
Missing context follows `missing: fail | unknown` with score zero, without extraction.
Generic selectors are `artifact:name`, `artifact:name#/pointer` and `input:files`.
Private integrations own accepted-artifact collection and context/provenance semantics.

The existing subscription Codex extractor makes fresh extraction and omission-audit
calls for each grading invocation. Both phases share one configurable deadline,
default 900 seconds, and caller cancellation. The declared model/effort and strict
JSON schema reach the existing subscription provider; there is no API fallback.
Extraction sees the allowlisted kind/location/condition/pair and context definitions,
never expected answers, criteria, traps or grading instructions. Verbatim span,
citation and relational endpoint validation reuse the decomposition module.
Rejected units remain missing checks, including their observed unit text in feedback.
Empty/omitted template families remain missing rather than silently changing the
grade's denominator, unless the template declares `optional: true` for kinds that a
correct output may legitimately lack (forecasts, conflicts). An empty optional family
then relies on the omission audit, exactly as omitted units of non-empty families do:
units both the extractor and the audit skip are not graded. Location hints accept
`a[1].b` for `a.1.b` when no literal `a[1]` key matches. A family with verified units excluded by false when conditions
or declared locations is inapplicable and does not create a synthetic missing check.
Absent condition fields and rejected spans still produce missing checks.

Optional `gates: [{id: accepted, check: {...}}]` use the normal evaluator registry
against the same captured artifact. Recursive graders and unbound tool gates are
refused. Tool sequences must end at an accepted call and require argument equality
to an earlier validation binding. Failed/errored gates stop atomic inference;
unknown gates preserve an unknown evaluation even when atomic scoring completes.
An acceptance gate with an error anywhere in its result tree emits
`atomicFailure: {cause: acceptance-gate, gateId}`
and omits the evaluator score. Its children and actual judge calls remain attached;
no `atomicGrading` result is fabricated before extraction. Replay preserves this
classification, and training rejects it even when an `all`/`any` gate composition,
sibling or stage gate masks the error. A genuine failing gate judgment remains
a behavioral score of zero.

## Aggregation

`score = critical_gate × obligation_coverage × weighted_quality`:

- Critical gate is zero if any critical probability is missing or below
  `critical_pass_at`; otherwise it is one. No quality score offsets a failed gate.
- Obligation coverage averages the minimum expected-answer probability across checks
  for each distinct obligation occurrence. Missing probabilities contribute zero.
  No observed obligations means zero coverage.
- Per dimension, penalties are `severity_penalty × (1 - probability)`.
  Missing probabilities use zero. Checks at the same source occurrence and dimension
  share the largest penalty; distinct occurrences add penalties. Dimension quality is
  `1 - min(1, penalty_sum / budget)`. Declared weights combine these fixed budgets.
  Adding perfect checks cannot dilute defects.

Noul, Choice and anchored Score templates use the typed TypeSafe transport; the
expected-option probability is summed in code. Malformed/incomplete probability
sets remain missing. `missing` never permits a pass; missing-policy unknowns retain
the conservative numeric score. Extraction/audit, backend identity and transport
failures produce error grades with null score and available receipts retained.
HTTP 402 payment failures are terminal transport errors under either missing policy.
They stop queued scoring requests, drain already-started work and retain receipts;
they never become missing-content results or zero-quality training observations.
Other nonretryable HTTP rejections (for example 400, 403, 404, 413 and 422)
retain `failureCause: request-rejected` through transport and become an error grade
with `score: null` and typed `failure.cause: request-rejected` under either missing
policy. Reasons contain only the HTTP status; response bodies never enter diagnostics.
Training rejects every errored atomic measurement, including extraction and payment
errors without a typed failure, even when a sibling or explicit gate masks the error.

`max_spend_usd` is one shared route admission cap across its training trials, not a
fresh allowance for each artifact. A host override can only lower it. Atomic routes
send once per HTTP batch and charge the greater of estimated/measured input spend
in their admission ledger; unknown usage retains the estimate. Receipt `usd` stays
null when actual usage is unknown. This cap bounds admission estimates, not the
provider's eventual invoice if actual usage exceeds those estimates.
Exhausting this cap is an admission error under both missing policies, never a
behavioral failing check: the grade has `status: error`, `score: null` and
`failure: {cause: spend-cap, reason: spend cap}`. Each check retains its transport
outcome/reason, and already-dispatched receipts remain attached; rejected admission
creates no request receipt. The evaluation omits its numeric score. Training refuses
optimizer reward for this outcome even if another failing check masks the error
in a logical aggregate. Replay preserves and validates the typed failure.

## Evidence and optimizer feedback

`atomicGrading` retains the decomposition/check identities, probabilities, full
extraction/audit checkpoints and validation diagnostics, actual subscription calls,
and invocation-owned JEV receipts. Replay validates and preserves these fields.
Temporary extraction files are evaluator-owned, mode 0600, and removed after their
content enters the result. They contain no login credentials. This receipt flow is
not durable recovery of an interrupted host process; experiment persistence owns
completed reports.

Training feedback projects only failed checks' template, truncated unit text and
probability (null for missing), plus failed/omitted counts. `max_checks`,
`max_unit_chars` and **UTF-8** `max_bytes` bound this projection independently from
full receipts. Validation/test feedback remains empty. Task output and other
criteria remain governed by the existing training-feedback contract.

Verification uses injected subscription/fetch backends, accepted-artifact snapshots,
stored replay and optimizer projection tests, with no live JEV calls. Live historical
trial fidelity and improvement require the surrounding training integration packets.
