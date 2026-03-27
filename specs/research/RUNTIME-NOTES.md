# Runtime Compile Notes

Research snapshot for the runtimes tracked in `runtimes.yaml` at the repo root.

Purpose:

- record what each runtime actually exposes
- note what a Spawnfile adapter would likely need to emit
- avoid rediscovering the same runtime differences from source every time

This file is not normative. `../SPEC.md` is the canonical spec. This file is adapter research.

---

## Reading This File

For each runtime, this document summarizes:

- primary configuration and authoring surface
- docs and workspace conventions
- skills surface
- MCP surface
- model and auth surface
- sandbox and workspace surface
- team and routing surface
- likely Spawnfile lowering strategy

It also records the current schema conclusion:

- `runtime` names the host runtime and may carry adapter-specific `options`
- `execution` carries the portable overlap: model, workspace, sandbox
- `agent.subagents` are internal helpers of an agent
- `team.members` are first-class authored agents or nested teams

That split exists because the runtimes overlap on execution intent, but not on the details of each runtime's own config surface.

---

## Portable Overlap

These are the highest-confidence capabilities shared strongly enough to stay in the v0.1 portable core:

- markdown docs by role
- skill directories with `SKILL.md`
- MCP declarations
- model selection intent
- workspace isolation intent
- sandbox intent
- minimal routing intent

These are common enough to acknowledge, but too runtime-specific to standardize in the core:

- auth profile selection
- runtime-native channel bindings
- packaging and deployment wrappers
- memory engine configuration
- scheduler and heartbeat engine behavior
- runtime-native team lifecycle APIs
- rich runtime-native option trees

So the current schema split is:

- `runtime`
  - which runtime to compile to
  - optional runtime-specific `options`
- `execution`
  - the portable overlap that adapters should try to preserve

## Quick Matrix

| Runtime | Docs surface | Skills | MCP | Models/Auth | Sandbox/Workspace | Team primitive |
|---------|--------------|--------|-----|-------------|-------------------|----------------|
| OpenClaw | Strong | Strong | Bridge-based | Strong | Strong | Routed agents/sessions |
| PicoClaw | Strong | Strong | Strong in code | Strong | Strong | Spawned subagents + routing |
| TinyClaw | Strong | Present in code | No clear first-class MCP surface found | Strong | Strong | Native flat teams |
| NanoClaw | Strong | Very strong | Internal/secondary | Narrow | Strong | Claude Agent Teams / swarms |
| NullClaw | Strong | Strong | Strong, stdio-first | Strong | Strong | Delegate agents + subagents |
| ZeroClaw | Strong | Strong | Present, mixed by provider/runtime | Strong | Strong | Delegate sub-agents |
| OpenFang | Mixed | Strong | Strong | Strong | Strong | Hands / workflows / A2A |
| IronClaw | Moderate | Present | Strong | Strong | Strong | Orchestrator/worker pattern |

---

## OpenClaw

### What It Looks Like

- Main config: `~/.openclaw/openclaw.json`
- Workspace root: `~/.openclaw/workspace`
- Workspace prompt files: `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`, `BOOTSTRAP.md`
- Skills live under `~/.openclaw/workspace/skills/<skill>/SKILL.md`
- Long-term memory at `memory/` and `MEMORY.md`
- Multi-agent operation is based on routing plus isolated sessions

Key evidence:

- `runtimes/openclaw/README.md`
- `runtimes/openclaw/VISION.md`
- `runtimes/openclaw/src/routing/resolve-route.ts`

### Skills

OpenClaw has a clear workspace skill model and a registry story:

- workspace skills
- bundled skills
- ClawHub registry

Adapter target:

- write Spawnfile skills into the workspace skill directory
- preserve `SKILL.md`
- map any registry or managed install behavior as adapter-specific, not canonical

### MCP

OpenClaw supports MCP, but the important nuance is that MCP is currently treated as a bridge layer through `mcporter`, not a pure first-class core runtime surface.

- `VISION.md` explicitly says MCP support goes through `mcporter`
- ACPX runtime paths can inject named MCP server maps

Adapter target:

- compile logical Spawnfile MCP declarations into OpenClaw's MCP bridge or plugin-native config
- do not assume a single stable MCP config path without adapter research

### Models and Auth

- README points to model config and auth profile rotation docs
- minimal config example uses a single `agent.model`
- session state can persist model selection per session

Adapter target:

- map `execution.model.primary` to the agent default model
- map fallbacks only if the chosen runtime path supports them
- auth handling is mostly runtime-native and should stay adapter-specific

### Channels and Surfaces

OpenClaw has the strongest communication-surface model of the active runtimes.

- Discord is a real first-class surface with distinct DM and guild policy controls
- Telegram is also a real first-class surface with distinct DM and group policy controls
- WhatsApp is also a real first-class surface with DM and group policy controls
- Slack is a real first-class surface with socket-mode ingress and DM/channel policy controls
- access patterns can be open, pairing-gated, or allowlisted
- guild-level config can carry channel scoping

Adapter target:

- treat OpenClaw as the best early target for the portable Discord, Telegram, WhatsApp, and Slack surfaces
- lower portable Discord access into the runtime's richer DM/group/guild policy fields
- lower portable Telegram access into the runtime's richer DM/group policy fields
- lower portable WhatsApp access into the runtime's richer DM/group policy fields
- lower portable Slack access into the runtime's richer DM/channel policy fields
- record any degradation explicitly when a portable surface cannot preserve a runtime-native option
- current live-smoke status:
  - Discord works end to end
  - Telegram works end to end with `access.mode: open`
  - WhatsApp works end to end
  - Slack works end to end

### Workspace and Sandbox

- Main session can run on host
- non-main sessions can be sandboxed in Docker
- workspace root is explicit and configurable

Adapter target:

- map `execution.workspace.isolation`
- map `execution.sandbox.mode`
- treat per-session sandboxing semantics as adapter-defined

### Teams and Routing

OpenClaw has no strong user-facing team manifest in the README.

What it clearly has:

- multi-agent routing
- routed sessions
- agent-to-agent session tools

What it does not clearly have:

- native nested teams
- explicit team lifecycle objects

`teamId` in routing code appears to be routing metadata alongside peer/guild/account routing, not a durable agent-team definition.

Adapter target:

- lower Spawnfile members into routed agents
- lower `entry` into the initial route target
- lower `delegate` into `sessions_send` or similar session coordination
- report degradation for nested teams and full native team identity

---

## PicoClaw

### What It Looks Like

- Main config: `~/.picoclaw/config.json`
- Workspace root default: `~/.picoclaw/workspace`
- Rich workspace doc layout: `AGENTS.md`, `HEARTBEAT.md`, `IDENTITY.md`, `SOUL.md`, `TOOLS.md`, `USER.md`, plus `memory/`

Key evidence:

- `runtimes/picoclaw/README.md`
- `runtimes/picoclaw/pkg/config/config.go`
- `runtimes/picoclaw/pkg/mcp/manager.go`
- `runtimes/picoclaw/pkg/routing/route.go`
- `runtimes/picoclaw/pkg/tools/spawn.go`

### Skills

PicoClaw has first-class skills in both README and code.

- workspace skills
- global skills
- builtin skills
- registry/search/install tooling in code

Adapter target:

- write skills into workspace `skills/`
- preserve `SKILL.md`
- optionally configure registry behavior later

### MCP

PicoClaw has a first-class MCP config surface in code:

- `tools.mcp.enabled`
- `tools.mcp.servers`
- each server has `enabled`, `command`, `args`, `env`, `env_file`, `type`, `url`, `headers`

Supported transports in code:

- `stdio`
- `sse`
- `http`

Adapter target:

- Spawnfile MCP declarations map well here
- this is one of the best early targets for canonical MCP lowering

### Models and Auth

- model-centric config via `vendor/model`
- provider expansion is largely config-only
- model fallbacks are explicitly documented
- auth commands exist, for example `picoclaw auth login --provider anthropic`

Adapter target:

- map primary model and fallback models
- map provider-specific auth only through runtime-native config or CLI setup

### Channels and Surfaces

PicoClaw has usable runtime-native channel support, but the policy surface is simpler than OpenClaw's.

- Discord is token-based and maps cleanly for simple ingress
- Telegram is token-based and also maps cleanly for simple ingress
- WhatsApp is available, but portable group allowlists are not a strong fit
- Slack is available, but portable channel allowlists are not a strong fit
- user allowlists have a direct lowering path
- mention-driven behavior exists
- guild and channel scoping are not currently a strong portable fit from Spawnfile

Adapter target:

- treat PicoClaw as a good Discord, Telegram, WhatsApp, and Slack target for open access and user allowlists
- do not claim portable guild/channel policy support unless the runtime lowering becomes concrete
- do not claim portable WhatsApp group policy or Slack channel policy support unless the runtime lowering becomes concrete
- keep richer surface semantics runtime-specific until they are proven in the adapter
- current live-smoke status:
  - Discord works end to end
  - Telegram works end to end with `access.mode: open`
  - Slack works end to end
  - Slack channel replies are posted in a thread; direct messages reply inline
  - WhatsApp is still blocked in the pinned artifact because `whatsapp_native` is not compiled into the shipped binary

### Workspace and Sandbox

- strong workspace-first model
- `restrict_to_workspace` is the main sandbox switch
- the same restriction is inherited by subagents and heartbeat tasks

Adapter target:

- this is a strong fit for Spawnfile `workspace` and `sandbox` intent
- exact lowering will likely map `workspace` intent into `workspace` path and `sandbox` intent into `restrict_to_workspace`

### Teams and Routing

PicoClaw has:

- route bindings in code
- `binding.team` as a routing tier
- spawned subagents with optional `agent_id`
- heartbeat-driven async spawning

But it does not present a strong native team object.

Adapter target:

- compile members into named agents
- compile `delegate` into spawn or agent-targeted spawn
- compile `broadcast` as parallel spawns if supported
- report degradation for native team identity and nesting

---

## TinyClaw

### What It Looks Like

- Multi-agent, multi-team runtime
- settings contain both agents and teams
- each agent gets its own working directory
- channel clients can route `@agent_id` and `@team_id` messages

Key evidence:

- `runtimes/tinyclaw/README.md`
- `runtimes/tinyclaw/lib/teams.sh`
- `runtimes/tinyclaw/AGENTS.md`
- `runtimes/tinyclaw/src/lib/agent.ts`

### Skills

TinyClaw does have a skills surface in code even though the README does not emphasize it.

- default skills are copied into `.agents/skills`
- then mirrored into `.claude/skills`

Adapter target:

- generate per-agent skill directories
- likely write both `.agents/skills` and `.claude/skills` or rely on TinyClaw's own sync path

### MCP

I did not find a clear first-class MCP authoring/config surface in the TinyClaw README or the initial source pass.

Adapter implication:

- do not treat TinyClaw as an early MCP target until the runtime's MCP story is mapped more concretely

### Models and Auth

- per-agent provider and model are explicit
- global provider/model switching also exists
- channel auth is channel-specific
- sender pairing allowlist is applied before routing

Adapter target:

- map each Spawnfile member agent to a TinyClaw agent config
- map execution model intent cleanly

### Channels and Surfaces

TinyClaw does expose Discord, Telegram, WhatsApp, and other channels, but its current Discord/Telegram/WhatsApp behavior is much narrower than the other active runtimes.

- Discord is DM-oriented in the upstream client
- Telegram is also pairing-gated in the upstream client
- WhatsApp is also pairing-gated in the upstream client
- sender pairing happens before normal routing
- declarative allowlist policy is not the runtime's native model today
- guild/channel semantics are not the right portable target for TinyClaw in v0.1
- Slack is not a supported Spawnfile surface for TinyClaw in v0.1

Adapter target:

- compile TinyClaw Discord, Telegram, and WhatsApp as paired DM-style surfaces only
- reject richer portable Discord, Telegram, or WhatsApp access modes at compile time instead of surprising users at run time
- reject Slack entirely for TinyClaw in v0.1
- keep room or broader network-style communication out of the portable TinyClaw surface contract for now
- current live-smoke status:
  - Discord works end to end as a paired DM surface
  - Telegram works end to end, but first-contact pairing is required
  - WhatsApp is still blocked in the shipped container because the upstream client needs a browser runtime

### Workspace and Sandbox

- each agent has its own working directory
- each agent has separate config and history
- workspace layout is explicit

Adapter target:

- this maps cleanly from canonical workspace isolation intent

### Teams and Routing

TinyClaw is the strongest native team target in the repo.

Native team shape:

- `id`
- `name`
- `agents`
- `leader_agent`

Native interaction:

- `@team_id` routes to leader
- agents mention teammates to collaborate
- fan-out exists in prompt protocol

Adapter target:

- map `entry` to `leader_agent`
- map members directly
- map `delegate` and some `broadcast` behavior fairly well
- nested teams likely need flattening or degradation reporting

---

## NanoClaw

> **Incompatible with Spawnfile.** NanoClaw has no declarative config surface — it is code-driven through Claude Code skills that transform the repository. There are no config files to emit and no workspace docs to place. This is fundamentally incompatible with Spawnfile's config + markdown workspace model. Removed from the runtime registry.

### What It Looks Like

- Single Node.js orchestrator
- channels are skills that self-register
- each group has isolated filesystem and memory
- agent execution happens inside Claude Agent SDK containers

Key evidence:

- `runtimes/nanoclaw/README.md`
- `runtimes/nanoclaw/CLAUDE.md`
- `runtimes/nanoclaw/src/container-runner.ts`

### Skills

NanoClaw is skill-first to an unusual degree.

- channels are added as Claude Code skills
- many features are intentionally expected to be skills, not core config
- `SKILL.md` here often means "teach Claude Code how to rewrite the installation"

Adapter implication:

- Spawnfile skill lowering to NanoClaw is not just "copy `SKILL.md` into a folder"
- it may require a specialized NanoClaw adapter that decides which skills become installed Claude Code skills versus runtime content

### MCP

NanoClaw has internal MCP use in the container runner and agent runtime, but the user-facing authoring surface is still primarily skill-driven rather than a clear manifest-driven MCP registry.

Adapter implication:

- possible target, but not an easy early one for canonical MCP emission

### Models and Auth

- strongly centered on Anthropic-compatible APIs
- configured through env vars rather than a large static model registry
- philosophy resists configuration sprawl

Adapter target:

- map execution model intent conservatively
- expect runtime-native env/auth setup rather than a rich compile target

### Workspace and Sandbox

- very strong container isolation story
- per-group isolated filesystem and memory

Adapter target:

- docs and workspace intent map reasonably well

### Teams and Routing

- exposes "Agent Swarms"
- implementation uses Claude Code experimental agent teams
- not a clear NanoClaw-native team manifest

Adapter implication:

- team lowering is likely possible only through runtime-specific setup
- not a good first canonical team target

---

## NullClaw

### What It Looks Like

- Config file: `~/.nullclaw/config.json`
- OpenClaw-compatible config structure
- markdown identity plus optional AIEOS identity
- strong runtime abstraction layer

Key evidence:

- `runtimes/nullclaw/README.md`
- `runtimes/nullclaw/src/agent_routing.zig`
- `runtimes/nullclaw/src/tools/delegate.zig`
- `runtimes/nullclaw/src/subagent.zig`

### Skills

NullClaw has first-class skills, but its format is a little richer than the pure Spawnfile assumption:

- loader uses TOML manifests plus `SKILL.md`
- workspace skill directory exists

Adapter target:

- Spawnfile can still map into `SKILL.md`, but the adapter may need to synthesize the TOML sidecar or manifest data expected by NullClaw

### MCP

NullClaw supports MCP, but current evidence suggests a stdio-first stance:

- README advertises MCP
- MeshRelay example says direct remote MCP URLs are not loaded directly from `mcp_servers`
- stdio MCP servers via `command` + `args` are clearly supported

Adapter target:

- canonical stdio MCP lowering fits well
- remote URL MCP may require a local bridge for now

### Models and Auth

- OpenClaw-compatible config layout for providers and defaults
- named agents can override model
- multiple token and gateway auth modes exist

Adapter target:

- primary and fallback execution model intent should map reasonably well
- auth remains adapter-specific

### Workspace and Sandbox

- explicit workspace scoping
- multiple sandbox backends
- allowlists and protected paths

Adapter target:

- strong fit for canonical execution workspace and sandbox intent

### Teams and Routing

NullClaw has:

- route bindings
- named agents
- delegate tool
- subagent manager

But not a strong user-facing team object.

Adapter target:

- lower teams into named agents plus route bindings
- use delegate or subagent patterns for member coordination
- nested teams degrade

---

## ZeroClaw

### What It Looks Like

- Config file: `~/.zeroclaw/config.toml`
- supports markdown identity or AIEOS JSON identity
- strong provider/auth story
- strong skills story

Key evidence:

- `runtimes/zeroclaw/README.md`
- `runtimes/zeroclaw/docs/config-reference.md`
- `runtimes/zeroclaw/docs/providers-reference.md`

### Skills

- skills are first-class
- open-skills sync is opt-in
- installs are statically audited

Adapter target:

- preserve `SKILL.md`
- expect adapter-specific registry handling and install audit behavior

### MCP

ZeroClaw clearly talks about MCP in provider/runtime docs, but the surface is more mixed than PicoClaw's direct server map.

Adapter implication:

- viable target, but the exact MCP compile surface should be mapped before implementation

### Models and Auth

- excellent auth story
- auth profiles support subscription-native flows
- delegate sub-agents have their own provider/model/tool settings

Adapter target:

- one of the best targets for execution model intent
- delegate sub-agents are useful for team lowering

### Workspace and Sandbox

- explicit workspace-only controls
- optional Docker runtime
- allowed roots outside workspace

Adapter target:

- strong fit for canonical execution workspace and sandbox intent

### Teams and Routing

ZeroClaw does not expose native teams.

What it does expose:

- named delegate sub-agents under `[agents.<name>]`
- recursion depth
- tool allowlists
- agentic or single-turn delegate modes

Adapter target:

- lower Spawnfile teams into named delegate agents
- preserve `delegate` edges best
- report degradation for nested teams and full broadcast semantics

---

## OpenFang

> **Incompatible with Spawnfile.** OpenFang uses `HAND.toml` manifests where agent identity is an inline `system_prompt` string field, not separate markdown docs in a workspace. Spawnfile's core premise is markdown-doc-driven authoring (SOUL.md, AGENTS.md, IDENTITY.md), which cannot be meaningfully preserved by flattening into a TOML string. Skills use `SKILL.md` but are bundled into the binary, not loaded from a workspace directory. Removed from the runtime registry.

### What It Looks Like

- strong runtime, workflow, MCP, and auth story
- composition is centered on Hands and workflows

Key evidence:

- `runtimes/openfang/README.md`
- `runtimes/openfang/docs/api-reference.md`
- `runtimes/openfang/docs/cli-reference.md`

### Skills

- `SKILL.md` is first-class
- large built-in skills ecosystem

### MCP

- first-class MCP client and server story
- rich API and CLI around MCP
- agent-level MCP assignment appears to exist

### Models and Auth

- rich multi-model and per-channel/per-agent configuration
- credential vault and OAuth flows

### Workspace and Sandbox

- strong WASM sandbox story
- subprocess sandbox and approval gates

### Teams and Routing

- no clear user-facing team hierarchy comparable to TinyClaw
- richer composition seems to be Hands, workflows, A2A, and routing

Adapter implication:

- agent-level Spawnfile lowering looks promising
- team lowering probably needs a workflow-oriented adapter design, not a direct team-object assumption

---

## IronClaw

> **Incompatible with Spawnfile.** IronClaw is configured entirely through environment variables (`.env` file) with an orchestrator/worker job system. There are no agent config files to emit and no markdown workspace for docs. This is fundamentally incompatible with Spawnfile's config + markdown workspace model. Removed from the runtime registry.

### What It Looks Like

- Rust runtime
- orchestrator/worker architecture
- WASM tools
- hosted MCP server management

Key evidence:

- `runtimes/ironclaw/README.md`
- CLI completion and source references around `mcp`

### Skills

- skills exist in repo
- skill story is present but less directly documented than OpenClaw or PicoClaw

### MCP

- strong MCP story
- hosted MCP server management and auth flows appear built into CLI

### Models and Auth

- first-run setup covers auth
- per-job auth appears in orchestrator/worker design

### Workspace and Sandbox

- WASM sandbox
- Docker sandbox
- workspace filesystem

### Teams and Routing

- orchestration and workers exist
- not a clear user-facing team manifest from the docs reviewed here

Adapter implication:

- likely a later target
- team lowering would probably be adapter-specific orchestration rather than native team config

---

## Team Lowering Patterns

In practice, adapters will use one of these patterns to lower Spawnfile team intent:

### Native Team Object

Best case. The runtime already has team identity, member list, leader/entry, and direct message routing to the team. **TinyClaw** is the closest current example.

### Flat Leader/Member Team

The runtime has a flat team object but no nesting. Nested Spawnfile teams may need to flatten, which is a degradation if the nested boundary mattered.

### Routed Agent Sessions

The runtime does not have a team object, but can run multiple named agents, route into different sessions, and let one session contact another. **OpenClaw** is the clearest example.

### Delegate Agent Set

The runtime has named specialized agents that the main agent can call. Can preserve member identity, leader/entry, and delegate edges. Often cannot preserve full broadcast, durable team identity, or nested teams. **NullClaw** and **ZeroClaw** fit this pattern.

### Spawned Subagents

The runtime can create background workers or subagents but does not keep a stable team object. Can preserve delegation and some parallelism. Often cannot preserve stable membership, hierarchy, or durable shared surface. **PicoClaw** fits this pattern.

### Autonomous Units Or Workflows

The runtime's composition primitive is not really "team" but workflow, hand, or autonomous package. **OpenFang** is closest here.

---

## Adapter Priorities

Active adapters (have implementations in `src/runtime/`):

1. OpenClaw
2. PicoClaw
3. TinyClaw

Exploratory (config + markdown workspace model confirmed, no adapter yet):

4. NullClaw
5. ZeroClaw

Incompatible (removed from registry):

- NanoClaw — code-driven via Claude Code skills, no declarative config
- OpenFang — inline system_prompt in TOML, no markdown workspace
- IronClaw — env-vars-only, no agent config files

All five supported runtimes share the core pattern: a JSON or TOML config file plus separate markdown docs in a workspace directory. See `blueprints/` for the frozen reference layouts.

### Verified Runtime Notes At Pinned Versions

These are implementation notes from adapter work and container smoke verification at the currently pinned refs. They are informative, not normative.

#### OpenClaw

- Container output was verified from the host, not only inside Docker.
- The generated runtime must bind to a host-reachable gateway setting for Docker port publishing to be useful.
- The compiled output can place config and workspace files into final runtime paths at build time; the entrypoint only needs validation and startup.
- The host-side smoke checks that currently matter are the control UI root path and `/healthz`.

#### PicoClaw

- The pinned runtime version currently needs `workspace/` copied into `cmd/picoclaw/internal/onboard/workspace` before `go build` succeeds in a clean checkout.
- Provider auth is not satisfied by ambient env alone in the generated config path. The compiled config needs `model_list[].api_key` file references such as `file://secrets/OPENAI_API_KEY`, and the entrypoint must materialize those files from env before startup.
- Clean container boot currently uses `picoclaw gateway --allow-empty`.
- Health endpoints are exposed on `/health` and `/ready`.
- The current compile/build flow runs one PicoClaw gateway process per compiled target and increments ports from the adapter base port.

#### TinyClaw

- TinyClaw is the strongest current native team target: one runtime process can host compiled agents plus the compiled team object.
- The current host-side verification surface is `GET /api/agents` on port `3777`.
- The compiled output can pre-place the runtime settings and workspace into final container paths; the entrypoint only needs minimal validation and startup.

---

## Open Questions To Research Later

- OpenClaw: exact MCP compile surface beyond the `mcporter` bridge path
- TinyClaw: whether MCP has a real runtime surface or only indirect skill-based integration
- ZeroClaw: exact user-facing MCP server config surface for non-provider MCP integrations
- NullClaw: how AIEOS structured identity interacts with markdown docs — can both coexist?
- ZeroClaw: how swarms (sequential/parallel/router strategies) relate to Spawnfile team model
