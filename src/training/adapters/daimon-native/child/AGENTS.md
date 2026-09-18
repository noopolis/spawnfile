# Same-container native trial children

Own explicit child-process execution inside a caller-owned training container.
Use the maintained native worker and its loopback protocol. Never launch Docker,
copy subscription authentication, claim fresh-container or held-out exclusion,
or replace native evidence. The caller prepares credential ingress via its owner.

Fresh actual workspace/home paths must match the compiled launch. Stop confirms
only matching closed native work, idle activity, acknowledged native stop and
observed child exit. Uncertain cancellation fails closed; outer container teardown
remains the caller's responsibility. Tests use real child/loopback fixtures but
must not claim actual authenticated model acceptance from those fixtures.

A completed trace can close an execution whose delivery remains accepted and
deferred awaiting external input. Require that explicit blocked receipt and all
identity/idle/stop/exit proofs. Confirming closure never changes the task outcome
or makes an unanswered delivery eligible as completed training evidence.

Those proofs are read from a runtime that has usually already stopped, and that
ordering is the whole of it. The worker stops its own Daimon host the moment a
delivery closes its execution and stays deferred with no continuation left — so
`stop()`'s `/v2/activity` query, the only authority that can settle whether the
execution closed, lands on a stopped host. Daimon answered `undefined` there
(HTTP 503 `native_host_unavailable`) until it sealed that projection at shutdown,
which is why a subject that really ran every wake its budget allowed, spent the
money and simply never did the work reported as an unscorable infrastructure
failure instead of a scored zero. Nothing here infers closure in its place: this
module still requires the receipt, and `child/fixture.ts` models both hosts —
the sealed answer and one that refuses it — because a fixture that always
answered post-stop is exactly what hid the defect through every green run.

**Two questions, two vocabularies, and a failure says which one it is.**

*Closure* asks whether anything is still running or still spending. It is three
live proofs and nothing else: the runtime admits no execution of this agent's
(`/v2/activity`, counted by `admittedExecutions`), it sealed and acknowledged its
own stop, and the owned child process exited cleanly. `StopUnconfirmed` names the
first that did not hold — `worker-unavailable`, `activity-unreadable`,
`activity-busy`, `execution-unbound`, `native-stop-unacknowledged`,
`child-running`, `child-exit` — on the receipt the turn publishes durably, and
`runTrial` repeats it when it demotes a deferred trial. Absence of a name means
closure was proven, and no name ever carries a path, a token, a body or an
upstream error string. `activity-busy` is reachable and must stay refusing: a
host that stopped with an execution still admitted seals that honestly, and a
worker still inside its wake is exactly what that conjunct is for.

*Evidence* asks whether this trial can be scored at all. `TerminalEvidenceMissing`
is its own vocabulary on its own receipt field, `unevidenced`: `terminal-absent`
is no frame at all for that delivery, `terminal-unbound` is a frame whose
identity, closed trace or resolved execution disagreed — including one belonging
to a different trial, which is never accepted as this trial's evidence, and
`terminal-ambiguous` is a frame whose named execution has more than one closed
trace answering to it. A trial carrying one is **unscorable for want of evidence
on a runtime that is provably quiet**, which is a different sentence from "the
runtime might still be spending" and must never be published as one. Deferred is
still never success: the demotion happens either way, under whichever name earned
it.

**And that question is asked of the trial, not of its last delivery.** Every wake
publishes its own frame, so the handle keeps a ledger — one entry per delivery, in
order, each with its own cause — and the receipt carries all of it: `evidenced`
names the wake the verdict rests on, `wakes` keeps every wake's own verdict beside
it, and `unevidenced` appears only when NO wake produced an admissible frame. One
mutable verdict per handle meant the newest delivery's answer was the trial's
answer, so a continuation that named no closed execution of its own erased the
assignment's frame — which had bound, over a closed trace, on a runtime the same
stop proved quiet — and the trial published "no terminal evidence at all", which
was false, and was demoted to an infrastructure failure for it. Selection is not
suppression: the continuation's own `terminal-unbound` is still on the receipt,
and `runTrial` names the failing wake beside the cause.

The wake that carried it is the LAST one that bound, because that is the most
recent account of this trial, and a trial-wide fault outranks every frame in it.
Those are the isolation faults, and they are exactly the ones that say what this
runtime published cannot be attributed: a frame from another trial, agent, model,
config or delivery, a foreign execution among the traces, or one execution with
two closed traces. Selecting past one of those would be attributing evidence on a
runtime that just proved it cannot be, so nothing in such a trial is scored — an
earlier admissible wake included. A wake that simply named no closed execution of
its own is the other kind: that wake is unscorable and the trial's other frames
are untouched.

**A trial legitimately closes MORE executions than it made deliveries.** A
subject that defers gets a continuation, so a deferred case runs several wakes —
and each new delivery also makes Daimon revisit the deliveries this trial has
already deferred, which it re-executes first, closing a further execution and
filing a further trace for a delivery this wake never made. A frame that carries
that whole closed history is not a trial that ran twice. The reader resolves the
trace the frame NAMES; the rest are this same trial's other wakes. Refusing on
the count instead reported `unevidenced` — nothing to score — for a healthy,
quiet, three-wake run, which is how counting stood in for a property it never
was. Nothing anywhere in this adapter may now infer a wake, a trial or a fault
from how many executions, traces or frames it can see.

The property is isolation, and it is stated rather than inferred from an arity:
every trace in the set must be this agent's and the receipt must be this agent's,
so a foreign execution is refused out of a set of three exactly as out of a set of
one; the receipt's own `execution_id` must name the resolved trace; the receipt's
`delivery_id` must be this trial's own wake's; and a frame that names no execution
resolves to nothing rather than to whichever trace came first. Two traces
answering to the named execution resolve to neither, throw, and publish
`terminal-ambiguous` — its own word, because nothing here can tell which one the
frame accounts for and the fix that calls for is upstream.

**Why the frame is not a closure proof.** It used to be one, and the predicate
failed a different way on a healthy run in each of seven investigation rounds —
`delivery-undisposed`, then `terminal-absent`, then `terminal-unbound` — while the
turn's own trace read `completed`. A terminal frame is the last delivery's
paperwork: the worker's account, published in the past, of a turn that had already
ended. Requiring it to bind was interrogating another service's inbox bookkeeping
over HTTP, and every fact it could offer comes from the same runtime that answers
`/v2/activity` live — one step later and one step staler. Child exit plus the
runtime's own seal already carry the money claim: the child is the process this
adapter owns, its exit is observed here rather than reported, and an acknowledged
stop is the runtime sealing its turn record. Nothing the frame could say adds
authority over those two, so it added none, while it did subtract scorable runs.

`delivery-undisposed` was the first retired member, for a delivery that came back
neither completed nor deferred, and `terminal-absent`/`terminal-unbound` are the
rest. They are retired rather than renamed: nothing produces them as closure
causes, the `StopUnconfirmed` vocabulary keeps the members only so a sealed report
that carries one still replays. A delivery reclaimed undisposed still refuses to
score, loudly, on the worker's own evidence (`worker/control.ts`), and after Daimon
stopped keying that reclaim on its own `stopping` latch the shape should not occur
at all — a recurrence is an upstream regression, which is precisely why it must not
be absorbed here as one more unconfirmed closure.

The fixture models production or it is a defect. Three shapes it lacked, each of
which made green tests coexist with an inert live path: `/trial/stop` is settled
**once** by whoever stops first — including the worker's own internal stop on the
final deferred delivery, which races `host.stop()` against a 5 s deadline — and
every later call replays that same value, non-acknowledgement included; the
activity projection carries one accepted-delivery record per wake, never the
single-item shape one wake produces; and an execution is **admitted for as long as
its wake runs** and gone once it closes. That third one is load-bearing now that
closure rests on the projection: a fixture whose stalled worker reported an empty
`executions` list would let a worker still inside its wake read as quiet, and the
test that a genuinely running turn is refused would prove nothing at all. A fourth
followed from continuations: a frame that carries only the wake it belongs to can
never exercise a continued trial's own closed history, so the `-history` modes
publish every trace the trial closed and the `-foreign`/`-ambiguous` pair inject
their fault only once there IS history — a fault on the first wake would be
indistinguishable from the arity it replaced. A fifth is the receipt itself:
Daimon CLEARS a receipt's `execution_id` when the subject defers the delivery,
so every reader test here used to bind through a field production never supplies
on the deferred path, and an admitted execution names the delivery ids it covers
because that projection is the only authority left once the receipt has dropped
its own.

And a sixth shape is not a shape at all but a seam: this fixture IS the worker,
so no test through it can exercise the worker's own discovery poll. Every fix to
one side of that seam passed its own suite and failed the next live run.
`childFixture(mode, frames)` therefore replays frames a REAL controller produced
against a runtime that revisits its deferred deliveries, which is the only way the
poll and the reader are exercised on one trial (`multi-wake-trial.test.ts`).

Persist at most 64 KiB of each child output stream into an exclusive 0600 diagnostic
receipt under the protected canonical control root when stopping the child. Keep
raw output out of observations, viewer messages and model inputs; it can contain
sensitive runtime details. Abrupt outer-container termination may prevent saving.

That receipt lives on storage that can die with its runtime (a training slot's
control root is tmpfs), so a pre-readiness failure also throws a carrier holding
the redacted `SubjectStartupDiagnostic` the caller persists durably. The thrown
message states the worker's own reason, never the capture path. Substitution
removes the control token, every declared environment value and the credential
file paths; an environment assignment publishes its name only; and text still
carrying credential-shaped material nobody declared is withheld rather than
published, leaving the failure class stated.

Publication is per field, not per stream. Every `{"schema":…}` line the runtime
printed publishes its schema, plus its stated message when that message redacts
cleanly and the names of the detectors that stopped it when it does not. Any
layer's own frame — the worker's or a caller bootstrap's — outranks an exit code
as the reason. A stream that cannot be published still reports which stream it
was, its byte and line counts, the frame it carried and which detector fired, so
a runtime that threw with a token in its message is distinguishable from one that
printed a blob. Whole-stream withholding is the last resort, never the first.

The failure also hands the caller one unredacted `SubjectStartupCapture` with a
suggested plain file name. The adapter never writes it anywhere itself.

The child HOME is always its verified fresh home projection, even when the numeric
container user has no passwd entry. Explicit env files cannot override HOME; never
inherit the coordinator or host home to repair native startup.

Grok children never run a local `codex sandbox` probe. The parent re-binds the
worker's persisted Grok projection receipt and requires every caller-protected
path, evaluator root and the control root to be an exact denied slot canary.
Grok children require a persisted slot freshness store: a receipt must echo this
trial's recycle nonce and exceed the last accepted generation, which then advances.
