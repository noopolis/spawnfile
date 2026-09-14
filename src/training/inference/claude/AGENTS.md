# Saved-subscription inference

Owns tool-free Claude CLI generations for judges and the DSPy bridge. It never
runs a subject agent or chooses a fallback provider.

- Require saved first-party subscription login; discard raw auth status.
- Safe/restricted mode, empty tools and MCP, fresh nonpersistent session are mandatory.
- Reject sampling controls the native CLI does not expose; report native usage or unknown.
- Set explicit modelBasis: only a nonempty native model identity is provider-reported.
  A requested fallback preserves string compatibility, never actual-model evidence.
- Recognize strict terminal HTTP 429 refusals before generic exit handling. Report
  bounded model/provider metadata and only validated reset hints; never echo arbitrary
  response, stderr or process-error text. Cancellation/protocol failure takes precedence.
  Quota is not a login failure and never triggers retry or provider fallback.
- Unit protocol tests do not replace a successful bounded subscription generation.

An optional responseSchema goes to the native --json-schema control. Validate the
schema before auth/process work, snapshot it, require structured_output on the
successful terminal envelope and validate its serialized data independently.
Validate raw terminal JSON first so duplicate keys cannot disappear on parsing.
Keep measured usage/model/route when schema validation fails. Ordinary result prose
is never substituted for requested structured_output; tool isolation stays strict.
Installed CLI help confirms the flag. Native structured generation still needs a
successful subscription smoke once quota is available; unit fixtures do not prove it.
