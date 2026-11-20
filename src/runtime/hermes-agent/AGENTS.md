# Hermes Agent adapter

- `registration.ts` exposes the built-in registration. `install.ts` pins the upstream image and checks its revision.
- `adapter.ts` lowers one agent to a separate Hermes home and a mounted workspace. `config.ts` selects the native model route and tool permissions.
- `instance.ts` supplies the per-agent environment for Moltnet's native ACP subprocess. Hermes discovers authored skills in `workspace/skills` and the pinned Moltnet installer writes into `workspace/.agents/skills`.
- `training.ts` binds each trial to its native session. `trainingEvents.ts` decodes the pinned CLI's structured output.
- The foreground native gateway uses its private loopback transport. Keep unattended approvals on deny and use the writable workspace as the file-tool write root.
- Model lowering supports OpenAI, Anthropic, OpenRouter, and explicit compatible endpoints. A local OpenAI-compatible endpoint can run without credentials. Compose runtime credentials through the compiler's protected config binding.
- Spawnfile schedules, memory banks, authored MCP, subagents, public surfaces, model fallbacks, and external CLI credential imports are unsupported.
- Record only lifecycle events bound to the current native session and turn. Hermes reports cumulative token counts, so trained turns use confirmed differences between adjacent snapshots.
