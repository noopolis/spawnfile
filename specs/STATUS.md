# Spawnfile Status v0.1

This document defines the `spawnfile status` command and the operational metadata that detached deployments write for status inspection.

Related specs: `SPEC.md` (CLI surface), `COMPILER.md` (compile report and shared view projection), `CONTAINERS.md` (Docker deployment records and targets), `RUNTIMES.md` (adapter status probes), and `SURFACES.md` (Moltnet metadata-only status).

---

## Goal

`spawnfile status` gives an operator a read-only view of an authored organization and, when requested, the live deployment that was started from it.

It answers:

- what teams, agents, runtimes, schedules, workspace inputs, and networks are declared
- what the compiler emitted
- which detached deployment record exists for the selected deployment
- whether the recorded container unit is present and running
- whether runtime adapters can prove their instances are healthy
- whether declared Moltnet rooms and agent attachments match live metadata

Status is diagnostic. It MUST NOT rewrite Spawnfile source, update rosters from runtime state, infer organization membership from live systems, or repair drift.

---

## Command Modes

### Static Status

```bash
spawnfile status [path]
spawnfile status [path] --out <dir>
spawnfile status [path] --json
spawnfile status [path] --quiet
```

Static status MUST work offline. It loads the authored graph and the compile report under `--out` when present. It MUST NOT inspect Docker, run runtime probes, call Moltnet, or read runtime homes.

The default output includes declared and compiled status. Missing compile output is `unknown` by default.

### Live Status

```bash
spawnfile status [path] --live
spawnfile status [path] --live --deployment <name>
spawnfile status [path] --live --deployment <name> --logs
spawnfile status [path] --live --deployment <name> --watch
spawnfile status [path] --live --context <name> --deployment <name> --logs
```

Live status includes static status, then reads the selected deployment record or recovers matching remote deployment labels from an explicit Docker context, and asks the deployment manager for live observations. If more than one deployment exists, `--live` MUST require `--deployment <name>` and error with the known deployment names when omitted.

Every live operation MUST be bounded by timeouts. Failed or timed-out probes produce `unknown` observations and MUST NOT suppress successful observations from other layers.

`--watch` repeats the same status request until interrupted. Each iteration reuses the same flag validation and timeout rules; timeouts apply per iteration.

`--logs` is valid only with `--live` status. It adds redacted Docker log-tail observations for recorded or context-recovered deployment units. It is not valid in static status.

### Selectors

```bash
spawnfile status [path] --agent <id-or-slug>
spawnfile status [path] --team <id-or-slug>
spawnfile status [path] --network <id>
spawnfile status [path] --runtime <name>
```

Selector resolution is deterministic:

1. Exact compile node id, for example `agent:episode-worker`.
2. Exact manifest name or slug, for example `episode-worker`.
3. Ambiguous and unknown selectors are usage failures and MUST list valid candidates.

### Exit Codes

- `0`: status ran and produced no `error` observations. `warn` and `unknown` do not fail by default.
- `1`: status ran and produced at least one `error` observation.
- `2`: usage or input failure, such as invalid flags, malformed records, unreadable compile reports, or ambiguous selectors.

`--quiet` is intended to be CI-friendly: it prints the summary and non-ok observations while preserving the same exit-code rules.

---

## Status Model

All live and static checks normalize into observations:

```ts
type StatusSeverity = "ok" | "warn" | "error" | "unknown";

interface StatusObservation {
  details?: Record<string, unknown>;
  key: string;
  label: string;
  severity: StatusSeverity;
  message: string;
  source: "compile_report" | "declared" | "deployment" | "input" | "network" | "runtime";
}
```

Renderers MAY present observations as a tree, table, JSON envelope, or quiet summary, but the command core MUST normalize runtime-specific and manager-specific data before rendering.

Default severities:

| Observation | Severity |
|---|---|
| source validates | `ok` |
| capability degraded under warn policy | `warn` |
| compile report missing | `unknown` |
| deployment record missing with `--live` | `warn` |
| container exited | `error` |
| runtime probe unavailable | `unknown` |
| runtime health endpoint fails | `error` |
| Moltnet agent disconnected | `warn` |
| Moltnet room missing | `error` |
| recorded manager target inspection failed | `error` |
| recorded manager target endpoint fingerprint drift | `error` |

Status must never fall back to the local Docker daemon when the recorded manager target is missing, unreachable, or fingerprint-drifted.

---

## Compile Report Requirements

Status depends on compile reports being stable enough to compare declared, compiled, and deployed state. The compile report MUST include:

- `generated_at`: UTC timestamp for stale-compile diagnostics.
- `output_directory`: absolute path to the output root used by the compile.
- `compile_fingerprint`: stable fingerprint for the compile output.
- per-runtime-instance `workspace_path`: final runtime workspace path.
- per-runtime-instance `node_ids`: compile `NodeReport.id` values served by that instance.
- split port data: internal runtime ports separate from published host ports.
- sanitized Moltnet node/server plan summaries: network ids, room ids, server mode, listen/published ports, and auth mode names.

The report MUST NOT include secret values, generated token values, or secret-bearing Moltnet config patches. It may include secret names, required-secret keys, paths, ids, and capability outcomes.

---

## Deployment Records

Detached starts create deployment records:

```bash
spawnfile run [path] --detach --deployment <name>
spawnfile up [path] --detach --deployment <name>
```

The default deployment name is `default`. Deployment names MUST be kebab-case slugs and map to:

```text
.spawn/deployments/default.json
.spawn/deployments/<name>.json
```

Deployments are operational records, not authored source. They are written only after detached start succeeds. A later detached start with the same deployment name reuses compatible recorded settings unless explicit flags override them, then replaces the record atomically after the new start succeeds.

Minimum record:

```json
{
  "version": "spawnfile.deployment.v1",
  "project_root": "/abs/path/to/project",
  "output_directory": "/abs/path/to/project/.spawn",
  "manager": "docker",
  "target": {
    "kind": "context",
    "name": "vm1",
    "endpoint_fingerprint": "sha256:4be91d2b0d4f3a7c99e8123400aa55cc"
  },
  "created_at": "2026-06-10T00:00:00.000Z",
  "compile_fingerprint": "sf1:9c4e2b...",
  "auth_profile": "prod",
  "env_file": null,
  "units": [
    {
      "id": "default",
      "kind": "container",
      "image_tag": "project:latest",
      "image_id": "sha256:71f3a2...",
      "container_name": "project-latest",
      "container_id": "b9d41c7e02aa",
      "contains": [
        { "kind": "agent", "id": "agent:coordinator" }
      ],
      "runtime_instances": ["agent-coordinator"]
    }
  ]
}
```

Rules:

- A failed detached start MUST NOT leave a record.
- Records MUST NOT contain secret values.
- `auth_profile` is a local profile name only.
- `env_file` records only a user-provided env file path. Generated support env files are regenerated each deploy and never recorded.
- `contains` values use compile `NodeReport.id` values.
- `runtime_instances` values use compile runtime-instance ids, not runtime names.
- Static `spawnfile status` lists deployment records; live status adds liveness checks for the selected record.
- Stopped or missing recorded units are drift observations. Status MUST NOT delete records.

### Redeploy

For same-name detached redeploys, Spawnfile reuses the recorded target, auth profile, image tag, container name, and user env file unless the current command explicitly overrides them.

---

## Docker Targets And Recovery

The first deployment manager is `docker`.

`run --detach` and `up --detach` accept `--context <name>` and record a resolved Docker context target. If no context is passed, Spawnfile records `DOCKER_HOST` as a host target when present, otherwise it records the resolved `default` Docker context.

Current target forms:

```json
{ "kind": "context", "name": "vm1", "endpoint_fingerprint": "sha256:4be91d2b0d4f3a7c99e8123400aa55cc" }
{ "kind": "host", "value": "ssh://ops@my-vm" }
```

`endpoint_fingerprint` is a hash of the resolved Docker context endpoint. Status re-resolves the context and reports endpoint drift as an `error`. Spawnfile must not fall back to the local Docker daemon when a recorded target fails.

Without `--context`, live status uses local deployment records and the recorded target is the only target. With `--context <name>`, live status treats that context as a remote deployment source and recovers containers from Spawnfile labels. `--recover` is an explicit alias for that context-backed path and remains read-only:

```bash
spawnfile status . --live --recover --context vm1
spawnfile status . --live --context vm1 --deployment prod --logs
```

Context recovery matches containers by Docker labels:

```text
com.spawnfile.version=0.1
com.spawnfile.project=<project-slug>
com.spawnfile.deployment=<deployment-name>
com.spawnfile.unit=<unit-id>
com.spawnfile.compile_fingerprint=<compile-fingerprint>
```

Labels MUST contain identifiers only. They MUST NOT contain absolute paths, usernames, hostnames, env values, auth profile names, or secret values. If multiple containers match the same recovered deployment unit, recovery MUST error instead of guessing. Recovery MUST NOT rewrite the deployment record.

Logs are never shown by default. `--logs` may show a redacted tail in `details.log_tail`.
Known required-secret values and obvious token-shaped strings are masked. There is no raw-log status mode.

---

## Runtime Probe Contract

Runtime health is adapter-owned. The status command core MUST NOT switch on runtime names.

Adapters may expose status probes that receive only a manager-mediated gateway:

```ts
interface DeploymentProbeGateway {
  exec(command: string[]): Promise<ProbeExecResult>;
  httpGet(port: number, path: string): Promise<ProbeHttpResult>;
  inspectUnit(): Promise<UnitInspection>;
}

interface RuntimeStatusProbeContext {
  deployment: DeploymentRecord;
  unit: DeploymentUnitRecord;
  instance: ContainerRuntimeInstanceReport;
  manager: DeploymentProbeGateway;
  timeoutMs: number;
}
```

Probe rules:

- Probes run through the deployment manager, for example `docker --context <ctx> exec`.
- Probes MUST NOT assume runtime ports are reachable from the operator host.
- Probes MAY execute runtime-local commands through `exec`, but the status core MUST NOT call runtime-native CLIs directly.
- Probe failures and timeouts become observations, not command crashes.
- Runtimes without probes render `unknown` for runtime health.

---

## Moltnet Status

Moltnet status is metadata-only.

Managed Moltnet servers are inspected through the deployment manager using the generated server plan. External Moltnet servers are inspected through the declared `server.url` only.

Status uses an internal HTTP client, never the Moltnet CLI. The Moltnet CLI is agent-identity oriented; `spawnfile status` needs operator diagnostics.

Auth rules:

- Managed servers use the operator credential named by the generated server plan.
- External servers use the declared network auth secret. Status resolves Moltnet operator/auth secret values from the recorded deployment auth profile when one exists, then falls back to the shell environment.
- Missing auth renders the network layer `unknown`; status MUST NOT attempt anonymous inspection.

Allowed metadata:

- network id/name and server mode
- auth mode and public read/write policy metadata
- declared rooms and live room presence
- expected members and live participants
- connected/disconnected bridge state
- direct-message enabled/disabled state

Status MUST NOT request or render Moltnet message bodies.

---

## Verification Requirements

Feature tests must cover behavior, not just lines.

Current scope:

- static status from source only
- static status with and without compile report
- `--out`, `--json`, `--quiet`, selectors, and exit codes
- status declared layer reusing the shared organization view projection
- compile report additions
- deployment record parser and atomic write lifecycle
- `run --detach` and `up --detach` record creation only after successful start
- same-name detached starts reuse compatible recorded settings and replace records after success
- Docker context and host target recording
- Docker labels contain identifiers only
- context recovery scans label-bearing containers and errors on ambiguous recovered units
- endpoint fingerprint drift reports `error` and does not fall back to the local daemon
- probe timeout/failure normalization
- runtime probes through adapter-owned probes and no runtime-name switch in the status core
- Moltnet metadata-only inspection, no message bodies, and no anonymous fallback when auth is required
- `--logs` live-only validation, redaction, and failure normalization
- `--watch` repeated refresh behavior
- runtime-exposed schedule next-run details
- live E2E with isolated ports: compile, detached start, `status --live --json`, runtime health, managed Moltnet metadata, plus direct workspace-resource link checks

Future scope:
- bounded Moltnet lifecycle, wake, and debug metadata when Moltnet exposes a metadata endpoint for them
- disconnected bridge drift based on bounded Moltnet lifecycle metadata

Live E2E must not reuse a developer's active Moltnet port.
