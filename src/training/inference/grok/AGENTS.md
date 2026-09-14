# Grok subscription inference
Owns the bounded saved-OAuth CLI transport. Disable tools, memory, web and
subagents; verify native OAuth and tool-free acknowledgement. Never fall back
to API keys. Keep protocol and process tests beside implementation.

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
