---
title: Introduction
description: What Spawnfile is and why it exists.
---

Spawnfile is a spec and compiler for **autonomous agent runtimes** -- systems that host agents as long-lived services with markdown workspace identity.

## The Problem

Every autonomous agent runtime has its own config format. OpenClaw and PicoClaw each expect different runtime config, workspace layout, skill wiring, and MCP wiring.

Your agent's identity -- its personality, instructions, skills, and tool connections -- gets locked into one runtime's conventions.

## The Solution

Spawnfile gives you one canonical source format. You write a `Spawnfile` manifest and a set of markdown docs. The compiler generates the runtime-native config and workspace files each target expects.

```yaml
spawnfile_version: "0.1"
kind: agent
name: research-assistant
runtime:
  name: openclaw

workspace:
  docs:
    identity: IDENTITY.md
    soul: SOUL.md
    system: AGENTS.md
  skills:
    - ref: ./skills/web_search

environment:
  packages:
    - id: playwright
      manager: npm
      name: playwright

execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
      auth:
        method: claude-code
```

Set `runtime.name` to an adapter-supported runtime and run `spawnfile compile`. The compiler emits that runtime's native files and reports any capability that is degraded or unsupported.

## What Spawnfile Targets

Spawnfile targets **autonomous agent runtimes** -- systems that:

- Run as long-lived services or daemons
- Use a markdown workspace as a first-class agent surface
- Expose a declarative configuration surface the compiler can emit to

This is not for coding assistants, chat CLIs, or one-shot tools. Those may share conventions like `AGENTS.md`, but they are not the long-lived host runtimes that Spawnfile compiles for.

## Supported Runtimes

| Runtime | Language | Status |
|---------|----------|--------|
| [OpenClaw](https://github.com/openclaw/openclaw) | Node.js | Active |
| [PicoClaw](https://github.com/sipeed/picoclaw) | Go | Active |
| [NullClaw](https://github.com/nullclaw/nullclaw) | Zig | Exploratory |
| [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw) | Rust | Exploratory |
| [OpenFang](https://github.com/RightNow-AI/openfang) | Rust | Exploratory |
| [Hermes Agent](https://github.com/NousResearch/hermes-agent) | Node.js | Exploratory |
| [OpenCode](https://github.com/anomalyco/opencode) | TypeScript | Exploratory |

## Open Source

Spawnfile is fully open source under the MIT license. Contributions and discussion are welcome on [GitHub](https://github.com/noopolis/spawnfile).
