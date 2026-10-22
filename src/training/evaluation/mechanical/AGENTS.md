# Mechanical Evaluators

Owns observable text, schema, tool, count, file and event relationship checks.

- Calling a tool is mechanical evidence, not a semantic judge. Distinguish
  proposal, dispatch, successful completion and persisted side effects.
- Existence has no implied order. Absence needs complete declared scope.
  An incomplete trace without a match cannot establish absence.
- An observation we could not make and an absence we did observe are different
  verdicts. A required artifact that is simply not there fails, with its weight
  kept as a measured zero, when the run could see that it is not there: the
  selector reads an artifact the host collects at closure, the trial is closed
  and `subjectUsage.status` attests a completed, settled, proven, fully covered
  subject execution. An open trial, a partial or legacy capture, an errored,
  cancelled, deferred or unproven execution stays `unknown` and unscorable. An
  absent `output.text` is itself incomplete coverage and never certifies absence.
- Bind ordered actions to exact artifacts, call IDs, authors and receipts where
  the case requires them. Timestamps alone do not prove cross-source causality.
- Allow unrelated extra events unless the case explicitly asks for an exact chain.
- Grow by coherent check families when needed, with tests and fixtures beside them.
- Token efficiency scores only closed, complete native subject totals. Missing
  usage never becomes zero; cache/reasoning subsets are not added again. Its
  normalization reference is not a cap, and it never authorizes a live hard stop.
- Test missing/failed/reordered calls, stale receipts, changed bytes and truncated
  traces. Do not route negative tests around the default behavior.

word-count and values-in-source own deterministic lexical text checks. Parameters
come from the shared strict case descriptors; measured count/missing values persist
in mechanicalEvidence beside byte references. Source absence stays unknown.
