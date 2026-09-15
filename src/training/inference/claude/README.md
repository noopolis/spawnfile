# Claude subscription inference

`InferenceRequest.responseSchema` is optional JSON Schema. Paideia validates it
before any native work, passes it through `--json-schema`, and validates the
terminal `structured_output` field. It preserves string values, including newlines
and quoting, while serializing the native object to response text. Conversational
`result` text does not substitute for missing structured output.

Streaming acknowledgement must report no agent tools and an explicit empty MCP list.
When a responseSchema is requested, the pinned CLI may report its single native
StructuredOutput completion mechanism; no other tool is accepted. The native init
reports tool names, not independently verified tool definitions. Strict empty MCP
configuration and safe mode exclude custom MCP tools with that name. Schema failures retain
independently reported usage/model/route; invalid requests never launch auth or
inference. The installed Claude CLI advertises the control. Structured generation
is not yet live-verified on this route because the saved subscription is at quota.

Native references: [CLI output](https://code.claude.com/docs/en/headless) and
[structured result field](https://code.claude.com/docs/en/agent-sdk/structured-outputs).

Failure receipts distinguish unsuccessful authentication checks, caller cancellation,
malformed or missing protocol/isolation evidence, and process-owner timeouts.
Strict API401 and429 map to authentication and quota. A native API error without
a supported numeric status remains unknown, including schema-request exit1. A
native process error without a structured cause remains `unknown`; text such as
“quota” or “timeout” does not classify it. Observed terminal usage and model identity
survive rejected output and inference failures. The provider does not retry or select
fallbacks; the configured routing policy remains authoritative.
