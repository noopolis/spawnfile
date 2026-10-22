# Native Daimon integration

Owns optional public @noopolis/daimon/pi integration. Core installation never
requires Daimon. The current route runs Daimon's Codex-backed CLI session.

- Keep saved Codex authentication external; do not seed/copy auth into runtime state.
- Record fixture tool dispatch and completion at host wrappers; built-in tools remain unobserved.
- A returned native stop acknowledgement is not independently verified quiescence.
- Native skills and cross-wake conversation continuity are unsupported in this route.
- Test public facade compatibility and failure handling; live checks must use the installed real package.
