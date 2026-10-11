# Decision transports

Owns option probability transports for grader runtimes. Consume neutral grading
contracts; never read labels, choose calibration, or provision/download models.
Public factories and prompt identity are exported through index.ts. Tests inject
fetch/providers; no network or subscription calls in tests.

Ollama matches only literal letter tokens, sums their space-prefixed variants,
and renormalizes option mass. Each omitted exact token variant has a p_min bound;
accept only when the sum across all omitted variants is <= 0.01. Preserve observed
mass, adding zero per omitted expected variant and p_min per omitted unexpected
variant before renormalizing; flag any omission bounded. This lowers p_good conservatively. No
expected-option metadata enters prompts. Missing expected metadata fails closed
when a bound is needed. Option order must remain part of caller cache identity.
Ollama verifies native no-truncation support through the public Ollama seam and
always sends truncate:false, shift:false and num_ctx (default 16384). Context and
refusal policy enter backend identity; prompt protocol v3 invalidates old scores.
Scoring 4xx is missing per instance; capability and other transport failures throw.

Jev batches only identical projections (shared state), at most 16 questions.
identity() obtains reported model with a fixed empty-state probe before scoring;
subsequent model drift refuses results. Endpoint must serve raw temperature=1
probabilities; Paideia does not claim to inspect operator model configuration.
Scoring HTTP 4xx responses mark exactly that request's instances missing, with a
sanitized status/detail reason capped at 200 characters. Identity HTTP errors,
5xx, connection failures, timeouts and cancellation remain thrown failures.
Noul responses accept complete true/false or yes/no key pairs; mixed pairs refuse.
Teacher fallback accepts Claude/Grok subscriptions with disabled tools or Codex
subscriptions with containment and trace-based tool refusal.
Each teacher fallback attempt returns judge-call provenance, including measured
usage, response-model basis, billing and wall time, even for invalid responses.

Verify: npx vitest run src/inference/decision; npx eslint src/inference/decision;
npx tsc --noEmit. Exercise missing options, bounds, first tokens, batching,
identity mismatch, cancellation and unsupported provider contracts.
