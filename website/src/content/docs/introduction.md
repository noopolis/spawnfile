---
title: Introduction
description: What Spawnfile is and why it exists.
---

Spawnfile is a spec and compiler for **autonomous agent runtimes** — systems that host agents as long-lived services with markdown workspace identity.

## The Problem

Every autonomous agent runtime has its own config format. If you build an agent on OpenClaw, you can't run it on PicoClaw or TinyClaw without rewriting the config, restructuring the workspace, and re-wiring skills and MCP connections.

Your agent's identity — its personality, instructions, skills, and tool connections — gets locked into one runtime's conventions.

## The Solution

Spawnfile gives you one canonical source format. You write a `Spawnfile` manifest and a set of markdown docs. The compiler generates the runtime-native config and workspace files each target expects.

```yaml
kind: agent
name: research-assistant
runtime: openclaw

docs:
  soul: SOUL.md
  identity: IDENTITY.md
  system: AGENTS.md

skills:
  - ref: ./skills/web_search

execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
```

Change `runtime: openclaw` to `runtime: picoclaw` or `runtime: tinyclaw`, run `spawnfile compile`, and the compiler emits the right files for that runtime.

## What Spawnfile Targets

Spawnfile targets **autonomous agent runtimes** — systems that:

- Run as long-lived services or daemons
- Use a markdown workspace as a first-class agent surface
- Expose a declarative configuration surface the compiler can emit to

This is not for coding assistants, chat CLIs, or one-shot tools. Those may share conventions like `AGENTS.md`, but they are not the long-lived host runtimes that Spawnfile compiles for.

## Supported Runtimes

| Runtime | Language | Status |
|---------|----------|--------|
| [OpenClaw](https://github.com/openclaw/openclaw) | Node.js | Active |
| [PicoClaw](https://github.com/sipeed/picoclaw) | Go | Active |
| [TinyClaw](https://github.com/TinyAGI/tinyclaw) | Node.js | Active |
| [NullClaw](https://github.com/nullclaw/nullclaw) | Zig | Exploratory |
| [ZeroClaw](https://github.com/zeroclaw-labs/zeroclaw) | Rust | Exploratory |

## Open Source

Spawnfile is fully open source under the MIT license. Contributions and discussion are welcome on [GitHub](https://github.com/noopolis/spawnfile).
