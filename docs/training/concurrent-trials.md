# Concurrent trial implementation status

Implemented: `TrainingOptions.concurrency` and `train --concurrency` accept 1..8.
The default is 4 with provisioned descriptors (insufficient slots are rejected),
or the existing serial behavior when `/run/paideia/slots.json` is absent. Explicit
parallelism without descriptors fails before launching work. `slotsFile` /
`--slots-file` select another read-only descriptor file; trusted integrations may
supply `TrainingOptions.slots` directly. These are execution controls, not new YAML
fields. Comparison mode does not accept these controls.

The expected document is `{schema:"spawnfile.training-slots.v1", slots:[...]}`.
Each descriptor carries `index`, `workerUid`, opaque `roots`, and `ports:{base,count}`.
Preparation receives it as `NativePreparationContext.slot`; subject start receives
it as `SubjectStart.slot`. Preparation remains responsible for provisioning and
mapping the isolated resources. The native Daimon launch verifier binds the prepared
receipt to `roots.workspace`, `runtimeHome`, `workerHome`, `usageLedger`,
`preflightReceipt`, `controlRoot`, and the descriptor's identity and port block.
It does not rewrite digest-bound receipts or reconstruct a broker projection.

Leases remain held until stored trial closure, collection and report publication.
Unknown closure quarantines a slot for the run; zero usable slots fails explicitly.
The pool can continue serving other callers after quarantine. The current optimizer
still treats an unscorable native trial as an infrastructure failure, so automatic
optimization continuation after such a failure remains unsupported.

DSPy protocol v2 multiplexes callbacks with configured GEPA threads. Its replay IDs
use canonical request content and a per-content occurrence ordinal, saved in the
paired checkpoint. Host journals, training checkpoints and progress publication
serialize mutations. Terminal capture identity is independent of completion order.
Cancellation drains cooperative callbacks within the existing closure deadline;
noncooperative work remains explicitly incomplete and retains its resources.

Model-free tests cover four simultaneous stored trials, a fifth blocked until
closure and collection, out-of-order response correlation, quarantine, concurrent
journal/checkpoint publication and atomic callback budget reservations.

Not implemented: `maxRunRequests`, lowered per-wake request limits, reconciliation
against sealed Grok requests, and shared subject/judge/grant admission. Those cannot
be guaranteed by post-hoc token accounting. They require a compatible public runtime
limit/admission contract. No global Grok request-cap guarantee is made by this change.
The full cross-repository descriptor/launch contract and actual native-agent overlap
still require integration verification. No models or external services were used.
