# Native Daimon adapter

Owns one isolated Codex or brokered Grok attention trial through the public Daimon
runtime and a caller-owned local container (Grok: child-process execution only).
Never compile organizations, reconstruct identity, replace memory/tools, copy
credentials, wake production agents or invent evidence.
Project profiles and transport bootstrap remain caller-owned. Require exact launch
receipts, authenticated native activity, closed telemetry and verified containment.
Use public module indexes across child boundaries; no sibling implementation imports.
Keep adjacent tests, files below 400 lines and per-file coverage above 90 percent.

Transport delivery is explicit in the launch receipt. The real caller-owned bridge
submits production message envelopes; the worker arms an expected source and never
synthesizes that wake. Continuations name exact external message IDs. Preserve real
delivery IDs, observed batch membership and per-wake accounting. Missing batch or
rendered allowance evidence is never reconstructed from prompt assumptions.
Task clock environment is installed inside the running worker before host creation;
Daimon owns child offset application and real-time engines. Ready/terminal frames
retain origin plus real anchor; Paideia deadlines never use task time.

External continuations are opt-in, sourced, bounded to three deliveries and share
one trial deadline. Deferred work is never success. Preserve per-wake evidence and
aggregate usage once; cancellation must stop the owned runtime. One observer-owned
trial ledger accounts for execution IDs across terminal, legacy and recovered
frames. Accounting and publication acknowledgement are separate: retain each new
usage batch unchanged until acknowledged, and serialize retries on recovery or a
later terminal frame, even if that frame contributes no new rows. Stable observation
IDs and payloads let capture deduplicate a sink that persisted before rejecting.
Terminal publication failure still fails the delivery; recovery publication failure
is swallowed on the already-failed delivery. The trial runner's existing persistence
failure policy still prevents durable success. The ledger supplies the returned trial total; the
adapter must not sum a recovered cumulative ledger into prior delivery totals.

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

The broker's second stream survives the slot too. Beside `usage.jsonl` the
broker's proxy writes `requests.jsonl`, one row per provider request with its
own `started_at`/`ended_at`, and that file is the only thing that separates a
request issued and never answered (a row with a start and no end) from one the
worker never issued (no row) — the two shapes a turn killed by its deadline
otherwise presents identically in the published event stream. `sealed-usage.ts`
reads it on the failure path beside the sealed usage, on the same bounded wait
and for the same reason, and publishes it as an operator-only `diagnostic`. It
is a timing instrument, not a transcript: an allow-list projection of timings,
counts, the model and `usage_source`, never a body, a prompt, a reply or a
credential, and a fault publishes a closed-vocabulary classification rather than
an error string that could quote the bad line. A missing or empty ledger
publishes nothing — a fabricated empty list would read as "no requests were
made", which is one of the two answers this record exists to tell apart — and an
unanswered row is never filled, normalised or dropped by the published-row
bound.

And the sealed terminal record survives it too, for the turn that never sends
one. A worker that *crashes* still produces the HTTP reply, so its failure code
and last words arrive that way. A worker that HANGS is killed by the trial
deadline: there is no reply, and the sealed terminal response — with Daimon's
observation of the MCP tool call the worker was still blocked on riding on it —
exists only inside the broker's own turn record, in a `0700` store this uid
cannot read, on a control root a training slot puts on tmpfs. Six live runs
ended exactly there: usage recovered, `output: absent`, and no account of what
the turn was waiting for. Daimon now projects that sealed response into a third
stream beside the two ledgers above, `turns.jsonl`, and `sealed-usage.ts` reads
it on the same failure path, on the same bounded poll and for the same reason
— sealing is the broker's reaction to losing its client. That path, rather than
deriving the turn record's own location, because the launch receipt names only
`usageLedgerPath`: the turn store is a `service.json` field Paideia never sees,
the record's name is a digest of a turn id Paideia does not compute, and the
store's mode denies this uid anyway. Inventing a path convention would be
claiming knowledge of broker internals that Paideia is specifically not allowed
to hold.

It publishes as an operator-only `diagnostic`, like every record beside it:
the accounting, the failure code, the diagnostic's closed
`status`/`stage`/`failure_class`, the worker's already-redacted `reason`, and
the facade's tool-call names, counts and elapsed milliseconds — an allow-list
projection, never a spread. Absence stays absence three ways and they are three
different statements: no `mcp` member means the facade never observed the turn,
`started: 0` means it observed a turn that called nothing, and no record at all
means nothing sealed. Collapsing any two of those is the mistake that kept this
instrument unreadable.

The row's `mcp` member now also carries the session's standalone GET SSE
tunnels — `tunnels: {opened, closed, delivered, open: [{openMs, delivered}]}` —
and `sealed-usage.ts` projects them under the same allow-list rule, with
`openTunnels` summed beside `outstanding`. A worker parked reading that stream
is idle in exactly the way every other artifact renders as "doing nothing", so
a turn sealed with one still open, and how long it had been open, is what tells
the two apart; `delivered` separates a tunnel carrying frames from one held
open having received nothing. Its absence is a fourth statement of the same
kind: a row sealed before Daimon observed that channel carries no `tunnels`
member, which is never read as `opened: 0`. The diagnostic sentence names it
(`GET tunnel open 428004ms/silent`, or `GET tunnels 1/1 closed`) and says
nothing at all for a row that never measured it.

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

