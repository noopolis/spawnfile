# Experiment Storage

Owns persisted experiment events, immutable artifacts and replay queries.

- Storage records outcomes; it does not invoke subjects, judges or optimizers.
- Preserve run/candidate/case/evaluator identity, event ordering and provenance.
  Keep historical scores immutable; a rescore creates a new identified result.
- Separate protected raw captures from approved viewer/evaluator projections.
  Enforce sealed-test access according to experiment phase through public contracts.
- Keep generated runtime data outside tracked source and generic task corpora.
- Split ledger, artifacts and queries when each becomes a real responsibility.
- Test interrupted writes, duplicate/replayed events, corruption and protected
  reads. Opening stored evidence must not create model calls or new scores.
