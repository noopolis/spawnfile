# Training and Held-out Comparison

Owns fixed dataset partitions, protected criterion snapshots, native metric trials, DSPy subscription callbacks and frozen baseline/candidate tests. Consume the trials public interface; do not implement native cognition or a second optimizer. Test data never enters optimizer callbacks. Do not disguise infrastructure interruption as a zero-quality training case.

Public exports live in index.ts. Keep adjacent tests and required guides when extracting cohesive modules. Run targeted tests and retain90% per-file coverage on all four metrics; use real native/DSPy acceptance evidence separately from deterministic facade tests.

`feedback.ts` projects train-only task results: final text and the captured values
named in record.outputs or trusted setup.artifacts. Never broaden this to all
snapshot artifacts, private context, input files, reference labels or collector
parameters. Missing declared artifacts stay unavailable. Validation/test callbacks
return empty output and feedback. Test the actual stored-trial/optimizer callback
path so file-based work cannot disappear behind an empty final chat response.

Inference recovery belongs inside the declared provider route. A transient judge
failure can try the next authorized route while the same captured article remains
in the current trial. A returned failing grade is a measurement, never a retry
trigger. Exhausted routes remain an infrastructure interruption with immutable
capture and unknown score; do not silently repeat the subject or count it as zero.

`routing.test.ts` exercises that boundary through the real stored-trial and
semantic-evaluation path with deterministic inference/subject fixtures. The DSPy
callback is a test facade; this does not establish real-model writing improvement.

Durable resume uses evaluator-owned checkpoint files with a caller-held exclusive
lock. The core binds candidate, datasets, routes/environment identity, model, seed,
budgets and bridge versions. `checkpoint.ts` preserves exact native reports and
freezes optimizer selection before any sealed test. `recovery.ts` verifies original
stored evidence and confirmed cleanup; an unacknowledged native attempt blocks.
Only classified transient final judge errors may reserve a bounded rescore. Rescores
remain separate immutable measurements; no successful native capture is repeated.
Persist each recovery reservation before inference, and recover a settled rescore by
its exact reserved ID after a crash. Missing evidence and valid failing grades never
trigger recovery. A cumulative recovery budget cannot reset on resume.

Progress restores original reports and separate rescored measurements, and forwards
observed events only through the trusted caller's projection. Never expose sealed
text or inference prompts through operator summary views. `routing.test.ts` now
executes actual DSPy restart after a judge outage with an isolated deterministic
subject; it proves replay/rescore identity, not writing improvement.

Optimizer feedback projects criterion reasons/status/scores, stage weights and
native subject usage once, omitting duplicate aggregate trees and judge accounting.
The original TrialReport remains unmodified. This compact train-only projection
must not strip meaningful nested criterion failures or expose validation content.

A newly classified `invalid-response` judge failure may use existing bounded
measurement recovery after native closure. Generic legacy `protocol` failures
remain ineligible; never infer their missing cause or rewrite historical receipts.

Explicit measurement-repair forks preserve inherited native reports and only
remeasure their failed final semantic leaves. New child trials use ordinary recovery.
Training lineage records inherited IDs; costs and viewer progress restore them once.
The checkpoint may finish interrupted fork initialization on resume, but an ordinary
resume never fabricates a missing journal. Parent imports remain development-only.

The comparison owner reuses `TrainingCheckpoint.openComparison` and capture/recovery
APIs with an explicit comparison identity. It neither opens nor imports optimizer
state. Ordinary training identity and measurement-repair behavior stay unchanged.

`trialScore` scores a `deferred` trial, which carries its own quiescence proof and
can only be a `fail`, so a subject that ended its turn without doing the work
becomes a zero the optimizer can learn from instead of an infrastructure error.
Opt-in scoring.deferred=stage-score retains the final numeric stage reward only
when the trial owner recorded a passing preDeferralStatus. Capture that verdict
only in the opt-in path; default reports and rewards stay unchanged. Keep the
trial failed, honor all measurement/cleanup guards, bind checkpoint identity and
use the same policy in callbacks, held-out means and operator exports.
`failed` remains unscorable; only explicit native-infrastructure failures allow
subject replacement.

Evaluation services preserve injected grader runtimes alongside judges and embeddings.

Training resolves runtime-neutral slot descriptors before opening checkpoints.
Pass a lease to preparation and subject start; retain it through closure, collection
and stored-report publication. Unconfirmed closure or unsettled host work quarantines
that slot. Progress and checkpoint mutations serialize independently of subject work.
Slot descriptors and effective concurrency bind checkpoint identity.
Population search controls pass unchanged to optimization and participate in the
training checkpoint identity. Derive component editScope from the frozen baseline,
not integration claims, so provenance reflects actual whole-file or heading edits.

`held-out.ts` runs baseline/selected jobs after checkpoint freeze and the awaited
selection event. Bound workers by effective slot concurrency, preserve candidate
and case order in comparisons, stop dequeueing on failure and drain active jobs.
Leases stay with the existing trial owner through collection/publication.
`feedback.ts` forwards only public atomic feedback. Cap output at 16 KiB and
feedback at 32 KiB by encoded UTF-8 size; atomic failures get 8 KiB, 40 checks and
1000 characters per unit, with explicit omission counts. Oversized feedback keeps
structured atomic failures beside an identified excerpt. Never mutate raw reports.
Reserve an excerpt for every declared artifact before optional chat. Oversized
feedback retains criterion IDs/status/scores, nested results, stage weights and
subject usage structurally, outside its prose excerpt. Refuse structured evidence
that cannot fit the cap instead of dropping it. Verify retention through the
Python proposer, whose own output compaction must reserve the same artifacts.
The adjacent feedback tests pass large projected results through Python Session
and both population generation phases, asserting current/history atomic retention.

Atomic feedback includes only the runtime-bounded failed-check projection: unit text,
template, probability and omitted count. Never forward decomposition/checkpoint
responses to the optimizer; the protected original report retains them.

trialScore refuses every errored atomic measurement or typed atomic failure anywhere in the final evaluation tree before any reward can be returned, even when a decisive sibling or explicit gate masks the error.
This includes atomicFailure from early acceptance-gate errors; genuine failing
gate judgments remain behavioral zeros. atomic-gates.test.ts exercises resolved
grader gates through real rubric evaluation with fake providers.

Completed reports carry invocation elapsed host durationMs, including restoration
and sealed tests. Do not sum parallel trial durations as invocation elapsed time.
The CLI owns local operator report/bundle export; it never reselects from test.

Forward actual optimizer callback round IDs to stored trials. Candidate manifests
belong to native measurement persistence, independent of final optimizer selection;
completed checkpoint resume must retain rejected evaluated proposals.

resolveTrainingPartitions preserves explicit validation dataset identity and rejects competing group controls. Split checks still bind all three roles.

Held-out test repeats (1..8, default 1) use fresh native trials per case/arm.
Repeat zero retains legacy checkpoint keys; additional repeats use a distinct
JSON tuple namespace. Bind nondefault repeat counts into checkpoint identity.
Report aligned per-trial scores and descriptive sample standard error; rescores
replace measurements without adding samples. Missing repeats alone execute on resume.

Opt-in trialRetries (authored budget.trial_retries, 0..3) replaces only execution=failed
trials explicitly classified failureKind=native-infrastructure, after confirmed
shutdown and settled host work. Recheck retained observations, output, artifacts,
native usage, turns and decisive witnesses before replacement, including on resume;
a persisted classification alone is insufficient. Keep historical reports unchanged.
Legacy unclassified failures are ineligible.
retry.ts retains the
logical callback/repeat key and checkpoint.ts reserves distinct replacement entries
with failed IDs and causes. Failed captures remain unscorable; successful captures
and errored measurements are never repeated. Retry count survives resume; replacements
share cancellation, slot admission and the original callback/held-out worker.
