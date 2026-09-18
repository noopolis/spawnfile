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

Closure is a conjunction of independent proofs, and each one now **names
itself**. They shared a bare `catch` and a single fixed sentence, so every
unscorable trial published the same "unconfirmed" whichever proof was missing,
and the evidence that would have identified it was in the control root a
training slot puts on tmpfs. `StopUnconfirmed` is that closed vocabulary —
`worker-unavailable`, `terminal-absent`, `terminal-unbound`, `delivery-undisposed`,
`activity-unreadable`, `activity-busy`, `execution-unbound`,
`native-stop-unacknowledged`, `child-running`, `child-exit`
— carried on the receipt the turn publishes durably, and `runTrial` repeats it
when it demotes a deferred trial, because for as long as it did not, an
unprovable closure published the subject's own "delivery blocked awaiting
external input" as the reason the machine could not score. The verdict is
unchanged: every proof is still required, absence of a name means the stop was
confirmed, and no name ever carries a path, a token, a body or an upstream
error string. `activity-busy` is reachable and must stay refusing — a host that
stopped with an execution still admitted seals that honestly.

The frame's three states are three causes, because they call for fixes in three
places. `terminal-absent` is no frame at all for the last delivery;
`terminal-unbound` is a frame whose identity or `executionClosed` disagreed; and
`delivery-undisposed` is the one a live trial actually met — every binding held,
the frame was published, its identity matched and `executionClosed` agreed, and
the delivery came back neither completed nor deferred. That last one is never
Paideia's to repair: Daimon writes it only where a stopping runtime reclaims the
delivery for restart, so the fix is upstream and the trial stays unscorable.
Collapsing them sends the next investigation to the wrong layer, which is exactly
what one over-broad name already cost.

The fixture models production or it is a defect. Two shapes it lacked, both of
which made green tests coexist with an inert live path: `/trial/stop` is settled
**once** by whoever stops first — including the worker's own internal stop on the
final deferred delivery, which races `host.stop()` against a 5 s deadline — and
every later call replays that same value, non-acknowledgement included; and the
activity projection carries one accepted-delivery record per wake, never the
single-item shape one wake produces. Neither is read by `executionClosed`, which
resolves the execution from the closed trace and requires only that `executions`
be empty — but a fixture kinder than production on the stop receipt is what let
`native-stop-unacknowledged` pass as confirmed.

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
