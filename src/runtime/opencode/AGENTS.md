# OpenCode adapter

- `registration.ts` exports the built-in adapter. The runtime registry pins npm package `opencode-ai` to 1.19.6.
- `adapter.ts` validates selected features and reports unsupported lowering.
- `config.ts` lowers models, project documents, native MCP, and both authored and generic Moltnet skill roots.
- Runtime entrypoints load the compiled config explicitly and use its document and skill paths.
- `launch.ts` configures the loopback service, ACP stdio, and per-agent home and XDG paths.
- `training.ts` starts one native session per trial and resumes only that session.
- `trainingEvidence.ts` binds the pinned CLI stream to the persisted current turn. Keep tool payloads out of observations.

- `auth.ts`, `login.ts` and `launchScript.ts` own selected ChatGPT, SuperGrok and Copilot logins. Service, training and ACP use the same native auth store. Preserve rotated tokens in the writable login volume.
- `nativeFeatures.ts` lowers authored MCP and scoped awake Mneme access. Remote MCP negotiates HTTP then SSE in the pinned client.
