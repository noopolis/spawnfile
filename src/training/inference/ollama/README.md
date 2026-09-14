# Ollama inference

An optional `InferenceRequest.responseSchema` is sent unchanged as the native
`/api/chat` request's `format` object after local schema validation. Only the full
completed `message.content` may satisfy it. Independent validation rejects prose,
missing/wrong/extra fields when disallowed by the schema, and duplicate JSON keys;
failures retain native usage. Each request snapshots its schema across async work.

[Ollama's structured-output contract](https://docs.ollama.com/capabilities/structured-outputs)
supports local generation and excludes Cloud. Known Cloud endpoints and `-cloud`
model tags fail before fetch; HTTP400 for a structured request is reported
as unsupported; the specific rejected request field is not inferred. No model is downloaded and no schema is silently dropped.
Actual model/server support still requires a successful native request.
