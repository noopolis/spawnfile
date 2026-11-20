# Rescore saved evidence

`rescoreStoredTrial` is an explicit evaluation operation. It does not start a
subject, restore a workspace, send another stimulus or create a new trial.
`store.readReplay` and the viewer remain playback operations with no inference.

```ts
import { rescoreStoredTrial } from 'spawnfile/dist/training/index.js';

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
- A separate evaluator-only `spawnfile.training.rescore.v1` record references the original
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

Captured `snapshot.subjectUsage` holds authoritative subject-only usage returned by
the adapter, summed once across expected turns. Cached input and reasoning are
subsets, not additional tokens. The capture is complete only after successful native
closure with settled host work and complete usage coverage. Failed, cancelled or
partial work retains incomplete measurements and cannot earn an efficiency score.
Replay validates those measurements against stored native totals and closure;
legacy captures without the field remain readable with unknown efficiency.

Captures with subject usage also retain the authored `expectedTurns` independently
of returned turn results. Replay rejects missing/invalid planned counts and complete
claims with truncated work; legacy reports without subject usage remain readable.

## Portable trial files

Each new stored trial writes one private file under `<out>/evals/`. Its returned
report gives the relative path in `evalFile`. Copy that file to an evaluator's
machine and run `spawnfile train --regrade moved.eval --out graded`. Read
`graded/REGRADE.json` for the original verdict, the new final-stage evaluation,
coverage and native closure.

The file carries the authored task, staged inputs, normalized trace, declared
artifacts, runtime reply and original scores. Other collector files, raw native
transcripts and private diagnostic text are excluded. An older capture that
omitted the reply cannot reconstruct it. File digests detect damage but cannot
authenticate a sender.

`readTrialEval(file)` verifies and returns frozen evidence without running any
checks. The offline command explicitly reruns recorded final stages using the
captured criterion files and installed evaluator versions. It opens no model
connections. Checks requiring a grader, judge or embedding service report the
missing resource.

For a configured grader, run
`spawnfile train --regrade moved.eval --train criteria.yaml --out graded`.
Supply a training dataset with the original record ID and its grader files or
named judge routes. The lowered training dataset from an authored run is also
valid. Grader files, calibration and rubric sidecars resolve beside that dataset.
For a hosted subscription judge, add `--auth-profile training`. Local and API
graders use their usual backend configuration. Credentials stay on the grading host.

Only the matching record's final stages run. Checks see the captured trace,
reply, files and context. The subject and optimizer never start. Missing
configuration or an unavailable grading service produces a diagnostic or an
unsettled check. The original scores stay in the .eval. Each command writes its
new evaluation to `REGRADE.json` under `--out`. Use separate output directories
to keep multiple reports.

For a recorded-output questionnaire manifest, use
`spawnfile train --regrade regrade.json --auth-profile training --out graded`.
This mode reads the outputs listed in the manifest and resumes settled judgments
from the output directory.
