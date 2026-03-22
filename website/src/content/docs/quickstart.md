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

This creates a `Spawnfile` manifest and starter markdown docs in the current directory:

```
my-agent/
├── Spawnfile
├── IDENTITY.md
├── SOUL.md
└── AGENTS.md
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
  workspace:
    isolation: isolated
  sandbox:
    mode: workspace
```

## Write Your Agent's Identity

Edit the markdown docs:

- **SOUL.md** — personality, voice, tone
- **IDENTITY.md** — who the agent is, self-description
- **AGENTS.md** — operating instructions and conventions

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
├── runtimes/
│   └── openclaw/
│       └── agents/
│           └── my-assistant/
│               ├── openclaw.json
│               └── workspace/
│                   ├── IDENTITY.md
│                   ├── SOUL.md
│                   └── AGENTS.md
└── spawnfile-report.json
```

## What's Next

- [Write a Spawnfile](/guides/writing-a-spawnfile/) — full manifest reference
- [Agent Docs](/guides/agent-docs/) — understand document roles
- [Skills & MCP](/guides/skills-and-mcp/) — add skills and tool connections
- [Teams](/guides/teams/) — define multi-agent teams
- [Compiling](/guides/compiling/) — understand the compile pipeline
