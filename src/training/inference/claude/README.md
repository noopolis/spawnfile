# Claude subscription inference

`InferenceRequest.responseSchema` is optional JSON Schema. Paideia validates it
before any native work, passes it through `--json-schema`, and validates the
terminal `structured_output` field. It preserves string values, including newlines
and quoting, while serializing the native object to response text. Conversational
`result` text does not substitute for missing structured output.

Tool-free streaming acknowledgement remains required. Schema failures retain
independently reported usage/model/route; invalid requests never launch auth or
inference. The installed Claude CLI advertises the control. Structured generation
is not yet live-verified on this route because the saved subscription is at quota.

Native references: [CLI output](https://code.claude.com/docs/en/headless) and
[structured result field](https://code.claude.com/docs/en/agent-sdk/structured-outputs).
