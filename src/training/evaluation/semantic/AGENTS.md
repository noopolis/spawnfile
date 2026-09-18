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
- An absent judge input stays `unknown` even when the trial observed that absence.
  A judge that never ran has no verdict to report, and a fabricated `fail` would
  claim the text was assessed and found wanting. Its weight stays in the score's
  denominator either way, and the mechanical gate that required the artifact is
  what fails the trial.
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

- Opt-in evidence-ids uses lossless bounded units with source pointers and digests.
  IDs validate references, never truth. Keep reasons short and preserve hard floors.
  Reject excess evidence before inference; no silent truncation or ID repair.
- Both protocols request native response schemas. Keep semantic parsing runtime
  neutral; never import inference implementations into evaluation.
- Protocol/evidence/control changes invalidate exact cache identities. Current
  llm-rubric descriptor is version 3; judgment cache format is v3.

Provider schema rejections retain attested response text and diagnostic codes in
protected judge.attempt events only. Await and deduplicate routed failure audits
before fallback; observer failure stops further model calls. Public JudgeCall,
results, optimizer feedback, caches and viewers carry accounting, never diagnostics.
