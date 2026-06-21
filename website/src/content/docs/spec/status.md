---
title: STATUS.md
description: Static and live status contract for Spawnfile projects, detached deployment records, runtime probes, and Moltnet metadata.
---

# Spawnfile Status v0.1

This page mirrors the normative status contract. The repository source of truth is `specs/STATUS.md`.

## Purpose

`spawnfile status` is read-only diagnostics over five layers:

1. Declared source graph
2. Compile report
3. Deployment record and deployment manager
4. Runtime adapter probes
5. Moltnet metadata

Status must never rewrite source, infer organization membership from live systems, update rosters, or repair drift.

## Static Mode

```bash
spawnfile status [path]
spawnfile status [path] --out <dir>
spawnfile status [path] --json
spawnfile status [path] --quiet
```

Static mode loads the authored graph and the compile report under `--out` when present. It does not inspect Docker, call runtime probes, call Moltnet, or read runtime homes. Missing compile output is `unknown` by default.

## Live Mode

```bash
spawnfile status [path] --live --deployment <name>
spawnfile status [path] --live --deployment <name> --logs
spawnfile status [path] --live --deployment <name> --watch
spawnfile status [path] --live --context <name> --deployment <name> --logs
```

Live mode reads the selected deployment record or recovers matching remote deployment labels from an explicit Docker context, then asks the manager for observations. If more than one deployment exists, `--live` requires an explicit deployment name.

Every live call is bounded by timeouts. Failed or timed-out probes produce `unknown` observations and must not hide successful observations from other layers. `--watch` repeats the same status request until interrupted, and the timeout applies per iteration.

Live status inspects Docker deployment units from records or context-recovered labels, runs adapter-owned runtime probes through the deployment manager, and checks Moltnet metadata without requesting message bodies. `--logs` is valid only with `--live` status and adds redacted Docker log-tail observations.

## Compile Report Additions

Status requires compile reports to include:

- `generated_at`
- `output_directory`
- `compile_fingerprint`
- per-runtime-instance `workspace_path`
- per-runtime-instance `node_ids`
- split internal and published port data
- sanitized Moltnet node/server plan summaries

Reports must not include secret values, generated token values, or secret-bearing Moltnet config patches.

## Deployment Records

Detached starts create records only after successful startup:

```bash
spawnfile run [path] --detach --deployment <name>
spawnfile up [path] --detach --deployment <name>
```

Records live at:

```text
.spawn/deployments/default.json
.spawn/deployments/<name>.json
```

Records store operational state: manager, Docker target, compile fingerprint, auth profile name, user env-file path, deployment units, image/container ids, hosted compile nodes, and runtime instance ids. They must not store secret values.

Same-name detached redeploys reuse the recorded target, auth profile, image tag, container name, and user env file unless the current command explicitly overrides them. The new successful detached start then replaces the record.

## Docker Targets

Docker deployments record the target actually used:

```json
{ "kind": "context", "name": "vm1", "endpoint_fingerprint": "sha256:4be91d2b0d4f3a7c99e8123400aa55cc" }
{ "kind": "host", "value": "ssh://ops@my-vm" }
```

Context targets store a hash of the resolved Docker daemon endpoint. Live status re-resolves the context and reports endpoint drift as an error instead of falling back to the local Docker daemon.

Docker status recovery is explicit and read-only:

```bash
spawnfile status . --live --recover --context vm1
spawnfile status . --live --context vm1 --deployment prod --logs
```

Recovery scans Docker labels on the selected context and builds an in-memory deployment record. Labels contain identifiers only: Spawnfile version, project slug, deployment name, unit id, and compile fingerprint. Recovery does not rewrite `.spawn/deployments/`.

## Runtime Probes

Runtime health is adapter-owned. The status core does not switch on runtime names.

Adapters receive a manager-mediated gateway that can exec inside the deployment unit, issue HTTP requests inside the unit, and inspect unit state. Probes must not assume runtime ports are reachable from the operator host. Runtimes without probes render runtime health as `unknown`.

## Moltnet Status

Moltnet status is metadata-only. It can inspect network/room presence, participants, connected/disconnected bridge state, and direct-message capability. Wake/debug lifecycle summaries are future metadata extensions and should be added only after Moltnet exposes a bounded metadata endpoint for them. Status must not request or render message bodies.

Managed Moltnet servers use the generated operator credential. External servers use the declared network auth secret. Status resolves Moltnet operator/auth secret values from the recorded deployment auth profile when one exists, then falls back to the shell environment. Missing credentials render `unknown`, never anonymous inspection.

## Exit Codes

- `0`: no `error` observations
- `1`: at least one `error` observation
- `2`: usage or input failure
