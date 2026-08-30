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
| `daimon` | Immutable generic runtime image | One public `noopolis.daimon.organization-runtime.v1` host for up to 32 agents |
| `openclaw` | Runtime artifact image | Runtime-native gateway and workspace config |
| `picoclaw` | Runtime artifact image | Runtime-native gateway and workspace config |
| `pi` | npm package | Legacy Spawnfile-generated Pi application path |

### Active Runtime Capability Matrix

Support levels:

- **Supported** means the adapter preserves the Spawnfile declaration in the generated runtime.
- **Degraded** means the project still compiles, but the compile report warns that runtime behavior is partial or different.
- **Rejected** means validation fails at compile-plan time.
- **Compiler-owned** means Spawnfile container/startup logic owns the behavior, then mounts or writes the artifact into the runtime workspace.

#### Core Manifest Surface

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| Adapter shape | One gateway target per agent | One gateway target per agent | One public Daimon organization host target for all Daimon agents (maximum 32) |
| `workspace.docs` | Supported as role files under the runtime workspace | Supported as role files under the runtime workspace | Supported per concrete agent workspace, plus a harness-owned operating contract |
| `workspace.skills` | Supported under `workspace/skills` | Supported under `workspace/skills` | Supported per concrete agent workspace |
| `workspace.resources` `volume` | Compiler-owned symlink/backing directory | Compiler-owned symlink/backing directory | Compiler-owned symlink/backing directory per concrete agent workspace |
| `workspace.resources` `git` | Compiler-owned clone/link at container startup | Compiler-owned clone/link at container startup | Compiler-owned clone/link at container startup |
| `environment.env`, `environment.secrets`, `environment.packages` | Compiler-owned container/startup behavior | Compiler-owned container/startup behavior | Compiler-owned container/startup behavior |
| `environment.mcp_servers` | Supported through OpenClaw `mcp.servers` config | Supported through PicoClaw MCP config | Supported for explicit nonempty tool allowlists; stdio commands must be absolute and remote bearer secrets remain env-name references |
| `memory` | Supported for file-backed banks through compiler-generated Mneme MCP servers in awake mode | Supported for file-backed banks through compiler-generated Mneme MCP servers in awake mode | Degraded/declared only in Phase A; no Spawnfile memory lowering enters the public config |
| `execution.sandbox.mode` | Supported through OpenClaw runtime/container workspace behavior | Supported through `restrict_to_workspace` and container workspace behavior | Degraded; the generic runtime image and physical roots provide isolation |
| `subagents` | Degraded; routed sessions do not preserve full parent-owned semantics | Supported through PicoClaw subagent behavior | Degraded; the public host runs listed agents independently |

#### Model, Schedule, And Surface Support

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| OpenAI `api_key` / `codex` auth | Supported | Supported | Only optional OpenAI Codex subscription intent; auth stays Daimon-owned |
| Anthropic `api_key` auth | Supported | Supported | Rejected |
| Anthropic `claude-code` auth | Supported | Supported | Rejected |
| `custom` or `local` endpoint | Supported except subscription-import auth | Supported for compatible endpoint/auth pairs | Rejected |
| `schedule.kind: cron` | Degraded | Supported through `workspace/cron/jobs.json` | Supported through the durable native v2 scheduler |
| `schedule.kind: every` | Degraded | Degraded | Supported through the durable native v2 scheduler |
| `schedule.kind: disabled` | Supported, emits no wake registration | Supported, emits no wake registration | Supported, emits no wake registration |
| `surfaces.moltnet` | Supported through generated MoltnetNode bridge | Supported through generated MoltnetNode bridge | Supported for inbound authenticated wakes and an outbound cognition tool constrained to compiled networks, rooms, and DM policy; sends carry deterministic delivery ids and durable per-agent receipts |
| Discord, Telegram, WhatsApp, Slack | Supported with OpenClaw access-mode coverage | Partial: open and user allowlists; pairing and richer allowlists rejected | Rejected |
| Webhook | Parsed, not lowered by active adapters in v0.1 | Parsed, not lowered by active adapters in v0.1 | Rejected |

#### Operational Support

| Spawnfile feature | OpenClaw | PicoClaw | Daimon |
|-------------------|----------|----------|------------|
| `spawnfile compile`, `build`, `run`, `up` | Supported | Supported | Supported |
| `spawnfile status --live` runtime probes | Supported | Supported | Limited; runtime health probes are not implemented yet |
| Runtime activity stream | Not normalized yet | Not normalized yet | Limited; Daimon exposes its public activity API but Spawnfile has no adapter probe yet |
| `spawnfile dev apply --agent` hot-add | Not supported in v0.1 | Not supported in v0.1 | Not supported in Phase A |
| Managed Moltnet servers and durable Moltnet state | Compiler-owned and runtime-independent | Compiler-owned and runtime-independent | Compiler-owned and runtime-independent |

---

### Memory Support Dimensions

Memory support is not a single boolean. Adapters should report each dimension in
the compile report so operators can see whether a memory bank is usable,
persisted, searchable, and policy-enforced.

| Dimension | OpenClaw | PicoClaw | Daimon |
|-----------|----------|----------|--------|
| Store lowering (`sqlite`, `json`) | Supported through generated Mneme MCP servers | Supported through generated Mneme MCP servers | Declared only in Phase A; no memory tool is lowered |
| Store lowering (`postgres`) | Reported by DSN secret name only; runtime tools are not wired in v0.1 | Reported by DSN secret name only; generated Mneme MCP is not emitted in v0.1 | Reported by DSN secret name only; runtime tools are not wired in v0.1 |
| Durable persistent mounts | Compiler-owned | Compiler-owned | Compiler-owned |
| Tool coverage (`search`, `locate`, `register`, `summarize`, `forget`) | Supported through generated Mneme MCP for file stores in awake and dream modes | Supported through generated PicoClaw MCP for file stores in awake and dream modes | Not lowered in Phase A |
| Principal/scope enforcement | Enforced by Mneme MCP context generated from runtime config | Enforced by Mneme MCP context generated from runtime config | Not lowered in Phase A |
| Lexical index | Reported | Supported/default through Mneme | Supported/default through Mneme |
| Vector index | Supported for generated Mneme MCP when `provider: ollama` is configured | Supported for generated Mneme MCP when `provider: ollama` is configured | Declared only in Phase A |
| Graph/temporal index | Optional/degraded unless configured | Optional/degraded unless configured | Optional/degraded unless configured |
| Scheduled consolidation / dream mode | Supported through generated isolated OpenClaw cron jobs and dream-mode Mneme MCP for file stores | Supported through generated PicoClaw cron jobs and dream-mode Mneme MCP for file stores | Not lowered in Phase A |
| Activity/audit events | Memory events are recorded by Mneme tools; runtime activity normalization is still runtime-owned | Memory events are recorded by Mneme tools; runtime activity normalization is still runtime-owned | Daimon host activity only; no Spawnfile memory activity lowering |
| Raw memory visibility to runtime files | Must be denied | Must be denied | Must be denied |

If a runtime exposes a live memory tool but cannot preserve scope/principal
enforcement, the memory bank is `unsupported`, not merely degraded. A runtime
may report declared memory as `degraded` when it emits no live memory tool and
keeps the bank report-only. If it can preserve storage but not a requested
index or consolidation mode, that specific capability is `degraded`.

`runtime: pi` remains the separate legacy generated-Pi implementation. Its
generated engine, auth, scheduler, MCP, and Moltnet behavior is not part of
the `runtime: daimon` public-host contract and must not be inferred from it.

### Daimon opaque auth ownership

Daimon credential inputs are opaque local bind sources, not Spawnfile auth
files. Spawnfile authorizes their filesystem metadata and validates only the
bounded provider-native refresh shape without retaining or reporting bytes.
It passes a nonzero common owner UID through the in-memory launch path and
never creates an engine credential home. The generated container wrapper uses
that UID only to prepare compiler-owned writable state.
Remote, SSH, and user-namespace-remapped Docker targets are unsupported when
an opaque Daimon source is present.

The consumed Daimon manifest declares one per-agent opaque slot for Codex.
For Grok it declares one durable rotating-credential realm and one read-only
operator bootstrap slot; Daimon serializes Grok turns through that authority,
atomically reconciles provider rotation, and leaves sessions/cache per agent.
The generated Linux container installs `bubblewrap`, which Grok requires to
fail closed while applying the realm and peer-home deny set.
The realm mount is `exclusive-reattach`: its host-stable volume survives run
and deployment identities, cannot be attached by two live deployments, and is
never copied by product-state migration. Standard concurrent canary is
rejected; stop the old deployment and reattach the same realm for replacement.
For AGY it declares one host-realm durable mount plus one independent opaque
unlock source slot. Spawnfile emits the stable RW volume, metadata-authorizes
the caller-owned `0600` unlock source, and mounts it read-only; it never reads
either OAuth or unlock bytes and never starts D-Bus or AGY. Daimon alone owns
the Linux Secret Service lifecycle and interactive subscription enrollment.

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

### Registry Contract

`runtimes.yaml` is the source of truth for supported versions and install
strategies. `spawnfile compile` must not require runtime source checkouts on the
compiler machine; container build/install uses the registry pin plus the
adapter's verified install strategy.

In v0.1, generated Dockerfiles must not clone runtime repositories or rebuild runtime sources during image build when a verified compiled install strategy is available. `source_repo` exists as a registry/install fallback, not the intended default for active runtime builds.

---

## Adapter Lifecycle

### Adding A New Runtime

1. Add an entry to `runtimes.yaml` with `status: exploratory`
2. Research the pinned upstream source and add findings to `specs/research/RUNTIME-NOTES.md`
3. When ready to implement, create `src/runtime/<name>/adapter.ts` and change status to `active`

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
