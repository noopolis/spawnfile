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
finite attempt count and overall deadline. Classified quota, transport, service
unavailability, individual attempt timeouts and attested schema-invalid answers advance to the next declared route.
Each attempt gets an equal share of the remaining deadline divided by remaining
authored attempts; unused time carries forward. The optional `attemptTimeoutMs`
is an additional cap on that share. For example, a 180-second deadline with two
attempts gives the first at most 90 seconds and leaves the rest for the fallback. A successful response,
including a poor grade, terminates routing. Authentication, native protocol violations,
operator cancellation and exhaustion of the overall deadline fail closed. Attempt receipts preserve requested and
reported models, known usage and sanitized failure classes; callers must persist
them through `observeAttempt` when they require a durable audit. Audit writes share
the route deadline; an unavailable sink fails closed before another generation.
A timed-out attempt retains usage returned synchronously when its provider handles
the abort; receipts arriving only after asynchronous cleanup remain unknown.
There is no extra cleanup wait beyond the declared route deadline.
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


Built-in invocation policies have maintained version identities independent of
provider accounting IDs. Authored judge versions include ordered primary and
fallback policy versions, so persistent judgments from an older context policy
cannot be reused even when the dataset YAML is unchanged. Optimizer route and
command checkpoint identities bind the same versions; a policy change requires
a fresh experiment. These versions describe maintained invocation behavior, not
model weights, subscription accounts or a hash of ambient user configuration.
Custom inference overrides remain responsible for truthful execution provenance.

## Decision backends

The public decision module supplies `createOllamaDecision`, `createJevDecision`
and `createTeacherDecision`. These return option probabilities and truthful model
identity; neutral grader rules own calibration, escalation and aggregation.
Ollama requires observable option logprobs; Jev requires a complete normalized
probability vector. Missing scores stay missing. Teacher mode uses the same
subscription providers (Claude/Grok empty-tool attestation or Codex containment) and never claims local-model ECE.
No adapter installs models, starts servers or silently changes billing routes.
See the [grader guide](../../docs/graders.md) for wire contracts, calibration bars,
CLI commands and Codex containment.

## Container training

Training uses one outer Docker container for the experiment coordinator, DSPy,
native subject processes and inference CLIs. Each subject trial has fresh files
and memory. Native inference runs directly inside the container with explicitly
provisioned subscription credentials and a clean home, without the operator's
host instructions, skills or configuration. This isolates the experiment from the
host; it is not separate containment between the subject and judges.

The single-container launch path is being integrated. The built-in inference
providers execute wherever their caller runs; they do not create containers.

Trusted Spawnfile integrations declare `inferenceExecutionIdentity` to bind the
exact immutable training image and invocation policy to authored judge caches,
optimizer provenance and command checkpoints. Changing that identity invalidates
reuse even with unchanged YAML. Omission preserves ambient-host identities; an
image identity never gets inferred from provider accounting IDs. The integration
must update the identity for changed execution inputs. This field records its
attestation; it does not inspect containers, credentials or ambient profiles.

Dataset resolution receives the same trusted `inferenceExecutionIdentity` as the
installed judges. A training dataset with authored model settings and its test
dataset inheriting those settings therefore share one evaluation plan. Different
execution identities, model policies or criteria still fail split validation.

A trusted `observeFailure` sink receives finite diagnostic codes plus bounded
schema-rejected final text, tied to its exact attempt. This protected audit is
awaited before fallback and shares the route deadline. Provider errors expose
these diagnostics through a non-enumerable getter only; serialized results,
attempts and checkpoints never include them. Semantic judges persist them as
evaluator-only events. Native thinking, stderr and unsafe envelopes supply no text.

## Contained Codex teachers

`createCodexInference` checks `codex login status` for a ChatGPT subscription.
It excludes API keys and ambient provider overrides, links only the selected auth
file into a clean `CODEX_HOME`, and executes in an empty disposable workspace.
Native controls use read-only sandboxing, approvals never, ephemeral sessions,
memories disabled, no MCP, web search disabled and no sandbox network enablement.
The requested model and effort are explicit; reported model and usage remain
unknown when the native stream omits them. Strict JSONL completion supplies the
final agent message. Any item other than an agent message or reasoning refuses
the attempt as `tool-call`, without retry. The capability is `contained`, distinct
from `disabled`; graders accept this containment contract. Fake-binary and event
stream tests verify the adapter contract; they do not establish live model quality.
