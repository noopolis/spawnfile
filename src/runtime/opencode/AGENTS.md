# OpenCode adapter

- `registration.ts` exports the built-in adapter. The runtime registry pins npm package `opencode-ai` to 1.19.6.
- `adapter.ts` validates selected features and reports unsupported lowering.
- `config.ts` lowers models, project documents, native MCP, and both authored and generic Moltnet skill roots.
- Runtime entrypoints load the compiled config explicitly and use its document and skill paths.
- `launch.ts` configures the loopback service, ACP stdio, and per-agent home and XDG paths.
- OpenCode's SQLite database and Moltnet's conversation mapping share the session volume. Native credentials live in the selected login volume.
- `acpOwner.ts` keeps native ACP and HTTP on one process when a subscription agent joins Moltnet. It holds the native login lease and accepts one bridge. Keep all integrated HTTP and ACP callers in the canonical instance workspace. The raw native HTTP port trusts clients inside the container.
- `training.ts` starts one native session per trial and resumes only that session.
- `trainingEvidence.ts` checks every CLI event against the persisted current turn. Attached runs can finish before the CLI sees those events. Bind the stored session, prompt and message history before grading. Keep tool payloads out of observations.
- `subagents.ts` and `subagentsGuard.ts` lower eligible text-only helpers and restrict task calls to declared roles.

- `auth.ts`, `login.ts` and `launchScript.ts` own selected ChatGPT, SuperGrok and Copilot logins. Service, training and ACP use the same native auth store. Preserve rotated tokens in the writable login volume.
- `nativeFeatures.ts` lowers authored MCP and scoped awake Mneme access. Remote MCP negotiates HTTP then SSE in the pinned client.
