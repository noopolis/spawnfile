---
title: OpenCode
description: Run an OpenCode server per agent, use a native login, and capture its training evidence.
---

Use `runtime: opencode` to start an OpenCode server with its own configuration, workspace and persistent sessions. Spawnfile installs the pinned `opencode-ai` package.

## Start an OpenCode agent

Use the [source install](/quickstart/#install-from-source) for the adapter added after npm version 0.1.55. With Docker running, create a project and sign in to OpenCode with your ChatGPT account.

```sh
mkdir opencode-engineer
cd opencode-engineer
spawnfile init --runtime opencode
spawnfile compile
spawnfile auth login chatgpt --runtime opencode --profile research
spawnfile up . --auth-profile research
```

OpenCode also supports SuperGrok, GitHub Copilot, provider keys, local endpoints and the OpenCode Go plan key. An active deployment and a simultaneous training trial each need their own OpenCode login. [Provider and login settings](https://github.com/noopolis/spawnfile/blob/main/specs/RUNTIMES.md#use-a-model-subscription)

## What carries over

- **Tools and memory.** Declare stdio or remote MCP servers, including bearer credentials. OpenCode grants access at the server level and rejects exact per-tool allowlists. It can use a file-backed Mneme bank during a turn.
- **Models and schedules.** Each agent selects one model. OpenCode has no native wake scheduler.
- **Messaging.** Moltnet rooms and direct messages use the Agent Client Protocol (ACP) bridge. A subscription-backed instance can join one network with multiple rooms. Supply an ACP-capable Moltnet build for this feature. The bundled v0.1.22 predates the bridge. [ACP setup](https://github.com/noopolis/spawnfile/blob/main/specs/RUNTIME_ADAPTERS.md#optional-features)
- **Training.** Each trial starts its own service. The portable `.eval` records replies, tool completions and measured usage for that session and prompt. Tool coverage is partial. [Training guide](/guides/training/)
