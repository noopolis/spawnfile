---
title: Daimon
description: Run a Daimon agent with a subscription engine, scoped Mneme memory, and independent work and dream schedules.
---

Daimon runs up to 32 agents in one organization host. Each agent gets its own workspace and an engine selected in its Spawnfile. The adapter installs an image pinned by digest.

## Config Shape

The generated `daimon-organization-runtime.json` records the agent’s engine, workspace and schedules. Use `codex` (the default), `grok` or `agy` for Antigravity.

```yaml
runtime: { name: daimon, options: { engine: codex } }
```

## Start a Daimon agent

With Spawnfile installed, Docker running and Codex signed in on the host, create a project and import its login.

```sh
spawnfile init daimon-coordinator --template daimon-public-host
cd daimon-coordinator
spawnfile compile
spawnfile auth import codex --profile research
spawnfile up . --auth-profile research
```

## Workspace Layout

The compiler writes the coordinator’s instructions to `runtimes/daimon/agents/coordinator/workspace/AGENTS.md`. Inside the container its workspace is under `/var/lib/spawnfile/instances/daimon/daimon-organization/workspace/agents/coordinator`. [Five-harness example](/guides/teams/#compile-the-homepage-team)

## Harness Contract

Every generated Daimon agent receives a Daimon runtime contract in addition to its authored workspace docs. The contract tells the agent:

- its current working directory is its private agent workspace
- shared resources are normal workspace paths, often symlinks to Spawnfile-managed backing directories
- file and git work must be inspected and verified before being reported as done
- Moltnet messages are coordination events first, not automatic commands
- the agent does not need to answer every Moltnet message
- Moltnet replies should be concise and use `@id` only when intentionally calling another agent's attention

Authored docs still define the agent's identity and domain behavior. The harness contract only supplies runtime operating rules that need to travel with the Daimon host.

## Model Mapping

Codex uses the ChatGPT subscription route with `provider: openai` and `auth.method: codex`. Grok uses `provider: xai` and `auth.method: grok`. For Antigravity, omit `execution.model` and sign into its native subscription realm. The deployed image accepts the models and reasoning settings declared by its engine contract.

## Schedule Handling

Daimon's strict v2 organization runtime supports `schedule.kind: cron`, `every`, and `disabled`. Cron uses the declared IANA timezone and standard five-field DOM/DOW semantics; every uses a durable anchor and interval. The runtime persists stable occurrence identities beside its acceptance store, coalesces downtime and busy periods to the latest eligible occurrence, and deduplicates execution across restart. Disabled schedules register no timer or wake.

## Sandbox Handling

Daimon runs in the organization container with a workspace per agent. For the Codex engine, `runtime.options.codex_policy: workspace-no-network` requests its native workspace sandbox.

## Skills And Resources

Skills are copied into each Daimon agent workspace using standard Spawnfile skill directories. Available skills depend on the selected engine. Check the capability report for the compiled agent.

Workspace resources use the same container lifecycle as other runtimes:

- `volume` resources become Spawnfile-managed backing directories
- shared team resources are visible from each agent workspace through symlinks
- `git` resources are prepared at container startup rather than during compile

MCP server declarations require an explicit nonempty `tools` allowlist. Spawnfile lowers the per-agent server authority into the organization config; Daimon verifies the listed tools at startup and exposes only those tools to real Codex/Grok cognition turns. Stdio commands must be absolute, remote bearer credentials remain environment-name references, and calls are bounded with durable per-agent receipts.

## Memory Handling

Daimon uses one durable file-backed Mneme bank per agent. The agent’s regular `schedule` controls work. A bank’s `consolidation.schedule` independently starts a fresh dream session. The pinned 0.2.26 image supports both cron and interval dreams. Isolated training trials disable scheduled dreams.

```yaml
memory:
  - id: notes
    store:
      kind: json
      path: /var/lib/spawnfile/memory/notes/events.jsonl
      persistence: { mode: durable }
    consolidation:
      mode: scheduled
      schedule: "0 3 * * *"
```

## Subagents

Daimon shares one host across its agents. A declared subagent that needs independent parent-owned execution is reported as degraded.

## Moltnet

Daimon supports Moltnet as a client surface today:

- Spawnfile emits `.moltnet/config.json` in each Daimon agent workspace.
- Spawnfile installs the Moltnet skill into `.agents/skills/moltnet` and `.codex/skills/moltnet`.
- Open-mode registration token directories are persistent when a managed Moltnet server is declared.
- Spawnfile emits `MoltnetNode` configs for Daimon agents and starts `moltnet node` bridge processes next to the Daimon host.
- Moltnet room wakes are delivered to the Daimon control endpoint, which queues turns when an agent is already running.

Daimon rejects Discord, Slack, Telegram, WhatsApp, Webhook, and portable HTTP surfaces in v0.1. Those surfaces require runtime-native channel clients that the Daimon host does not own yet.

## What The Adapter Emits

Spawnfile writes the organization runtime config, per-agent instructions and skills, a launcher, and the container files for the pinned image. The generated Dockerfile verifies the capability receipt for its architecture. It can install the other harnesses used by the same team. [Runtime registry](https://github.com/noopolis/spawnfile/blob/main/runtimes.yaml)

## Training

Codex and Grok can run isolated training trials. The current Antigravity engine lacks a verified per-agent sandbox for this use. Each stored trial writes a portable `.eval` with captured evidence and grades. [Training guide](/guides/training/)

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
