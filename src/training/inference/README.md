# Subscription inference

`createClaudeInference()` supplies tool-free saved-subscription generations for
judges and optimizer proposals. It verifies the native CLI's empty tool list,
rejects missing/unsuccessful terminal output, and reports measured usage or unknown
counters. Temperature and seed are unsupported; no API/model fallback is selected.

Claude safe/restricted mode disables ordinary user/project instructions, skills,
hooks and settings. **Admin-managed policy still applies** under the native CLI's
documented contract. An experiment must treat that host policy as part of its
inference environment; Paideia does not claim to override or inspect managed policy.

Authentication stays in the saved native subscription mechanism. Raw auth-status
account details are discarded, and API/provider environment overrides are removed.
Generation runs in a fresh disposable directory with no subject workspace mounted.

## Explicit fallback routes

`createRoutedInference` consumes ordered `{ provider, model }` routes with a
finite attempt count and deadline. Only classified quota, transport and service
unavailability advance to the next declared route. A successful response,
including a poor grade, terminates routing. Authentication, malformed output,
cancellation and timeouts fail closed. Attempt receipts preserve requested and
reported models, known usage and sanitized failure classes; callers must persist
them through `observeAttempt` when they require a durable audit. Audit writes share
the route deadline; an unavailable sink fails closed before another generation.
Each listed route is tried at most once; explicitly repeat a route to budget a retry.
Routed providers reject sampling overrides; native Ollama controls are available
when using its provider directly.

`createGrokInference` uses saved OAuth and requires native acknowledgement of an
empty tool set. `createOllamaInference` uses an explicitly configured native
`/api/chat` endpoint, supports temperature/seed and never treats reasoning-only
output as an answer. Neither route downloads models or manages authentication.
The common provider interface also accepts explicitly installed API providers;
there is no implicit paid fallback. These transport adapters have deterministic
protocol tests; live availability remains a separate environment preflight.

Cache identities belong to the evaluation configuration: include the exact
rendered prompt, criterion, model, route policy and provider endpoint. An attempt
UUID is audit identity, not a reusable cache key. Local exact-result reuse and a
provider's prompt-prefix cache are different; neither inferred cache savings nor
unreported usage may be counted as measured tokens.
