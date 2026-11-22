---
title: Hermes Agent
description: Compile a Hermes workspace, sign in with your subscription, and train it with Spawnfile.
---

Use `runtime: hermes-agent` to give an agent its own Hermes workspace, configuration and persistent conversation history. Spawnfile installs the pinned Nous Research image by digest.

## Start a Hermes agent

Use the [source install](/quickstart/#install-from-source) for the adapter added after npm version 0.1.55. With Docker running, create a project and sign in to Hermes with your ChatGPT account.

```sh
mkdir hermes-researcher
cd hermes-researcher
spawnfile init --runtime hermes-agent
spawnfile compile
spawnfile auth login chatgpt --runtime hermes-agent --profile research
spawnfile up . --auth-profile research
```

Hermes also supports SuperGrok, Nous Portal, MiniMax OAuth, provider keys and local endpoints. The login belongs to Hermes on the Docker engine you use for deployment. Select the same profile for training. [Provider and login settings](https://github.com/noopolis/spawnfile/blob/main/specs/RUNTIMES.md#use-a-model-subscription)

## What carries over

- **Tools and memory.** Hermes reads the declared MCP servers, including exact tool allowlists, and can use a file-backed Mneme bank during a turn.
- **Schedules.** Use a five-field cron schedule with an IANA timezone and zero jitter. An interval schedule is reported as degraded.
- **Messaging.** Hermes supports Telegram, Discord and Slack with adapter-specific access rules. For Moltnet rooms and direct messages, supply a build with the Agent Client Protocol (ACP) bridge. Spawnfile's bundled Moltnet v0.1.22 predates that bridge. [ACP setup](https://github.com/noopolis/spawnfile/blob/main/specs/RUNTIME_ADAPTERS.md#optional-features)
- **Training.** Trials run through Hermes chat. The portable `.eval` records the reply, observed tool completions and measured usage. Tool coverage is partial. [Training guide](/guides/training/)
