# Transport wake observation

Own expected transport sources, route acceptance binding and observed inbox batch
evidence. Use index.ts across module boundaries. Daimon's public parser and host
own request semantics, dispatch, timestamps, batching and allowances; never
rebuild a wake, read private runtime state or equate a budget poll with a rendered
model context. Only deliveries received after arming may bind. Retried old
acceptances cannot become a new wake. Timeouts remain in the parent controller.

Admission starts before awaiting the host. Terminal sealing requires no pending
admissions and an unchanged generation across control reads and evidence collection.
Retain cumulative selected receipts, execution histories and observed batches;
validate all their closed traces and usage before success. Historical snapshots
must not mutate earlier wake frames. Schema rejections come directly from the host.
Reconcile every retained terminal trace from the fresh trial home with those
execution owners. An attempt missed between polls still fails if failed or
unattributed; a later successful retry cannot remove it from validation.
Sealing also closes new native admission until the next arm. Permit only identities
actually accepted with matching returned agent/delivery through to native retry
semantics; a queue decided by a conflicting identity never grants that permission.
The wrapper's lifecycle refusal is HTTP 409 `transport_admission_sealed`, not a
fabricated Daimon acceptance response, and precedes schema checks while sealed.

Verify source refusals, HTTP authentication, verbatim forwarding, batch identity,
unmatched deadlines and deferred continuations with adjacent tests. Keep missing
public observations explicit and never infer an execution from trace count here.
HTTP conformance imports the optional installed runtime's real public parser,
digest and rejection API. Test process wiring separately from private downstream
clock stripping, which this package cannot assert through public exports.
