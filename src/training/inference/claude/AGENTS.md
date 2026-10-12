# Saved-subscription inference

Owns tool-free Claude CLI generations for judges and the DSPy bridge. It never
runs a subject agent or chooses a fallback provider.

- Require saved first-party subscription login; discard raw auth status.
- Safe/restricted mode, no agent tools, empty MCP and a fresh nonpersistent session
  are mandatory. Only an explicit responseSchema permits the pinned CLI native
  StructuredOutput completion; any other tool or nonempty/missing MCP list fails.
- Reject sampling controls the native CLI does not expose; report native usage or unknown.
- Set explicit modelBasis: only a nonempty native model identity is provider-reported.
  A requested fallback preserves string compatibility, never actual-model evidence.
- Recognize strict terminal HTTP 429 refusals before generic exit handling. Report
  bounded model/provider metadata and only validated reset hints; never echo arbitrary
  response, stderr or process-error text. Cancellation/protocol failure takes precedence.
  Quota is not a login failure. This provider never chooses retries or fallbacks;
  the caller owns its explicit route policy.
- Unit protocol tests do not replace a successful bounded subscription generation.

An optional responseSchema goes to the native --json-schema control. Validate the
schema before auth/process work, snapshot it, require structured_output on the
successful terminal envelope and validate its serialized data independently.
Validate raw terminal JSON first so duplicate keys cannot disappear on parsing.
Keep measured usage/model/route when schema validation fails. Ordinary result prose
is never substituted for requested structured_output by default. Explicit extraction
responseJsonFence permits terminal result JSON (optionally one json fence) only
when structured_output is absent; schema and tool-isolation checks stay strict.
Installed CLI help confirms the flag. Native structured generation still needs a
successful subscription smoke once quota is available; unit fixtures do not prove it.

Classify inference failures from boundary evidence, never stderr or error prose.
Caller abort is cancellation; local parse/isolation rejection is protocol failure;
the process owner's timeout receipt identifies timeout. Other interrupted/native
errors remain unknown. An unsuccessful saved-login check is authentication failure;
a malformed successful auth response is protocol failure. Retain independently
reported model/usage on every failure, including refusal and missing isolation.
Verify through the real routed-inference boundary that authentication, protocol and
unknown errors stop the route without advancing to its configured fallback.

The native init envelope attests tool names, not tool definitions. Accept only the
literal singleton StructuredOutput with an explicit schema and empty MCP servers;
strict empty MCP config and safe mode exclude custom tools with the same name.
Never interpret completion field contents as commands. Validate the native terminal
structured_output independently. Invocation policy v2 invalidates old cache/resume
identities; a source overlay is a diagnostic, never the original training image.
Typed API-error terminals use strict401 authentication or429 quota; other/missing
statuses remain unknown even if error prose mentions authentication or transport.

Strip TYPESAFE_API_KEY from the child environment; paid decision credentials
belong only to their explicitly selected transport, never teacher processes.
