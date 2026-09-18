# Native Daimon adapter worker

Owns one isolated Codex or brokered Grok attention trial through the public Daimon
runtime and a caller-owned local container. Never compile organizations, reconstruct identity,
replace memory/tools, copy credentials, wake production agents or invent evidence.
Project profiles and transport bootstrap remain caller-owned. Require exact launch
receipts, authenticated native activity, closed telemetry and verified containment.
Use public module indexes across child boundaries; no sibling implementation imports.
Keep adjacent tests, files below 400 lines and per-file coverage above 90 percent.

External continuations are opt-in, sourced, bounded to three deliveries and share
one trial deadline. Deferred work is never success. Preserve per-wake evidence and
aggregate usage once; cancellation must stop the owned runtime.

Preserving it is a file per wake, not a file per trial. `--evidence` is renamed
over on every delivery, so a continued trial kept only its last frame: the
assignment's frame — the one that had bound over a closed trace — no longer
existed by the time anything read it. Each delivery now also files its own frame
under its delivery ordinal (`evidence.1.json`, `evidence.2.json`, …), which no
later wake of the same trial reuses. Nothing is merged and nothing is summarised:
each file is exactly one wake's own frame, naming its own wake, and the latest is
still at `--evidence` for a reader that wants the trial's last account.

**Which execution a wake closed is the runtime's statement, never a count.** A
new delivery makes Daimon revisit this trial's still-deferred deliveries before
it runs the new one, so while a continuation waits its turn the runtime opens,
closes and files executions that answer for ANOTHER of this trial's wakes. The
poll therefore binds on what the runtime says about THIS delivery — the wake
receipt's `execution_id` while the wake runs and on a completed delivery, and the
activity projection's `delivery_ids` once a deferral has cleared the receipt's —
and resolves only the trace that execution named. Every rule that counted traces
instead was wrong in a different way: one unexpected trace was attributed to the
wrong wake, two refused the trial ("an isolated trial produced multiple native
executions") on a run that was healthy and quiet.

Only where the runtime named nothing at all may a wake answer for what closed
inside its own window, and only once the runtime has DISPOSED of this delivery —
completed, failed, or marked deferred — while admitting no execution. That
conjunction is what says this delivery's own execution ended: the disposition is
written during the turn and the idle projection does not say whose turn ended.
Two unattributed executions in that window is one delivery with two answers, and
it fails closed under its own name rather than taking the first.

The same rule attributes every stream: a bound wake's evidence is exactly what
names its execution, and a trace or ledger row of this trial's that names another
is that wake's, not a fault. Refusing it ("foreign native execution trace") was
the arity wearing an isolation word. Isolation is refused where it can actually
fail — a trace or usage row that is not this agent's, a model context that is not
the declared model — and the runtime home was asserted empty before startup, so
what remains is this trial's own work. Nothing is merged across wakes: each frame
carries its own execution's trace and its own metered row, and a wake that bound
nothing carries no trace to speak for it.

The runtime wake ceiling this worker publishes is derived from that same bound
(`MAX_TRIAL_WAKES` — the task delivery plus its continuations), never declared
beside it. It is set before any delivery arrives, so a second number there drifts
from what the gate admits; hard-coded at one it admitted continuations the runtime
then never executed, and each such wake burned to the shared deadline instead. The
gate stays the exact per-trial bound and also refuses a budget above the runtime's
own per-agent execution policy. More wakes buy no wall clock and no token budget:
the one trial deadline and the epoch-wide `maxTokens` ceiling are unchanged.

**That derivation is the same assumption, unfixed, and it is a spend decision
rather than a correction.** The gate counts DELIVERIES; the fuse the ceiling
feeds counts EXECUTIONS, and the revisits above mean a trial closes up to
`deliveries + revisits` of them — 10 for the full four-delivery budget, against a
ceiling of 4. Past that the fuse refuses to admit a wake the gate already
accepted, which is precisely the "burned to the shared deadline" failure the
derivation was written to end. The same counting sits under
`readModelContexts`'s eight-session bound. Raising either raises the worst-case
model turns a trial may buy, so it needs the owner's decision, not a quiet edit;
until then a continuation budget above one is not safe to run.

Usage coverage can be complete only for one matching completed execution trace
and its single provider-complete Codex terminal total. Reject duplicate totals and
invalid cache subsets; never infer completeness from a nonempty ledger. This is
observed token coverage, not a billing or subscription-quota guarantee. A deferred
delivery may have complete usage for its closed execution; its overall subject
trial remains incomplete until the continuation succeeds and containment closes.

A closed execution leaves its delivery in one of three dispositions, and the third
is not the agent's. `completed` is the work done; `accepted` **deferred** is the
agent declining it, including the unmarked finished wake Daimon records as
deferred. `accepted` WITHOUT that marker, with the execution id retained, is
written only where a wake came back `stopped` and the runtime reclaimed the
delivery for restart, so it evidences nothing about the subject and must never
borrow the deferral's scored outcome. It reports as its own failure, naming the
wake outcome Daimon recorded on the reclaimed receipt — `active_wake_aborted`,
`queued_wake_stopped`, `host_stopping`, `host_stopped` or `engine_failed` — passed
through from a closed set, with `unrecorded` for an absent or unrecognised one.
That is a different statement, not a missing one, and a value outside the set is
never forwarded as though Daimon had stated it.

It names nothing else, and that is the correction. The message used to say *which*
runtime reclaimed it — "while the runtime kept running" or "by a stopping runtime"
— read off `availability.state`. That state is the wake fuse's verdict
(running/paused/operator-stopped); it is read after the execution closed, on a
different clock from the dispatcher's write, and it never reflected the
dispatcher's own halting latch at all. So the distinction was not evidence, it was
an inference dressed as one, and it sent a whole round of investigation at
Paideia's stop ordering. The claim is dropped rather than re-derived: the wake's
own code is what this process witnessed, and it is the whole of what the sentence
may assert. Daimon no longer keys the reclaim on its dispatcher's `stopping` latch
either, so a completed wake under a halting host is a scorable deferral and never
reaches this path.

Grok usage comes from the broker's per-slot ledger, never this process: rows need
`total = input + cache_read + cache_write + output`, the declared model (or its
`-build` alias) and a `turn` key. Byte-identical replays of one turn count once;
differing rows under one turn fail. Estimated requests keep coverage partial.
Load the Grok runtime exports only for Grok launches and fail closed if absent.

`verifyNativeWorkerStartup` is the public, side-effect-free composition of the
startup checks, for callers that must validate a prepared launch before starting
anything. It leaves out Daimon's own config parse, which needs the runtime peer,
and the worker runs it as its first step so the two cannot drift.
