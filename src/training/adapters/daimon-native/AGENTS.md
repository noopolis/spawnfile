# Native Daimon adapter

Owns one isolated Codex or brokered Grok attention trial through the public Daimon
runtime and a caller-owned local container (Grok: child-process execution only).
Never compile organizations, reconstruct identity, replace memory/tools, copy
credentials, wake production agents or invent evidence.
Project profiles and transport bootstrap remain caller-owned. Require exact launch
receipts, authenticated native activity, closed telemetry and verified containment.
Use public module indexes across child boundaries; no sibling implementation imports.
Keep adjacent tests, files below 400 lines and per-file coverage above 90 percent.

External continuations are opt-in, sourced, bounded to three deliveries and share
one trial deadline. Deferred work is never success. Preserve per-wake evidence and
aggregate usage once; cancellation must stop the owned runtime.

Grok is engine-parameterized, not a Codex fork: launch.v2 records model/effort and a
broker slot, never a credential. Daimon resolves the slot projection and verifies
the root supervisor's slot receipt; Paideia binds both by canonical digest and
requires a denied canary for every evaluator root. Codex behavior stays byte-equal.

Grok path policy: the container fixes the slot paths, so writable roots are anchored
on the projection instead of the trial runtime home. Exactly two writable roots — the
trial workspace and the trial runtime home, the only projection — and both are bound
by `projection_sha256`. The control root and every control input must sit in a slot
root the root supervisor's receipt denies to the worker uid, and no writable root may
touch one. Paideia owns exactly one subtree of that shared control root,
`paideia-trials/trial-<digest>`, created fresh per trial; nothing else there is
Paideia's to clear, and no recycle wipes on its behalf.

A failed turn still reports what it spent. The worker's HTTP reply is the only
route usage normally takes here, so a worker that dies mid-turn used to report
`usage: null` for a turn whose tool calls had already succeeded — a fabricated
zero, byte-identical to a measured one, for money really spent. The broker is a
separate process and the single sealed usage writer: it seals a failed turn's
partial usage from what its own proxy metered, and in child-process execution
this adapter shares that filesystem while `launch.broker.usageLedgerPath` names
the file. `sealed-usage.ts` reads it on the failure path only, under the
ledger's own rules — dedupe by `turn`, absence stays absence (a missing,
unreadable, malformed or empty ledger is `null`, never `0`), and no fault of its
own can fail the trial. Coverage is `partial`, never `complete`: the execution
the rows belong to never closed, so nothing here can prove the ledger holds all
of it. The short bounded poll is not politeness — sealing is the broker's
reaction to losing its client, so reading once would race the append and call it
absence.

And the worker's own last words now survive it. `child/diagnostics.ts` builds
the same redacted `SubjectStartupDiagnostic` for a death *after* readiness that
it always built for one before it, and the adapter publishes it as a
`diagnostic` observation. The protected full capture stays in the control root,
which a training slot puts on tmpfs that dies with the container; the redacted
record travels in the durable event stream instead, which is the only place an
operator can still read it afterwards. It never becomes output, a captured call
or a judge input, and a publish fault is swallowed rather than replacing a
diagnosable failure with a confusing one.

Turn transcripts are operator-only diagnostics. Daimon publishes a prompt digest
and character counts, which can detect a changed wake and never explain one, so
`transcript.ts` reads the engine's own session record inside the Daimon-owned
engine home — the same runtime home as tool receipts and closed traces — and
reports the wake text and final reply with Daimon's trace digest as the only
confirmation that they belong to that turn. It publishes as a `diagnostic`
observation at `raw` visibility: never `snapshot.output`, a captured call, a
judge input or a viewer projection, so nothing it captures can move a score.
Credential-shaped text is withheld with its detector named; digests and counts
always publish. A read that fails publishes its failure and never fails the
metered turn.

**It cannot fire for a brokered Grok turn, and every Grok launch here is
brokered** (`grokBrokerLaunchSchema`), so treat the capture as implemented for
the direct engine path and structurally silent for this adapter's real traffic.
The brokered worker writes its session tree inside its own provisioned engine
home (`root:<worker> 1771` under a `<worker>:<broker> 0710` home), not under the
slot runtime home this module reads — which nothing creates. The evaluator uid
is neither that owner nor in that group, so it cannot even traverse the home.
Every path the evaluator can read is one the worker cannot write, and the
reverse, which is the isolation working rather than a gap to patch: making the
transcript readable would mean changing an owner, a mode or a deny entry, and
instrumentation never earns that. A seam, if one is ever wanted, is owned by the
provisioner and the launcher together — never by this adapter. Until then the
silence is why a failed Grok turn can publish `output: absent` while having
really produced text, and Daimon's own redacted worker reason is the evidence to
read instead.

`grants/` binds evaluator inference grants (judges and DSPy optimizer) to Daimon's
public control client and client-config renderer behind a Paideia-owned pin.

