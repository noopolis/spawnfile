# Hermes Agent adapter

- `registration.ts` exposes the built-in registration. `install.ts` pins the upstream image and checks its revision.
- `adapter.ts` lowers one agent to a separate Hermes home and a mounted workspace. `config.ts` selects the native model route and tool permissions.
- `instance.ts` supplies the per-agent environment for Moltnet's native ACP subprocess. Hermes discovers authored skills in `workspace/skills` and the pinned Moltnet installer writes into `workspace/.agents/skills`.
- `training.ts` binds each trial to its native session. `trainingEvents.ts` decodes the pinned CLI's structured output.
- The foreground native gateway uses its private loopback transport. Keep unattended approvals on deny and use the writable workspace as the file-tool write root.
- Model lowering supports OpenAI, Anthropic, OpenRouter, and explicit compatible endpoints. A local OpenAI-compatible endpoint can run without credentials. Compose runtime credentials through the compiler's protected config binding.
- `auth.ts`, `authStore.ts`, `authLaunch.ts` and `login.ts` own native ChatGPT, SuperGrok, Nous Portal and MiniMax credentials. Gateway, ACP and training validate the same selected store. Keep credentials and refreshes outside compiled output.
- `surfaces.ts` owns Telegram, Discord and Slack access checks, structured token bindings and removal of team-wide chat variables. Reject any declaration that the native platform cannot enforce.
- `nativeFeatures.ts` lowers authored MCP and scoped awake Mneme access. `schedules.ts` and `cronBootstrap.ts` reconcile the declared cron job under the gateway's scheduler.
- Verify native routing and access rules before marking a declared capability supported.
- Record only lifecycle events bound to the current native session and turn. Hermes reports cumulative token counts, so trained turns use confirmed differences between adjacent snapshots.
- `workspaceAssets.ts` and `workspaceReconciler.ts` seed declared docs, skills and Moltnet files from the immutable image into a reused workspace. Startup preserves local changes and never follows workspace symlinks.
- `sessionStore.ts` gives each deployed Hermes instance its own native session volume. Launches point `HERMES_HOME` at the mounted profile so stock SQLite, WAL and transcript recovery files stay together. Its fixed links reach the current compiler config and the separate OAuth and cron stores.
