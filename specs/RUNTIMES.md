# Runtime Registry v0.1

This document specifies how the Spawnfile project tracks, pins, and categorizes the runtimes it targets.

---

## Purpose

The compiler emits output for specific runtimes. Those runtimes are external projects with their own release cadences. The runtime registry is the mechanism for:

- declaring which runtimes the project knows about
- pinning the version each adapter was written and tested against
- tracking which runtimes have active adapters vs which are still under research

---

## Registry File

The runtime registry is a YAML file at the repository root: `runtimes.yaml`.

### Schema

```yaml
runtimes:
  <name>:
    remote: <git clone URL>
    ref: <pinned git ref — tag, SHA, or branch>
    default_branch: <main | master>
    install:
      kind: <container_image | npm | github_release_archive | source_repo>
    status: <active | exploratory | deprecated>
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `remote` | yes | Git clone URL for the runtime repository |
| `ref` | yes | Pinned git ref — should be the latest stable release tag |
| `default_branch` | yes | The repository's primary branch name |
| `install` | no | Pinned install strategy for the verified runtime version |
| `status` | yes | Lifecycle status of this runtime in the Spawnfile project |

### Install Strategies

The `install` block declares which compiled artifact or packaged install surface Spawnfile should use for container builds at the pinned runtime version.

Supported kinds in v0.1 are:

| Kind | Required Fields | Meaning |
|------|-----------------|---------|
| `container_image` | `image`, `tag` | Install from a pinned runtime container image |
| `npm` | `package`, `version` | Install a pinned npm package version |
| `github_release_archive` | `repository`, `tag`, `binary`, `assets` | Download a pinned release archive and install a platform-specific binary |
| `source_repo` | none | Fallback install from the pinned source repo ref |

`install` is OPTIONAL at the schema level because exploratory runtimes may not yet have a verified build story. Active runtimes intended for `spawnfile build` SHOULD provide a verified install strategy.

### Status Values

| Status | Meaning |
|--------|---------|
| `active` | Has a working compiler adapter in `src/runtime/<name>/` |
| `exploratory` | Research exists in `specs/research/RUNTIME-NOTES.md` but no adapter yet |
| `deprecated` | Was previously active, adapter is no longer maintained |

### Current Active Runtimes

The active v0.1 adapters are:

| Runtime | Install Strategy | Adapter Shape |
|---------|------------------|---------------|
| `daimon` | Runtime artifact image | Noopolis-native generated harness app backed by Pi |
| `openclaw` | Runtime artifact image | Runtime-native gateway and workspace config |
| `picoclaw` | Runtime artifact image | Runtime-native gateway and workspace config |
| `pi` | npm package | Compatibility alias for the Daimon generated app path |

### Active Runtime Capability Matrix

Support levels:

- **Supported** means the adapter preserves the Spawnfile declaration in the generated runtime.
- **Degraded** means the project still compiles, but the compile report warns that runtime behavior is partial or different.
- **Rejected** means validation fails at compile-plan time.
- **Compiler-owned** means Spawnfile container/startup logic owns the behavior, then mounts or writes the artifact into the runtime workspace.

#### Core Manifest Surface

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| Adapter shape | One gateway target per agent | One gateway target per agent | One generated app target for all Daimon agents in the compile graph |
| `workspace.docs` | Supported as role files under the runtime workspace | Supported as role files under the runtime workspace | Supported per concrete agent workspace, plus a harness-owned operating contract |
| `workspace.skills` | Supported under `workspace/skills` | Supported under `workspace/skills` | Supported per concrete agent workspace |
| `workspace.resources` `volume` | Compiler-owned symlink/backing directory | Compiler-owned symlink/backing directory | Compiler-owned symlink/backing directory per concrete agent workspace |
| `workspace.resources` `git` | Compiler-owned clone/link at container startup | Compiler-owned clone/link at container startup | Compiler-owned clone/link at container startup |
| `environment.env`, `environment.secrets`, `environment.packages` | Compiler-owned container/startup behavior | Compiler-owned container/startup behavior | Compiler-owned container/startup behavior |
| `environment.mcp_servers` | Degraded through OpenClaw bridge path | Supported through PicoClaw MCP config | Degraded; not lowered into the generated Daimon app yet |
| `execution.sandbox.mode` | Supported through OpenClaw runtime/container workspace behavior | Supported through `restrict_to_workspace` and container workspace behavior | Degraded; container/workspace isolation only, Pi itself is not a sandbox engine |
| `subagents` | Degraded; routed sessions do not preserve full parent-owned semantics | Supported through PicoClaw subagent behavior | Degraded; grouped app agents do not preserve parent-owned subagent semantics |

#### Model, Schedule, And Surface Support

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| OpenAI `api_key` / `codex` auth | Supported | Supported | Supported |
| Anthropic `api_key` auth | Supported | Supported | Supported |
| Anthropic `claude-code` auth | Supported | Supported | Supported through Pi's Anthropic OAuth auth store |
| `custom` or `local` endpoint | Supported except subscription-import auth | Supported for compatible endpoint/auth pairs | Supported for `api_key` and `none` auth through generated Pi `models.json` |
| `schedule.kind: cron` | Degraded | Supported through `workspace/cron/jobs.json` | Degraded |
| `schedule.kind: every` | Degraded | Degraded | Supported by the generated app scheduler |
| `surfaces.moltnet` | Supported through generated MoltnetNode bridge | Supported through generated MoltnetNode bridge | Supported through generated MoltnetNode bridge and Daimon control endpoint |
| Discord, Telegram, WhatsApp, Slack | Supported with OpenClaw access-mode coverage | Partial: open and user allowlists; pairing and richer allowlists rejected | Rejected |
| Webhook | Parsed, not lowered by active adapters in v0.1 | Parsed, not lowered by active adapters in v0.1 | Rejected |

#### Operational Support

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| `spawnfile compile`, `build`, `run`, `up` | Supported | Supported | Supported |
| `spawnfile status --live` runtime probes | Supported | Supported | Limited; runtime health probes are not implemented yet |
| Runtime activity stream | Not normalized yet | Not normalized yet | Supported through `spawnfile.activity.v1` buffer and SSE endpoint |
| `spawnfile dev apply --agent` hot-add | Not supported in v0.1 | Not supported in v0.1 | Supported for Daimon app agents and their Moltnet bridge |
| Managed Moltnet servers and durable Moltnet state | Compiler-owned and runtime-independent | Compiler-owned and runtime-independent | Compiler-owned and runtime-independent |

---

## Version Pinning

### Why Pin

Runtime APIs, config formats, and CLI interfaces change across versions. An adapter written against openclaw v2026.2.3 may not produce valid output for v2026.3.13. Pinning makes this explicit.

### What To Pin

The `ref` field should point to the latest **stable** release tag. Stable means:

- no pre-release suffixes like `-alpha`, `-beta`, `-rc`, `-dev`
- exception: if a runtime only publishes pre-release tags, pin the most recent one and note it

### When To Bump

Bump `ref` when:

- a new stable release is available and the adapter has been verified against it
- the adapter is being updated to support new runtime features from a newer version

Do not bump `ref` speculatively. The pin represents "the adapter works at this version."

If the install artifact version differs from the source `ref`, both values should still be updated intentionally in the same review. The runtime registry is the source of truth for the exact runtime version Spawnfile supports.

### Sync Script

`scripts/runtimes.sh` reads `runtimes.yaml` and clones or checks out each runtime at its pinned ref.

```bash
./scripts/runtimes.sh              # sync all runtimes
./scripts/runtimes.sh openclaw     # sync one runtime
```

The cloned repositories live in `runtimes/` at the repo root. This directory is gitignored.

These local clones are for research, blueprint generation, and adapter development. `spawnfile compile` should not require local runtime clones on the compiler machine; container build/install should use the registry pin plus the adapter's install strategy.

In v0.1, generated Dockerfiles must not clone runtime repositories or rebuild runtime sources during image build when a verified compiled install strategy is available. `source_repo` exists as a registry/install fallback, not the intended default for active runtime builds.

---

## Adapter Lifecycle

### Adding A New Runtime

1. Add an entry to `runtimes.yaml` with `status: exploratory`
2. Run `./scripts/runtimes.sh <name>` to clone it
3. Research the runtime and add findings to `specs/research/RUNTIME-NOTES.md`
4. When ready to implement, create `src/runtime/<name>/adapter.ts` and change status to `active`

### Promoting To Active

A runtime moves from `exploratory` to `active` when:

- an adapter exists in `src/runtime/<name>/`
- the adapter passes tests against the pinned version
- the adapter is registered in `src/runtime/registry.ts`
- the runtime has a verified install strategy in `runtimes.yaml`
- the compiled output can be built and the runtime can boot at the pinned version
- if the runtime exposes a host-reachable service, a host-side smoke check succeeds against that service

### Deprecating A Runtime

A runtime moves to `deprecated` when:

- the upstream project is archived or abandoned
- the adapter is no longer maintained
- the runtime's config surface has diverged beyond reasonable adapter maintenance

Deprecated runtimes stay in the registry for reference but the compiler should warn when targeting them.

Operational discoveries about a pinned runtime version — build quirks, auth surfaces, health endpoints, container boot behavior — should be recorded in `specs/research/RUNTIME-NOTES.md`.
Current standardized communication-surface support and access-mode differences should be tracked in `SURFACES.md`.

---

## Runtime Status Probes

`spawnfile status --live` may ask runtime adapters for health observations. The status command core MUST NOT hard-code runtime names or call runtime-native CLIs directly.

An active runtime adapter may expose status probes. A probe receives:

- the deployment record
- the deployment unit that hosts the runtime instance
- the compile report runtime-instance entry
- a deployment-manager gateway
- a timeout budget

The gateway is the only live-system handle. It supports manager-mediated operations such as:

- `exec(command)` inside the deployment unit
- `httpGet(port, path)` to a port inside the deployment unit
- `inspectUnit()` for manager-level unit state

Probe rules:

- Runtime probes may check runtime homes, workspace paths, config paths, scheduler stores, health endpoints, ready endpoints, and runtime-specific daemon state.
- Probes MUST use the gateway. They MUST NOT create their own Docker client, assume published ports are reachable from the operator host, or inspect unrelated containers.
- Probes MAY run runtime-local commands through the gateway when that is the runtime's stable health surface.
- Failed and timed-out probes return `unknown` or `error` observations according to `STATUS.md`; they must not crash the status command.
- Runtimes without probes render runtime health as `unknown`.

Promoting a runtime to `active` SHOULD include at least one live status probe when the runtime exposes a stable health or readiness surface. If no stable live probe exists, the adapter must document that limitation.

---

## Runtime Activity Streams

Runtime activity is separate from Moltnet conversation state. Moltnet records messages, room lifecycle, attachment presence, and wake delivery/failure. Runtime activity records what a spawned runtime is doing while handling a wake.

When a runtime adapter exposes activity, it SHOULD normalize events to `spawnfile.activity.v1` objects with:

- `type`: a stable event type such as `agent.wake.queued`, `agent.turn.started`, `agent.runtime.event`, `agent.output.completed`, `agent.turn.completed`, or `agent.turn.failed`
- `agent_id`, `agent_slug`, and `agent_name` when the event belongs to a concrete agent
- `wake_id` and `wake_kind` when the event is tied to a wake
- `sequence` and `created_at` from the runtime activity broker
- small metadata fields such as `duration_ms`, `queue_length`, `runtime_event_type`, `output_length`, and redacted errors

Activity streams MUST NOT expose hidden reasoning. They MAY expose assistant-visible output, tool/action metadata, timing, queue state, and failures.

Pi emits a bounded in-memory activity buffer and SSE stream through its generated control server. OpenClaw and PicoClaw may later map their runtime-native session or gateway events into the same event shape; until then, their activity support is limited to status probes and deployment logs.

---

## Relationship To Other Specs

- `SPEC.md` defines the `runtime` field in manifests — the name must match a registered runtime
- `COMPILER.md` defines how runtime adapters are invoked and how output is grouped by runtime
- `CONTAINERS.md` defines how runtime container metadata is used to generate Dockerfiles
- `SURFACES.md` defines the current portable communication-surface contract and runtime support matrix
- `STATUS.md` defines the adapter-owned live status probe contract
- `research/RUNTIME-NOTES.md` contains the per-runtime research that informs adapter design
