# Saved-subscription inference

Owns tool-free Claude CLI generations for judges and the DSPy bridge. It never
runs a subject agent or chooses a fallback provider.

- Require saved first-party subscription login; discard raw auth status.
- Safe/restricted mode, empty tools and MCP, fresh nonpersistent session are mandatory.
- Reject sampling controls the native CLI does not expose; report native usage or unknown.
- Set explicit modelBasis: only a nonempty native model identity is provider-reported.
  A requested fallback preserves string compatibility, never actual-model evidence.
- Unit protocol tests do not replace a successful bounded subscription generation.
