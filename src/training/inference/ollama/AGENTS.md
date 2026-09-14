# Ollama inference
Owns the tool-free native chat transport. Endpoints and models are explicit;
never provision servers or download models. Ignore reasoning fields. Preserve
unknown cache usage. Test HTTP classification, cancellation and final content.

Completed HTTP transport is not completed generation. A truncated or malformed
response remains a protocol failure, but retain independently valid token counts,
the reported model and the configured route. Never return partial content or
reasoning as usable output; error evidence contains accounting fields only.
