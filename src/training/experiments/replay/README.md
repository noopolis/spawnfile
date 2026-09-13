# Rescore saved evidence

`rescoreStoredTrial` is an explicit evaluation operation. It does not start a
subject, restore a workspace, send another stimulus or create a new trial.
`store.readReplay` and the viewer remain playback operations with no inference.

```ts
import { rescoreStoredTrial } from '@noopolis/paideia';

const rescored = await rescoreStoredTrial({
  store,
  runId: 'saved-trial-id',
  access: { audience: 'evaluator', phase: 'replay' },
  dataset: resolvedNewCriteria,
  registry,
  evaluation: { judges: {}, embeddings: {}, readText: readProtectedCriterion },
  id: 'rubric-revision-2',
});
```

The store, resolved dataset, evaluator registry and protected sidecar reader are
caller-prepared through the normal public APIs. Semantic criteria require an
explicit configured judge; only this rescore call may invoke it. Test captures
still require the original frozen candidate and an authorized test/release phase.

- The original immutable trial report supplies the final snapshot, including its
  inputs, context, output, artifacts, observations and coverage. New dataset
  inputs or setup never run and do not replace captured evidence.
- The new dataset must contain the original record ID exactly once. New terminal
  stages, versions and authenticated sidecar digests are frozen and recorded,
  alongside configured judge provider/model and embedding provider/version routes.
  These receipts describe configuration, not proof every route ran. Evaluator
  versions are checked; the current inference interface cannot attest judge versions.
- Version-one captures contain no per-turn snapshots. Authored per-turn checks
  therefore reject. Live policies are not rerun; the returned scope is explicitly
  `final-stages`, with live/per-turn listed under `notReevaluated`.
- A separate evaluator-only `paideia.rescore.v1` record references the original
  evaluation ID and integrity digest. Reusing an evaluation ID rejects. The original
  report and event journal remain unchanged.
- `evaluation.status` describes the replacement terminal criteria. `status` also
  retains original execution restrictions and any decisive mechanical failure.
  `execution`, `hostWork`, `coverage`, `decisiveFailure`, `stop` and `error` remain
  historical facts; a new passing rubric cannot turn an interrupted run into a
  completed one.

Missing/ambiguous reports, malformed identities, corrupt digests and torn journal
or report data reject before evaluator work. A valid partial observation channel
stays partial and can still yield unknown; rescoring cannot fill missing evidence.
