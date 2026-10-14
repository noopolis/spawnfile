# Population search

Owns deterministic round planning, realization gates, instruction-unit change,
bounded concurrent evaluation and population selection beside the legacy GEPA path.

- `population.optimize_population` is the optimizer dispatch seam. `Evaluator`
  accepts ordered requests and returns results in the same order, with at most
  request.concurrency active callbacks. No native runtime, inference provider or paid API here.
- Only training observations enter planning/realization. Validation scores select;
  never expose validation text or case IDs in generation prompts.
- Reconstruct state from host-journal callback replay; no Python-side pickle.
  Pending/failed callback recovery offsets and checkpoint forks fail closed.
- Every rejection precedes evaluation, stays in round attempts, and consumes only
  declared generation budget. Preserve deterministic IDs, stable ties and slot order.
- Tests live beside source. Run the bridge README pytest/coverage gate and the
  TypeScript real-process population/checkpoint conformance tests.

Instruction-change v2 parses logical wrapped units, excludes ATX/Setext heading
labels and counts repeated canonical units once per component.
Independent rules split alike at periods, commas and semicolons; conditional and
workflow clauses stay together. Adjacent-token features preserve directive/action
attachment within units; unit reordering remains invariant. Canonically identical
resource text scores zero before segmentation differences count. History rejects
zero-distance bundles using this same metric, even with a zero novelty floor.
Repairs may reuse their slot's content and hypotheses; attempted content is
reserved against later slots/rounds. Report
change heuristics as bridge-reported-v2 and retain exact generation response text
for host binding; heuristic values are not independently host-verified.
`boundaries.py` compiles declared preserve/require-text/forbid-text rules; validate
seeds before callbacks and reject violations before evaluation. Free-form prose is
unsupported. Never replace exact enforcement with proposer attestations or imply
semantic compliance. `instruction_text.py` excludes Markdown metadata before unit
segmentation without discarding fenced examples.

Every accepted candidate gets complete validation and train passes at admission,
including final-round candidates. Reserve the sum of both split sizes before
planning/realization. Cache unchanged parent feedback; settled checkpoint callbacks
replay without new trials. Sealed test has no bridge callback role.

Set the session round before parent feedback and variant validation. Cached
feedback is a prior capture, never a fresh measurement in the current round.
