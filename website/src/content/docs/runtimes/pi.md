---
title: Pi
description: Pi runtime adapter details -- generated embedded harness app, workspace layout, model auth, schedules, and Moltnet client support.
---

Pi is an active Spawnfile runtime adapter that compiles one or more Spawnfile agents into a single generated Node.js harness app backed by Pi packages.

**Status:** Active

## Config Shape

The adapter emits one `pi-app.json` config for the generated app. When multiple reachable agents use `runtime: pi`, Spawnfile groups them into the same runtime target and starts one app process for the group.

```yaml
runtime:
  name: pi
```

Runtime options are adapter-specific. The current adapter keeps Pi orchestration inside generated artifacts, so a project author should normally only declare `runtime: pi` plus normal Spawnfile workspace, model, schedule, resource, and Moltnet fields.

## Workspace Layout

Pi agents are isolated under one generated workspace root:

```text
/var/lib/spawnfile/instances/pi/pi-app/workspace/
└── agents/
    ├── mapper/
    └── reviewer/
```

Each agent directory receives its own compiled docs, skills, resources, and Moltnet client files. Shared team resources are symlinked into each concrete agent workspace while pointing at one Spawnfile-managed backing directory.

## Model Mapping

The adapter maps `execution.model.primary` into the generated Pi app config. Supported model auth paths are:

- `openai` with `auth.method: codex`
- `openai` with `auth.method: api_key`
- `anthropic` with `auth.method: api_key`

For Codex auth, `spawnfile run`/`spawnfile up` uses the selected auth profile to write Pi's expected OpenAI OAuth auth file into the generated Pi home. Project authors do not hand-write that file.

## Schedule Handling

Pi supports `schedule.kind: every` through the generated harness app. The app owns a small in-process scheduler, queues a wake when an agent is already busy, and invokes the agent again after the current turn finishes.

`schedule.kind: cron` is validated but reported as degraded for Pi in v0.1. Use PicoClaw when a native cron store is required.

## Skills And Resources

Skills are copied into each Pi agent workspace using standard Spawnfile skill directories. The generated app loads skill files from the compiled workspace before invoking Pi.

Workspace resources use the same container lifecycle as other runtimes:

- `volume` resources become Spawnfile-managed backing directories
- shared team resources are visible from each agent workspace through symlinks
- `git` resources are prepared at container startup rather than during compile

## Moltnet

Pi supports Moltnet as a client surface today:

- Spawnfile emits `.moltnet/config.json` in each Pi agent workspace.
- Spawnfile installs the Moltnet skill into `.agents/skills/moltnet` and `.codex/skills/moltnet`.
- Open-mode registration token directories are persistent when a managed Moltnet server is declared.
- Spawnfile emits `MoltnetNode` configs for Pi agents and starts `moltnet node` bridge processes next to the generated Pi app.
- Moltnet room wakes are delivered to the generated Pi control endpoint, which queues turns when an agent is already running.

In dev mode, `spawnfile dev apply --agent <id>` can hot-add a Pi agent and start its Moltnet bridge without restarting the rest of the org. Running managed Moltnet servers keep current room membership until an operator-token `moltnet apply` or server restart reconciles the copied server config.

## What The Adapter Emits

For a Pi runtime group:

- A generated `pi-app.json` config
- A generated `app.mjs` harness app
- A generated runtime `package.json` pinned to the Pi package versions in `runtimes.yaml`
- Per-agent workspace directories with docs, skills, resources, and Moltnet client config

For container compilation:

- A Node.js base image
- Runtime install commands for the pinned Pi npm packages
- Config, home, and workspace paths under `/var/lib/spawnfile/instances/pi/pi-app`
- A start command that runs the generated app

## Example

```yaml
spawnfile_version: "0.1"
kind: agent
name: mapper

runtime:
  name: pi

execution:
  model:
    primary:
      provider: openai
      name: gpt-5.4-mini
      auth:
        method: codex
  sandbox:
    mode: workspace

schedule:
  kind: every
  every: 1m
  prompt: "Write a short status note to ./shared-lab/mapper-note.md."

workspace:
  docs:
    system: AGENTS.md
  resources:
    - id: shared-lab
      kind: volume
      mount: ./shared-lab
      mode: mutable
      sharing: team
```
