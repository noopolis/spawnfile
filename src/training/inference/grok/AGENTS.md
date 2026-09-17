# Grok subscription and broker-grant inference
Owns the bounded Grok CLI transport (`cli.ts`) in two authentication modes:
saved desktop OAuth (`provider.ts`) and Daimon broker inference grants (`broker.ts`).
Disable tools, memory, web and subagents; verify the mode's native auth source and
tool-free acknowledgement. Never fall back to API keys or between modes. Keep protocol and process tests beside implementation.

Grok 1.0.30 interprets an empty `--tools` as its default toolset. Express an
empty set with `--tools read_file --disallowed-tools read_file,search_tool,use_tool`:
the nonempty allowlist disables default injection, and the denylist removes its
one entry plus Grok's lazy discovery pair. Keep `--deny '*'` as defense in depth.
The native init must still acknowledge empty tools/MCP servers; abort the owned
process immediately if it does not. Permissions alone are not tool isolation.

Use `--verbatim` and the exact caller system override for inline judge prompts.
Always pass `--reasoning-effort`: the provider option accepts low, medium, high
or xhigh and defaults explicitly to medium. Never inherit a personal CLI reasoning
preference; reject invalid controls before starting the native process.
Preserve measured usage/model/route when rejecting completed native envelopes;
early cancellation may have no usage, which remains unknown. Never retain hidden
reasoning or substitute partial content for a completed response.

Inference uses `--permission-mode dontAsk --no-plan`: a tool-free completion is
not a planning session. Neither flag promises raw prompt isolation: the CLI can
still append built-in browser rules and workflow reminders in a clean home.
System override remains exact; native user-context envelopes are separate.

An optional responseSchema is sent with `--json-schema` while retaining explicit
streaming-messages-json output. Validate the schema before launching and the whole
completed JSON after tool/OAuth attestation; retain measured usage on rejection.
Never extract a JSON substring or treat a native schema flag as validation proof.

Keep finite refusal diagnostics for native envelope guards without response text.
Only after the full decode succeeds may schema rejection retain the bounded final
answer as protected evidence. The old generic `protocol` category is never
retroactively reclassified from usage counts or an empty saved response.

## Broker grants (`grok-broker`)

`broker.ts` never touches a desktop login. `grant-pool.ts` holds one grant per
concurrent lane (default two per model/effort/purpose), reuses it sequentially and
renews it before the TTL margin would cut the next call short or before its request
or token ceiling. It never holds more than the broker's live-grant cap and queues
with backoff on `grant_limit` until the caller's signal ends the wait. Any failed
call, idle lane or pool close releases the grant; a broker that never answers is
bounded by the caller's signal and a late grant is released.

`grant-home.ts` renders the client config through the authority, refuses bytes whose
sha256 differs from the independent pin, and writes them into a fresh per-call
GROK_HOME (0700) under the container-provisioned root. The child environment is
exactly PATH, HOME, TMPDIR, GROK_HOME and the grant env key; the token never enters
argv, config, logs, failures or the parent environment. The CLI runs `--model
daimon-inference-grok` with the same isolation flags. Init must report
`apiKeySource: "user"` and that model id; subscription mode still requires `oauth`.
The response model is the grant's broker-enforced catalog model; usage is labelled
`grok-broker-grant.result.usage.lower-bound` on route `grok-broker-grant`. Budgets
use this Paideia usage, not the broker inference ledger.

The plain-string 401 `Unauthorized (401) from http://127.0.0.1:<port>/v1/chat/completions:
auth_stale` and a grant refused `auth_stale` are `auth-stale`: routing skips every later
route on the same credential authority but may still use an authored non-broker fallback.

