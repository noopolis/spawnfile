# Ollama inference
Owns the tool-free native chat transport. Endpoints and models are explicit;
never provision servers or download models. Ignore reasoning fields. Preserve
unknown cache usage. Test HTTP classification, cancellation and final content.

Completed HTTP transport is not completed generation. A truncated or malformed
response remains a protocol failure, but retain independently valid token counts,
the reported model and the configured route. Never return partial content or
reasoning as usable output; error evidence contains accounting fields only.

Optional responseSchema maps to native chat format:<schema>. Validate and snapshot
it before fetch, then independently check the complete returned JSON. Never strip
prose/fences or repair fields. A schema failure preserves measured token counts.
Known Ollama Cloud endpoints and -cloud model tags reject structured output before
fetch; HTTP400 marks the structured request unsupported without inferring which
request field the server rejected. Do not provision
models or silently ignore format when a route cannot support it.
See https://docs.ollama.com/capabilities/structured-outputs for the native contract.
