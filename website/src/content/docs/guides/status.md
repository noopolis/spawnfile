---
title: Status
description: Inspect a Spawnfile project statically and check a detached deployment with live Docker status.
---

`spawnfile status` is the read-only operator view for a Spawnfile project. It shows what the source declares, what the compiler emitted, and, when requested, whether a detached deployment is still healthy.

## Static Status

Run status without live inspection when you want to understand the project without touching Docker, runtimes, or Moltnet:

```bash
spawnfile status .
spawnfile status . --out ./.spawn
spawnfile status . --json
spawnfile status . --quiet
```

Static status reads:

- the authored Spawnfile graph
- the compile report under `--out`, when present
- declared teams, agents, runtimes, schedules, workspace resources, packages, MCP servers, surfaces, and networks
- compiled nodes, runtime instances, capability outcomes, diagnostics, persistent mounts, and generated Moltnet plans

Static status does not inspect Docker, call runtime health endpoints, call Moltnet, or read runtime homes. Missing compile output is reported as `unknown` by default.

## Live Status

Live status starts from a deployment record created by a detached run:

```bash
spawnfile auth sync . --profile dev --env-file .env
spawnfile up . --detach --deployment dev --auth-profile dev
spawnfile status . --live --deployment dev
spawnfile status . --live --deployment dev --logs
spawnfile status . --live --deployment dev --watch
spawnfile status . --live --context gpu-4090 --deployment dev --logs
```

Live status reads the selected record under `.spawn/deployments/`, or recovers a remote deployment from Spawnfile labels when `--context <name>` is supplied, then asks the deployment manager for status. For Docker deployments, that means Spawnfile inspects the recorded or recovered Docker target and container unit instead of guessing from local containers.

The current implementation shows:

- container present, running, exited, or missing
- recorded image/container ids
- which compiled agents are hosted by each deployment unit
- adapter-owned runtime health checks, such as runtime homes, workspace paths, configs, health endpoints, and exposed schedule next-run metadata
- Moltnet metadata checks for declared networks, rooms, participants, bridge attachment, and connected/disconnected state
- optional redacted Docker log tails with `--logs`

Image id drift, container id drift, and resolved endpoint drift are reported from Docker metadata. Runtime and Moltnet probes are bounded and produce `unknown` observations when a probe is unavailable or times out, without hiding successful observations from other layers.

If a live probe times out or a runtime does not expose a probe yet, status reports `unknown` and keeps rendering the rest of the result.

## Deployment Records

Detached `run` and `up` write records only after the container starts successfully:

```text
.spawn/deployments/default.json
.spawn/deployments/<name>.json
```

The record stores operational state: deployment name, manager, Docker target, compile fingerprint, image/container ids, runtime instances, and the compiled nodes hosted by each unit. It does not store secret values.

When more than one record exists, live status requires an explicit deployment name:

```bash
spawnfile status . --live --deployment prod
```

## Remote Docker Targets

Use Docker contexts for remote machines:

```bash
docker context create vm1 --docker "host=ssh://ops@example-vm"
spawnfile up . --detach --deployment prod --context vm1 --auth-profile prod
spawnfile status . --live --deployment prod
spawnfile status . --live --context vm1 --deployment prod --logs
```

The deployment record stores the Docker context name plus a fingerprint of the resolved daemon endpoint. If the context later points somewhere else, live status reports drift instead of falling back to the local daemon.

When the local record is present, the recorded target is the target. When the local record is missing, pass `--context <name>` with `--live`; status scans Spawnfile Docker labels on that context, creates an in-memory recovered deployment record, and can still inspect containers and read redacted logs. Recovery is read-only and does not rewrite `.spawn/deployments/`.

## Logs

Logs are never shown by default because agent containers can carry prompts, model output, and leaked credentials. `--logs` is valid only with `--live` and prints a redacted Docker log tail. Spawnfile masks known required secret values and obvious token-shaped strings, and it does not provide a raw-log mode.

## Moltnet Metadata

The Moltnet status layer is metadata-only. It reads:

- network and room presence
- expected and live participants
- connected/disconnected bridge state
- direct-message enabled/disabled capability
- wake/debug lifecycle summaries are future metadata extensions, after Moltnet exposes a bounded metadata endpoint for them

Status must never read or print Moltnet message bodies. It resolves Moltnet operator/auth secret values from the recorded deployment auth profile when one exists, then falls back to the shell environment. If the required operator credential is missing, the Moltnet layer renders `unknown` instead of attempting anonymous access.

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Status ran and found no `error` observations. Warnings and unknowns still exit 0. |
| `1` | Status ran and found at least one `error` observation. |
| `2` | Usage or input failure, such as invalid flags, malformed records, or ambiguous selectors. |

Use `--quiet` in CI when you only need the summary and non-ok observations.
