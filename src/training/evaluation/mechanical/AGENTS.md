# Mechanical Evaluators

Owns observable text, schema, tool, count, file and event relationship checks.

- Calling a tool is mechanical evidence, not a semantic judge. Distinguish
  proposal, dispatch, successful completion and persisted side effects.
- Existence has no implied order. Absence needs complete declared scope.
  An incomplete trace without a match cannot establish absence.
- Bind ordered actions to exact artifacts, call IDs, authors and receipts where
  the case requires them. Timestamps alone do not prove cross-source causality.
- Allow unrelated extra events unless the case explicitly asks for an exact chain.
- Grow by coherent check families when needed, with tests and fixtures beside them.
- Test missing/failed/reordered calls, stale receipts, changed bytes and truncated
  traces. Do not route negative tests around the default behavior.
