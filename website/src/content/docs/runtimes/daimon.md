---
title: Daimon
description: Daimon runtime adapter details -- generated embedded harness app, workspace layout, model auth, schedules, and Moltnet client support.
---

Daimon is an active Spawnfile runtime adapter that compiles one or more Spawnfile agents into a single generated Node.js harness app backed by the `@noopolis/daimon` package and Pi packages.

**Status:** Active

## Config Shape

The adapter emits one `pi-app.json` config for the generated app. When multiple reachable agents use `runtime: daimon`, Spawnfile groups them into the same runtime target and starts one app process for the group.

```yaml
runtime:
  name: daimon
```

Runtime options are adapter-specific. The current adapter keeps Pi orchestration inside generated artifacts, so a project author should normally only declare `runtime: daimon` plus normal Spawnfile workspace, model, schedule, resource, and Moltnet fields.

## Workspace Layout

Daimon agents are isolated under one generated workspace root:

```text
/var/lib/spawnfile/instances/daimon/pi-app/workspace/
└── agents/
    ├── mapper/
    └── reviewer/
```

Each agent directory receives its own compiled docs, skills, resources, and Moltnet client files. Shared team resources are symlinked into each concrete agent workspace while pointing at one Spawnfile-managed backing directory.

## Harness Contract

Every generated Daimon agent receives a Daimon runtime contract in addition to its authored workspace docs. The contract tells the agent:

- its current working directory is its private agent workspace
- shared resources are normal workspace paths, often symlinks to Spawnfile-managed backing directories
- file and git work must be inspected and verified before being reported as done
- Moltnet messages are coordination events first, not automatic commands
- the agent does not need to answer every Moltnet message
- Moltnet replies should be concise and use `@id` only when intentionally calling another agent's attention

Authored docs still define the agent's identity and domain behavior. The harness contract only supplies runtime operating rules that need to travel with the generated app.

## Model Mapping

The adapter maps `execution.model.primary` into the generated Daimon app config. Supported model auth paths are:

- `openai` with `auth.method: codex`
- `openai` with `auth.method: api_key`
- `anthropic` with `auth.method: api_key`
- `anthropic` with `auth.method: claude-code`
- `custom` or `local` endpoints with `auth.method: api_key` or `auth.method: none`

For Codex auth, `spawnfile run`/`spawnfile up` uses the selected auth profile to write Pi's expected OpenAI OAuth auth file into the generated Pi home. Project authors do not hand-write that file.

For Claude Code auth, `spawnfile run`/`spawnfile up` imports the selected auth profile's Claude Code credential into Pi's Anthropic auth store. Refresh-capable credentials are stored as Pi OAuth credentials; access-token-only credentials are stored as an API-key credential.

For `custom` and `local` endpoints, Spawnfile generates Pi's `models.json` under `.pi/agent/models.json` in the Daimon runtime home. `provider: local` with `auth.method: none` is the normal Ollama path; Pi still requires an API-key field for custom providers, so Spawnfile writes the upstream-documented dummy `ollama` value for unauthenticated local OpenAI-compatible endpoints.

```yaml
execution:
  model:
    primary:
      provider: local
      name: llama3.2
      auth:
        method: none
      endpoint:
        compatibility: openai
        base_url: http://host.docker.internal:11434/v1
```

## Schedule Handling

Daimon supports `schedule.kind: every` through the generated harness app. The app owns a small in-process scheduler, queues a wake when an agent is already busy, and invokes the agent again after the current turn finishes.

`schedule.kind: cron` is validated but reported as degraded for Daimon in v0.1. Use PicoClaw when a native cron store is required.

## Sandbox Handling

Daimon agents run inside the Spawnfile-managed container and start in their concrete agent workspace. That gives the adapter workspace placement and container isolation, but Pi itself is not a sandbox engine. For that reason, `execution.sandbox.mode` is reported as degraded for Daimon until the harness owns a stricter tool/resource policy.

## Skills And Resources

Skills are copied into each Daimon agent workspace using standard Spawnfile skill directories. The generated app loads skill files from the compiled workspace before invoking Pi.

Workspace resources use the same container lifecycle as other runtimes:

- `volume` resources become Spawnfile-managed backing directories
- shared team resources are visible from each agent workspace through symlinks
- `git` resources are prepared at container startup rather than during compile

MCP server declarations are validated but reported as degraded for Daimon in v0.1 because the generated app does not lower MCP servers into Pi yet.

## Subagents

When several Daimon agents are reachable in one compile graph, Spawnfile groups them into one generated app process. That is useful for local organizations, but it is not the same as native parent-owned subagent semantics. A Daimon agent with `subagents` compiles with a degraded capability report until the harness has an explicit parent-to-subagent contract.

## Moltnet

Daimon supports Moltnet as a client surface today:

- Spawnfile emits `.moltnet/config.json` in each Daimon agent workspace.
- Spawnfile installs the Moltnet skill into `.agents/skills/moltnet` and `.codex/skills/moltnet`.
- Open-mode registration token directories are persistent when a managed Moltnet server is declared.
- Spawnfile emits `MoltnetNode` configs for Daimon agents and starts `moltnet node` bridge processes next to the generated Daimon app.
- Moltnet room wakes are delivered to the generated Daimon control endpoint, which queues turns when an agent is already running.

Daimon rejects Discord, Slack, Telegram, WhatsApp, Webhook, and portable HTTP surfaces in v0.1. Those surfaces require runtime-native channel clients that the generated app does not own yet.

In dev mode, `spawnfile dev apply --agent <id>` can hot-add a Daimon agent and start its Moltnet bridge without restarting the rest of the org. Running managed Moltnet servers keep current room membership until an operator-token `moltnet apply` or server restart reconciles the copied server config.

## Activity Diagnostics

The generated Daimon app exposes a bounded `spawnfile.activity.v1` activity stream on its internal control server. Activity events are runtime diagnostics, not Moltnet messages, and they do not expose hidden reasoning. They report operational facts such as queued wakes, turn starts, runtime event types, output completions, turn completions, and failures.

```bash
spawnfile dev activity . --agent mapper --tail 20
```

The command prints JSON lines from the current activity buffer. The same control server also exposes raw endpoints inside the container:

```text
GET /spawnfile/activity
GET /spawnfile/activity/stream
GET /spawnfile/agents/<agent>/activity
GET /spawnfile/agents/<agent>/activity/stream
```

The `activity/stream` endpoints are Server-Sent Events and can be tailed with `curl -N` through `docker exec` when deeper live debugging is needed.

## What The Adapter Emits

For a Daimon runtime group:

- A generated `pi-app.json` config
- A generated `.pi/agent/models.json` when any Daimon agent uses a local or custom endpoint
- A generated `app.mjs` harness app
- A generated runtime `package.json` pinned to the Daimon and Pi package versions in `runtimes.yaml`
- Per-agent workspace directories with docs, skills, resources, and Moltnet client config

For container compilation:

- A Node.js base image
- Runtime install commands for the pinned Daimon and Pi npm packages
- Config, home, and workspace paths under `/var/lib/spawnfile/instances/daimon/pi-app`
- A start command that runs the generated app

## Example

```yaml
spawnfile_version: "0.1"
kind: agent
name: mapper

runtime:
  name: daimon

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
