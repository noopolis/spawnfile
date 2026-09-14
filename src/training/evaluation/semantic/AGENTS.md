# Semantic Evaluators

Owns fixed rubric prompts, typed judgments, evidence and judge calibration.

- Call explicitly selected inference interfaces, never subject runtime adapters.
- Treat candidate output and evidence as untrusted data, separate from instructions.
  Require grounded diagnostics and validate the judge's structured response.
- Present selected values once as JSON; citations match their named source's exact
  serialized representation or one original string leaf, never normalized or joined
  text. Preserve escaped characters and keep source names isolated.
- Keep rubrics fixed during candidate optimization. Human calibration, disagreement,
  provider identity and version belong in evaluation provenance.
- Missing authentication, quota failures and malformed responses are errors, not
  low-quality subject verdicts or reasons for a paid API fallback.
- Retain each judge attempt's named route, requested and returned identities,
  and observed usage even when its judgment is invalid. Unknown usage stays null.
  A requested-assumption inference model yields a null responseModel, retaining
  measured usage without promoting a requested alias to provider evidence.
- Direct typed provider failures retain validated accounting fields just as
  routed failures do. Never infer a failure category from error prose.
- Test malformed judgments and adversarial content offline; actual subscription
  integration requires observed generations and measured/unknown usage labels.

- Named routes may explicitly permit one citation-only repair; the default is zero.
  Repair only exact citations, retaining the original score/verdict/reasons. Never
  retry valid grades, JSON/schema failures, cancellation or provider errors.
- Citation source IDs are literal `input` or present `evidence`, never URLs or
  article section names. Version fixed prompt changes in the evaluator descriptor.
- Await the trusted raw-response observer before accepting or repairing. Keep raw
  responses and violation details out of result/optimizer/viewer projections;
  observer failure is an infrastructure error, not permission to continue.
