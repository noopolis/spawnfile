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
Preserve measured usage/model/route when rejecting completed native envelopes;
early cancellation may have no usage, which remains unknown. Never retain hidden
reasoning or substitute partial content for a completed response.
