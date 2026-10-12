# Population search

Owns deterministic round planning, realization gates, instruction-unit change,
sequential evaluation and population selection beside the legacy GEPA path.

- `population.optimize_population` is the optimizer dispatch seam. `Evaluator`
  accepts ordered requests and returns results in the same order; P6 may provide
  concurrency behind it. No native runtime, inference provider or paid API here.
- Only training observations enter planning/realization. Validation scores select;
  never expose validation text or case IDs in generation prompts.
- Reconstruct state from host-journal callback replay; no Python-side pickle.
  Pending/failed callback recovery offsets and checkpoint forks fail closed.
- Every rejection precedes evaluation, stays in round attempts, and consumes only
  declared generation budget. Preserve deterministic IDs, stable ties and slot order.
- Tests live beside source. Run the bridge README pytest/coverage gate and the
  TypeScript real-process population/checkpoint conformance tests.
