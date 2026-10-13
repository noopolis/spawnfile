# Concurrent trial implementation status

Implemented: `TrainingOptions.concurrency` and `train --concurrency` accept 1..8.
The default is the provisioned descriptor count (Spawnfile defaults to 4),
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

Paideia does not accept a runtime-neutral `maxRunRequests` option: post-hoc token
accounting cannot enforce model admission. Brokered Spawnfile training configures
`broker.maxRunRequests` (default 1000) in Daimon's shared proxy instead. That cap
covers subject, judge and optimizer requests routed through the broker, including
credential retries, and survives slot recycle and broker restart. Spawnfile retains
the budget in a dedicated volume keyed by the run's output directory across container
replacement. Capped containers set `PAIDEIA_MODEL_REQUEST_CAP=broker`; Paideia
rejects non-broker judge/optimizer routes, fallbacks and legacy defaults before
provider construction. Native graders are also rejected because their model routes
do not share broker admission. Uncapped runs retain the existing provider choices.
The launcher does not inject optimizer concurrency controls into comparisons;
comparison execution remains serial.
The full cross-repository descriptor/launch contract and actual native-agent overlap
still require integration verification. No models or external services were used.
