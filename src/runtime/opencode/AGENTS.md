# OpenCode adapter

- `registration.ts` exports the built-in adapter. The runtime registry pins npm package `opencode-ai` to 1.19.6.
- `adapter.ts` validates selected features and reports unsupported lowering.
- `config.ts` lowers models, project documents, native MCP, and both authored and generic Moltnet skill roots.
- Runtime entrypoints load the compiled config explicitly and use its document and skill paths.
- `launch.ts` configures the loopback service, ACP stdio, and per-agent home and XDG paths.
- `training.ts` starts one native session per trial and resumes only that session.
- `trainingEvidence.ts` binds the pinned CLI stream to the persisted current turn. Keep tool payloads out of observations.
