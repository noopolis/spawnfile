# Native worker transports

Own bounded authenticated worker clients and validation of caller-provisioned
execution handles. Never launch containers, copy credentials or implement a
server. Caller lifecycle receipts own outer containment; a successful HTTP stop
is not evidence that the container or remote model work stopped.

Preserve exact trial/configuration/image/projection identity and require explicit
readiness and sandbox proofs before cognition. Keep shared evidence mounts and
observer semantics unchanged. Reject redirects, unsupported paths, malformed or
oversized responses and expired/cancelled requests. Tests use loopback servers
and non-secret tokens; they prove transport behavior, not native isolation.

Transport delivery providers reserve an expected source before `/trial/run` starts.
Poll its authenticated GET status until that exact wake and selector are armed,
then invoke publication once. Preparation, arming and publication share the real
trial deadline. Cancellation remains active through terminal receipt. The terminal
request has eight seconds of report/shutdown grace; completed evidence must carry
a valid completedAt before the original deadline, even if the timeout callback
has not run yet. Late or missing completion evidence cannot pass. Continuations require exact delivery IDs; an
initial source may use a prefix. Match terminal receipts to the actual delivery,
acceptance and observed batch. Never synthesize a wake or change its event.
The HTTP client permits the arm-status GET only with explicit transport mode;
the default direct-mode request contract stays unchanged.

A worker holding the socket open is working, not broken. Every request therefore
carries its own header and body timeouts, derived from the deadline it was given:
undici's ambient 300-second default is shorter than a legitimate turn and used to
tear down healthy workers mid-turn, destroying finished work and reporting it as
infrastructure failure. The per-request bound deliberately sits after the abort
deadline, so an over-deadline worker still expires through the abort path as
*cancelled or expired* while a dead socket still reports *transport failed*. Those
two facts are different and the run output must keep saying which one happened.
Binding the timeouts by composing the process dispatcher owns no connection pool,
so nothing here needs closing and nothing leaks per request.
