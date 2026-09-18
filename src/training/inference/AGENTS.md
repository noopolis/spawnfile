# Inference Providers

Owns explicit text-generation and embedding capabilities for evaluators/optimizer.
The implemented Claude CLI route uses a saved subscription and verifies empty
native tools before accepting a nonempty successful terminal result. Embeddings
are a separate provider contract and are not supplied by this text-generation route.

- Keep this separate from native subject adapters and their tool loops.
- Subscription-backed CLI routes serve DSPy reflection/proposals and semantic
  judges. Every enabled generation route is explicit; no paid API fallback.
- Do not copy login credentials into cases or expose them through captures.
- Surface quota/authentication/unsupported-option failures; never fabricate
  temperature, seeds, structured-output guarantees, embeddings or usage.
- Inference-side tool isolation is its own capability; read-only is not tool-free.
- Add coherent provider children only when implementations exist. Keep provider
  protocol tests local and verify positive live output before claiming support.
- Test incomplete output, process cancellation, route selection and unavailable
  capabilities. Separate measured tokens, unknown values and price estimates.

Routed deadlines cover all attempts and audit writes. Reserve each remaining
route an equal share of remaining time; an attempt timeout may use the next
authored route, but caller cancellation and total budget exhaustion may not.
Audit timeout/cancellation classification comes from the actual boundary event,
not a second wall-clock comparison; real persistence failures remain failures.

`response-schema.ts` validates optional native structured-output controls before
generation and the entire completed JSON response afterward. Support synchronous
draft-07 object schemas with local references, no external fetching or custom
formats, at most 64 KiB. Reject non-finite values and duplicate response keys.
Providers retain measured usage and model identity when rejecting a completion.

Only a completed isolation-attested response that fails its requested schema is
`invalid-response`; the next authored fallback may run inside the existing budget.
Framing, unfinished envelopes, OAuth and tool-isolation failures stay terminal.
Protected failure diagnostics have finite codes and bounded final-answer text;
never retain thinking/native stderr. Route observers are awaited under the audit
deadline before fallback. Diagnostics must not enter serialized public results.

`InferenceFailureDetail` is the closed refinement `kind` cannot express: a broker
refusing a grant, a grant or realm that expired, and a broker that is simply down
all collapsed onto `unavailable`. Adapters set it where they observed the
distinction, `status` retains a provider-reported response status as a number, and
the routed wrapper carries both through so a judge classifies from typed evidence
rather than reconstructing one from `kind` or from prose.

`auth-stale` means a shared credential authority (`capabilities.credentialAuthority`,
e.g. one Daimon broker realm) is stale. Routing records the attempt, never retries a
route on that authority and may continue to an authored route on another authority.

