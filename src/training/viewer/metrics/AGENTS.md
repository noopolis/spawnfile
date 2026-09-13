# Cockpit presentation metrics

Owns pure summaries of the caller-authorized `ViewerData` projection. The public
seam is `index.ts`; consumers use its types and `buildCockpitMetrics`.

- Group native candidate identities without counting repeated optimizer aliases
  as prompt improvements. Keep unmapped cases in the unknown split.
- Summarize each recorded stage/check independently. Never invent a combined
  stage score. Keep supplied strict trial scores and terminal gate counts separate.
- Compare only matching case IDs; expose sampled and declared counts. Repeated
  trials average within each case before averaging cases. Missing scores remain
  unavailable, never successes.
- Index only observed candidate/split/metric groups and each candidate's stages;
  never allocate their global Cartesian product. Trial labels and splits use the
  same candidate index through the order-preserving `trialIndex` projection.
- Preserve recorded cost valuations and distinguish complete token totals from
  known subtotals. Never add cached input or reasoning subsets twice.
- No I/O, cognition, scorer execution, private dataset/trace access or imports from
  runtime, storage, optimization or evaluation implementations.
- Verify with synthetic adjacent tests and targeted coverage for this directory;
  the integrating owner runs the final full checks and cross-vendor review.
- Success is correct candidate grouping, paired coverage and unknown accounting;
  use at most three fix/review rounds. Stop if the owning projection cannot supply
  the required evidence without changing evaluation semantics.
