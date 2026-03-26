---
title: Quickstart
description: Install Spawnfile and compile your first agent in 5 minutes.
---

## Install

```bash
nvm use
npm install
npm run build
npm link
```

Or use the bootstrap script:

```bash
./scripts/install.sh
```

Verify:

```bash
spawnfile --help
```

## Create an Agent

```bash
spawnfile init
```

This creates a `Spawnfile` manifest and starter markdown docs in the current directory. The generated docs (SOUL.md, IDENTITY.md, AGENTS.md) are tailored to the selected runtime's personality and capabilities:

```
my-agent/
|-- Spawnfile
|-- IDENTITY.md
|-- SOUL.md
\-- AGENTS.md
```

To scaffold for a specific runtime:

```bash
spawnfile init --runtime tinyclaw
```

## Edit the Spawnfile

Open `Spawnfile` and set your agent's name and runtime:

```yaml
spawnfile_version: "0.1"
kind: agent
name: my-assistant
runtime: openclaw

docs:
  identity: IDENTITY.md
  soul: SOUL.md
  system: AGENTS.md

execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
      auth:
        method: claude-code
  workspace:
    isolation: isolated
  sandbox:
    mode: workspace
```

## Write Your Agent's Identity

Edit the markdown docs:

- **SOUL.md** -- personality, voice, tone
- **IDENTITY.md** -- who the agent is, self-description
- **AGENTS.md** -- operating instructions and conventions

These are plain markdown files. The runtime loads them into the agent's context.

## Validate

```bash
spawnfile validate
```

This checks the manifest schema, file references, and graph structure without compiling.

## Compile

```bash
spawnfile compile --out ./dist
```

The compiler emits runtime-native config and workspace files:

```
dist/
|-- runtimes/
|   \-- openclaw/
|       \-- agents/
|           \-- my-assistant/
|               |-- openclaw.json
|               \-- workspace/
|                   |-- IDENTITY.md
|                   |-- SOUL.md
|                   \-- AGENTS.md
\-- spawnfile-report.json
```

## Build and Run

Once compiled, you can build a Docker image and run it with auth:

```bash
spawnfile auth sync --profile dev --env-file .env
spawnfile build --tag my-assistant
spawnfile run --tag my-assistant --auth-profile dev
```

See [Docker Packaging](/guides/docker/) for the full build and auth workflow.

## What's Next

- [Write a Spawnfile](/guides/writing-a-spawnfile/) -- full manifest reference
- [Agent Docs](/guides/agent-docs/) -- understand document roles
- [Skills & MCP](/guides/skills-and-mcp/) -- add skills and tool connections
- [Teams](/guides/teams/) -- define multi-agent teams
- [Compiling](/guides/compiling/) -- understand the compile pipeline
- [Docker Packaging](/guides/docker/) -- build and run containers with auth
