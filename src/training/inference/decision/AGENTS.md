# Decision transports

Owns option probability transports for grader runtimes. Consume neutral grading
contracts; never read labels, choose calibration, or provision/download models.
Public factories and prompt identity are exported through index.ts. Tests inject
fetch/providers; no network or subscription calls in tests.

Ollama matches only literal letter tokens, sums their space-prefixed variants,
and renormalizes observed mass. Absent options are accepted only if their summed
p_min bound is <= 0.01. Set absent expected options to zero and absent unexpected
options to p_min before renormalizing: this lowers p_good conservatively. No
expected-option metadata enters prompts. Missing expected metadata fails closed
when a bound is needed. Option order must remain part of caller cache identity.

Jev batches only identical projections (shared state), at most 16 questions.
identity() obtains reported model with a fixed empty-state probe before scoring;
subsequent model drift refuses results. Endpoint must serve raw temperature=1
probabilities; Paideia does not claim to inspect operator model configuration.
Teacher fallback accepts Claude/Grok subscription providers with disabled tools.

Verify: npx vitest run src/inference/decision; npx eslint src/inference/decision;
npx tsc --noEmit. Exercise missing options, bounds, first tokens, batching,
identity mismatch, cancellation and unsupported provider contracts.
