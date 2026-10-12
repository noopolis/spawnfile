# Native Trial Lifecycle

Owns preparation, trusted observation intake, live checkpoint scheduling, bounded native wakes and durable trial outcomes. Use public case/candidate/storage/adapter contracts. Never decide agent strategy or production deployment. Source files and future stimuli remain outside the workspace until explicitly staged. A final mechanical witness and cancellation completeness are separate evidence.

Stored-trial preparation receives an isolated copy of this trial's record,
candidate, phase and resource mappings. It is trusted evaluator-side context:
never copy criteria, reference answers or future stimuli into the subject's
workspace. Preparing native tools/configuration must preserve declared candidate
bytes and record any deliberate environment reconstruction.

Public exports live in index.ts. Keep adjacent tests and required guides when extracting cohesive modules. Run targeted tests and retain90% per-file coverage on all four metrics; use real native/DSPy acceptance evidence separately from deterministic facade tests.

Judge response audits use the existing protected trial event sink. They are not
native observations and never enter subject snapshots. Persistence failure must
prevent a durable success report and cannot trigger citation repair.

Subject efficiency consumes only returned per-turn native usage totals, never usage
observations or judge/optimizer accounting. Attest completeness only after all
expected native work closes successfully, host work settles and usage coverage is
complete. Per-turn checks receive that turn's own totals; an open handle is still
incomplete. Preserve nulls and reject invalid counters/overflow before arithmetic.

An adapter may publish a redacted `SubjectStartupDiagnostic` on a subject that
never became ready. The runner accepts it structurally — it never imports an
adapter — refuses any other shape, persists it through its own durable sink and
carries it on the report, so a failure explains itself without a second run.

The same failure may hand over an unredacted capture. The runner writes it once
into the trial's own directory as an operator-only `0600` file, refusing any name
that is not a plain file name, and keeps only its path in the record. That
directory is the operator's own run output beside the trial scratch, never inside
the content store, so no replay, viewer projection or report can reach it: the
boundary this repository enforces is the audience of a shipped artifact, not the
existence of bytes on the operator's disk.

A subject can close its own execution and still leave the delivery accepted and
deferred awaiting external input. That is the agent failing the task, not the
machine failing the trial, so the report's `execution` is `deferred` rather than
`failed` and the trial is scored. It is claimable only with the adapter's own
blocked receipt plus the proofs behind a confirmed stop — matching closed native
work, idle runtime, acknowledged stop and observed exit — and an uncertain, hung,
crashed, aborted or deadline-killed execution stays `failed` exactly as before.

When that demotion happens, the report says which fault caused it, and there are
two of them. The deferral is the subject's outcome and the demotion is the
machine's, and while they shared one `error` an unprovable closure published the
subject's own "delivery blocked awaiting external input" as the reason a trial was
unscorable — the sentence that sent two investigations after the agent instead of
after the missing proof. `error` now leads with `Native closure unproven (<cause>)`
from the receipt's closed `StopUnconfirmed` vocabulary when containment is in
doubt, or with `Native trial unscorable for want of terminal evidence (<cause>)`
from `unevidenced` when the runtime is provably quiet and this trial simply has no
frame to be scored from — followed by `on wake <id>`, because a trial that ran
several wakes has to say which delivery that refusal was read from — and keeps what
the turn said after either. The two are never collapsed: one says a worker may
still be spending and the other says it is not, and they call for fixes in
different places. Naming a cause grants nothing: the verdict and every proof
behind it are unchanged.

Deferred is never success. The unanswered delivery is itself a final failing
witness, so a deferred trial can never report `pass`; the measured checks keep
their own verdicts and weights, so a missing artifact stays a missing artifact in
the score's denominator rather than becoming a measured zero. An errored terminal
plan still outranks the deferral: an evaluation that could not measure remains
unscorable instead of being published as a behavioural zero.

Evaluation services preserve injected grader runtimes alongside judges and embeddings.

Preparation receives the caller's leased `slot` descriptor unchanged; SubjectStart
receives the same identity. Runtime integrations own resource mapping. Never infer
fixed worker identities, ports or paths in the experiment layer.
