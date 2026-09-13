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
