---
title: Introduction
description: Learn how Spawnfile defines autonomous agents once and compiles their identity, tools, and configuration for supported runtimes.
---

Spawnfile is a spec and compiler for **autonomous agent runtimes** -- systems that host agents as long-lived services with markdown workspace identity.

## The Problem

Agent harnesses differ in how they read instructions, configure tools, select a model and store credentials.

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

After compile, `spawnfile status` gives a read-only view of declared and compiled state. After a detached `run` or `up`, `spawnfile status --live` inspects the recorded Docker target, runs adapter-owned runtime probes, and checks Moltnet metadata without treating live systems as source of truth.

## What Spawnfile Targets

Each adapter writes native files and describes how the harness starts. Agents in one team can choose different adapters. Register your own adapter in the root Spawnfile to add another harness. [Adapter guide](/contributing/adding-a-runtime/)

## Supported Runtimes

| Built-in harness | What Spawnfile runs |
|---|---|
| [Daimon](/runtimes/daimon/) | One host with a workspace per Daimon agent |
| [OpenClaw](/runtimes/openclaw/) | An OpenClaw gateway and workspace |
| [PicoClaw](/runtimes/picoclaw/) | A PicoClaw gateway and workspace |
| [Hermes Agent](/runtimes/hermes-agent/) | A Hermes workspace with native sessions |
| [OpenCode](/runtimes/opencode/) | An OpenCode server and workspace |

OpenFang is a research target. [Runtime overview](/runtimes/overview/)

## Open Source

Spawnfile is fully open source under the MIT license. Contributions and discussion are welcome on [GitHub](https://github.com/noopolis/spawnfile).
