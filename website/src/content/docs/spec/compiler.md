---
title: Compiler Specification
description: The Spawnfile v0.1 compiler pipeline, graph resolution, adapter contract, intermediate representation, output layout, and compile report format.
---

# Spawnfile Compiler v0.1

This document is the implementation companion to `SPEC.md`.

`SPEC.md` defines the canonical source format. This file defines the reference compiler shape for v0.1 so the project can move into implementation.

Related specs: `CONTAINERS.md` (container compilation), `SURFACES.md` (portable communication surfaces), `RUNTIMES.md` (runtime registry and version pinning).

---

## Goals

The v0.1 compiler should do four things well:

- load a Spawnfile graph deterministically
- resolve effective runtime and execution configuration
- hand resolved nodes to runtime adapters
- emit stable runtime-native outputs, generated team-context artifacts, container artifacts, and a machine-readable compile report

It should not try to solve packaging, publishing, deployment orchestration, runtime-native channel setup, or runtime coordination in v0.1. The compiler does not inject custom MCP tools, proxy/router processes, or team-internal RPC mechanisms.

The compiler has a write-only runtime boundary. It may write generated files, config, env files, mounted credential stores, generated secrets, and future explicit operator-triggered updates. It must not read spawned runtimes, containers, runtime homes, or agent workspaces to discover identity, infer organization state, rewrite rosters, or maintain live coordination state.

---

## Compiler Pipeline

The reference pipeline is:

1. Parse the root `Spawnfile`.
2. Validate local schema and file references.
3. Walk the manifest graph through `members[*].ref` and `subagents[*].ref`.
4. Detect cycles and incompatible duplicate references.
5. Resolve effective `runtime` and `execution` for every graph node.
6. Resolve `description` for every agent node (from manifest or derived from `workspace.docs.identity`).
7. Resolve workspace resources and inheritance context for each concrete agent.
8. Resolve schedule lowering constraints.
9. Build a normalized intermediate representation.
10. Group resolved nodes by runtime.
11. Invoke runtime adapters.
12. Resolve team representatives, team-context files, roster files, and team-network artifacts.
13. Merge generated files into compiled workspaces.
14. Place or point to generated team-context orientation through each runtime's system-instruction surface when possible.
15. Attach compiler-owned capability outcomes and warning diagnostics.
16. Enforce policy after report augmentation.
17. Generate container artifacts from adapter container metadata.
18. Emit `spawnfile-report.json`.

The compiler should operate on resolved IR, not on raw YAML, after the graph phase.

---

## Graph Rules

### Node Identity

Graph nodes are keyed by canonical manifest path.

This is intentionally simple for v0.1:

- one manifest path = one logical node
- repeated refs are allowed only if they resolve identically

If the same manifest path resolves to different effective `runtime` or `execution` values in one compile graph, compilation should fail.

### Stable Node IDs

The compiler should expose a stable node id separate from the internal manifest-path key.

Recommended rule:

- start from `<kind>:<name>`
- if that collides within one compile run, append a short hash of the canonical manifest path

Examples:

- `agent:analyst`
- `team:research-cell`
- `agent:assistant#4f2a9c1d`

Output directory names should use the slug portion of that id.

### Edges

There are two edge kinds:

- `team_member`
- `subagent`

The compiler should preserve edge kind in the IR because adapters may treat them very differently.

### Cycles

Cycles are invalid in v0.1.

Examples that must fail:

- team A includes team B and team B includes team A
- agent A includes subagent B and subagent B includes subagent A
- any mixed cycle across teams and subagents

---

## Effective Resolution

The canonical resolution rules for runtime, execution, and other surfaces are defined in `SPEC.md` sections 2.4, 2.5, 3.4, and 4.4. This section covers implementation notes beyond what the spec defines.

### Runtime Normalization

`runtime` should be normalized internally to:

```yaml
runtime:
  name: openclaw
  options: {}
```

even when authored as a shorthand string. This normalization happens once during graph loading so that adapters always receive a consistent shape.

### Resolution Implementation

The compiler resolves effective configuration during graph walking, not as a separate pass. Each node's effective runtime, execution, `workspace.docs`, `workspace.resources`, and schedule are computed when the node is first visited, and the result is cached by canonical manifest path with a fingerprint to detect conflicting resolutions.

---

## Intermediate Representation

The compiler should normalize manifests into two node types and one plan.

### Resolved Agent

```yaml
kind: agent
id: agent:analyst
source: /abs/path/to/Spawnfile
runtime:
  name: openclaw
  options: {}
execution:
  model:
    primary:
      provider: anthropic
      name: claude-sonnet-4-5
      auth:
        method: api_key
surfaces:
  discord:
    access:
      mode: allowlist
      users:
        - "987654321098765432"
    bot_token_secret: DISCORD_BOT_TOKEN
  telegram:
    access:
      mode: allowlist
      users:
        - "123456789"
    bot_token_secret: TELEGRAM_BOT_TOKEN
  slack:
    access:
      mode: allowlist
      users:
        - "U1234567890"
    app_token_secret: SLACK_APP_TOKEN
    bot_token_secret: SLACK_BOT_TOKEN
workspace:
  docs: {}
  resources: []
skills: []
mcp_servers: []
env: {}
secrets: []
subagents: []
```

### Resolved Agent (additions)

The resolved agent IR also includes:

```yaml
description: "Research analyst that finds, evaluates, and synthesizes information"
```

`description` is the agent's short summary. If the manifest does not declare one, the compiler derives it from `workspace.docs.identity` by extracting the first non-empty paragraph, truncated to 200 characters. If no `workspace.docs.identity` is declared, the description is left empty.

### Resolved Team

```yaml
kind: team
id: team:research-cell
source: /abs/path/to/Spawnfile
description: "Research team that finds, analyzes, and writes up findings"
workspace:
  docs: {}
  resources: []
shared:
  skills: []
  mcp_servers: []
  env: {}
  secrets: []
members: []
mode: swarm
lead: null
external: []
networks: []
```

Note: `mode`, `lead`, `external`, and `networks` are top-level team fields, not nested under `structure`. Team manifests do not carry an `auth` field in the alpha reset.

### Compile Plan

```yaml
root: /abs/path/to/Spawnfile
nodes: []
edges: []
runtimes:
  openclaw:
    nodeIds: []
  picoclaw:
    nodeIds: []
```

The important property is that adapters receive resolved nodes, never unresolved inheritance logic.

---

## Team Roster Compilation

When compiling a team, the compiler generates context-scoped team artifacts after resolving all member nodes and after runtime adapters emit their base files.

### Compilation Steps

1. Resolve each member's `description` from the agent manifest's `description` field, or derive it from `workspace.docs.identity` if available.
2. Build membership-context records keyed by `(agent-source, team-source, member-slot-id)`. The same agent source may fill several team roles without merging those contexts.
3. Resolve the representative interface for nested team slots using `external`, `lead`, and swarm fallback.
4. Resolve `workspace.resources` for each concrete member from team-local and direct inheritance, preserving the manifest scope that declared each resource so team-shared backing storage can be scoped to that team.
5. Resolve team networks. Moltnet parent-room members that name child-team slots expand only to the child team's selected concrete representatives.
6. Emit a generated resource plan that lists each resource's declared mount, concrete agent-visible link path, backing path, and sharing mode.
7. Generate namespaced direct-membership `TEAM.md` files under `.spawnfile/team-contexts/<team-context-key>/TEAM.md`.
8. Generate context-scoped roster YAML under `.spawnfile/rosters/<team-context-key>.yaml`.
9. Generate representative parent-context `TEAM.md`, rosters, team cards, `.spawnfile/team-contexts.yaml`, and `.spawnfile/team-contexts.md` for selected representatives.
10. Emit root `TEAM.md` and `.spawnfile/roster.yaml` aliases only when a compiled agent has exactly one direct team membership.
11. Build coordination-graph diagnostics for each emitted team-context roster.
12. Build schedule-wake capability diagnostics for declared schedules against adapter wake contracts.
13. Attach compiler-owned capability outcomes before policy enforcement.

### Roster Schema

```yaml
team: research-cell
mode: hierarchical
lead: orchestrator
self: researcher
context_kind: direct

members:
  orchestrator:
    role: lead
    description: "Coordinates the research team, assigns tasks, synthesizes results"
    surfaces: [moltnet, slack]
    addresses:
      moltnet:
        local_lab:
          fqid: "molt://local_lab/agents/orchestrator"
          rooms: [research-room]
      slack:
        user_id: "U1234567"
  writer:
    role: member
    description: "Writes reports and articles from research findings"
    surfaces: [moltnet]
    addresses:
      moltnet:
        local_lab:
          fqid: "molt://local_lab/agents/writer"
          rooms: [research-room]
```

Roster entries carry context-scoped derivable per-surface `addresses`. The compiler does not synthesize routed endpoints. Moltnet addresses are derivable. Slack, Discord, Telegram, and WhatsApp addresses appear only when the agent manifest declares the corresponding `surfaces.<name>.identity` field. Portable HTTP addresses never appear because `surfaces.http` is not part of the alpha surface schema.

The roster is a per-member view:

- `self` identifies which member this roster belongs to. The self agent does not appear in `members`.
- `role` is `lead` for the team lead, `member` for everyone else. For nested team entries, `role` is `team`.
- `description` comes from each agent's resolved description.
- In `hierarchical` mode, non-lead members only see the lead in their roster. The lead sees all members.
- In `swarm` mode, all members see all other members.

For nested team members, the inner team appears as a single entry with `role: team`, its own description, a team card path, and selected representatives. The outer team does not see the inner team's full internal roster.

### Context Artifacts

Every direct membership receives:

```text
.spawnfile/team-contexts/<team-context-key>/TEAM.md
.spawnfile/rosters/<team-context-key>.yaml
```

Representative agents also receive parent-context artifacts:

```text
.spawnfile/team-contexts.yaml
.spawnfile/team-contexts.md
.spawnfile/team-contexts/<team-context-key>/TEAM.md
.spawnfile/rosters/<team-context-key>.yaml
.spawnfile/team-cards/<team-context-key>/<parent-member-slot-id>.md
```

`TEAM.md` is emitted literally from the team's `workspace.docs.system` source document. It bypasses runtime document-role mapping so it does not replace the agent's own system instructions. The compiler must not merge several `TEAM.md` files.

`EmittedFile` remains a plain file-output contract:

```ts
interface EmittedFile {
  path: string;
  content: string;
  mode?: number;
}
```

Team-context discoverability uses runtime adapter metadata after files are emitted:

```ts
interface RuntimeSystemInstructionSurface {
  resolvePath(input: { node: ResolvedAgentNode }): string;
  placement: "append_pointer" | "append_inline" | "replace_generated_block";
}
```

The compiler performs this placement as post-processing. If a runtime cannot expose a system-instruction surface, it reports `team.context_orientation` as degraded or unsupported. Merely placing `.spawnfile/team-contexts.md` adjacent to runtime files is not enough when the runtime has a system-instruction surface.

### Team Network Lowering

Team networks are provider-backed organizational communication topology. Moltnet is the current provider.

Rules:

- A parent team's `networks[].rooms[].members` list may name direct agent member IDs or direct child-team member IDs.
- Direct child-team IDs expand through the child team's representative chain, not to arbitrary descendants.
- The compiler synthesizes Moltnet room attachments for selected representatives because the parent room is declared organization membership, not a proxy.
- Moltnet member IDs are direct member slot IDs and must be unique across the reachable nested team graph.
- The compiler resolves each concrete generated attachment into a process-group key and emits Moltnet node configuration using `MoltnetNode` topology where possible.
- Default process-group key is one concrete agent.
- The same Moltnet network-id may be reused across teams. Compatible duplicate attachments for the same `(network_id, member_id)` merge rooms; incompatible duplicates fail compilation.
- Moltnet `reply` policy is `auto | never` in this alpha. `manual` is rejected or normalized out before generated config.
- For each `(process group, network URL, network id, auth mode, token class)` tuple, one `MoltnetNode` may carry multiple attachments; different tuples require separate nodes.

#### Moltnet Server/Auth/Store Lowering

- `server` blocks are required for networks that are materialized locally and are normalized by `(provider, server.mode, server.url, server.listen, store, auth, pairings)` identity.
- `server.mode: managed` lowerings generate a server config and a managed server process slot under the local lifecycle graph.
- `server.mode: external` generates client/node config only.
- Managed server config requires:
  - explicit `server.listen`
  - required `server.store`
  - required `server.auth`
- `server.store.kind` is mapped to Moltnet `storage` semantics:
  - `sqlite` + `path`
  - `json` + `path`
  - `postgres` + `dsn_secret`
  - `memory`
- Secret-backed store fields (`sqlite`/`json` path on durable volumes, postgres DSN secret) are materialized into private runtime files at startup.
- Auth token materialization is always private and source-controlled outputs never include inline token values.
- In managed mode, `server.auth.tokens[]` drives server config; each token is emitted as a secret-backed token entry using declared secret names and scopes.
- `server.auth.client` is normalized into one of `token_id`, `token_env`, or `token_path` and rejected if more than one is set.
- `server.auth.mode` mapping:
  - `none`: no client auth emitted.
  - `bearer`: emits attach-capable client credentials for generated nodes.
  - `open`: emits per-agent writable token paths unless a static token client source is provided.
- Managed bearer mode requires `token_id` and requires the referenced token to include `attach` and `write` scopes.
- Managed and external open static token mode requires `static_token: true` on the configured client source.
- `server.pairings` entries are materialized into managed server config and rejected on non-managed networks.

### Coordination Diagnostics

For every emitted team-context roster with more than one visible concrete participant, the compiler builds a coordination graph. Nodes are visible concrete participants. Edges are shared declared coordination surfaces: a shared agent surface key in that context, or a shared team-network room after representative expansion.

The compiler reports warnings, not errors, when a visible concrete participant has no edge to another visible participant, when the whole cross-member graph has no edges, or when one concrete agent has the same surface binding tuple mapped to multiple team contexts. These diagnostics belong in `spawnfile-report.json`.

### Compile Report

The compile report should include `team.roster` for context-scoped roster emission and should attach warning diagnostics to the affected team node.

---

## Adapter Contract

Runtime adapters should implement the smallest interface that can work across all current runtimes.

### Required Adapter Operations

- `compileAgent`
  - required
- `compileTeam`
  - optional
- `validateRuntimeOptions`
  - optional but recommended

### Suggested Interface

```yaml
compileAgent(input):
  files: []
  capabilities: []
  diagnostics: []

compileTeam(input):
  files: []
  capabilities: []
  diagnostics: []
```

Where:

- `files`
  - emitted files relative to the node output directory
- `capabilities`
  - per-capability outcomes
- `diagnostics`
  - warnings and errors discovered by the adapter

Adapters may also expose `systemInstructionSurface` metadata so compiler post-processing can place or point to generated team-context orientation. The resolver returns a runtime-output-relative path for the concrete agent, not a static global path.

### Team Lowering Rule

The compiler should assume this default:

- every agent node is always compilable independently by its runtime adapter
- team-level compilation is optional and adapter-dependent

That means:

- if a team's relevant members all belong to one runtime and the adapter supports teams, `compileTeam` may emit native team artifacts
- if a team spans multiple runtimes, the compiler should still compile the member agents and report any loss of native team semantics

This keeps multi-runtime teams possible without requiring a universal native team primitive.

---

## Output Layout

The default output root for v0.1 should be `./.spawn`.

Within that root, the compiler should emit:

```text
.spawn/
├── Dockerfile
├── entrypoint.sh
├── .env.example
├── container/
│   └── rootfs/
│       └── var/lib/spawnfile/instances/...
├── runtimes/
│   ├── openclaw/
│   │   ├── agents/
│   │   │   └── analyst/
│   │   └── teams/
│   │       └── research-cell/
│   └── picoclaw/
│       └── agents/
│           └── researcher/
└── spawnfile-report.json
```

Rules:

- one directory per runtime
- one stable directory per compiled node
- agent and team outputs are separated
- container artifacts are always emitted at the root for the full resolved graph
- the report file is always emitted at the root

If a runtime adapter emits nothing for a team node, the report should still record the attempted lowering and capability outcomes.

---

## Compile Report

The report should be JSON by default and written to `spawnfile-report.json`.

### Top-Level Shape

```json
{
  "spawnfile_version": "0.1",
  "root": "/abs/path/to/Spawnfile",
  "nodes": [],
  "diagnostics": [],
  "container": {}
}
```

### Node Entry Shape

```json
{
  "id": "agent:analyst",
  "kind": "agent",
  "source": "/abs/path/to/Spawnfile",
  "runtime": "openclaw",
  "runtime_ref": "v2026.3.13-1",
  "runtime_status": "active",
  "output_dir": "runtimes/openclaw/agents/analyst",
  "capabilities": [],
  "diagnostics": []
}
```

### Capability Entry Shape

```json
{
  "key": "execution.model",
  "outcome": "supported",
  "message": ""
}
```

### Canonical Capability Keys

The compiler should use these keys by default:

- `workspace.docs.identity`
- `workspace.docs.soul`
- `workspace.docs.system`
- `workspace.docs.memory`
- `workspace.docs.heartbeat`
- `workspace.docs.extras.<name>`
- `skills.<name-or-ref>`
- `mcp.<name>`
- `execution.model`
- `execution.sandbox`
- `agent.schedule`
- `workspace.resources`
- `agent.subagents`
- `team.members`
- `team.mode`
- `team.lead`
- `team.external`
- `team.roster`
- `team.context_orientation`
- `team.representatives`
- `team.networks`
- `team.networks.<provider>`
- `team.networks.<provider>.<network-id-key>`
- `team.shared`
- `team.nested`
- `surfaces.<name>.identity`

Adapters may add runtime-specific keys under:

- `runtime.options.*`
- `runtime.native.*`

Those keys are informative, not part of the portable core.

### Container Report Extension

The compile report may include a `container` object describing the generated container artifacts for the full compile graph.

At minimum, this should cover:

- generated root files (`Dockerfile`, `entrypoint.sh`, `.env.example`)
- installed runtimes
- published ports
- required model/runtime secrets
- runtime instance config/home paths
- effective model auth methods per runtime instance

---

## Recommended Validation Phases

Validation should happen in three layers:

### 1. Static Validation

- YAML validity
- required fields
- path existence
- basic enum checks
- duplicate names and ids

### 2. Graph Validation

- cycle detection
- duplicate node resolution conflicts
- runtime resolution
- team mode/lead/external references
- team representative resolution
- team network member references
- duplicate Moltnet `member_id` detection across reachable nested teams
- skill `requires.mcp` resolution
- duplicate `workspace.resource` IDs and overlapping agent-visible mounts within each concrete agent context
- duplicate workspace resource identities within inherited resource sets and incompatible shared resource definitions
- `team.networks[].server` normalization checks (mode/store/auth/client/path/token/pairings compatibility)
- `team.networks[].server` mode/auth/store/dms and pairings compatibility checks
- schedule lowering checks against declared adapter wake contracts

### 3. Adapter Validation

- runtime option validation
- runtime-native config constraints
- capability preservation checks

This split will make error reporting much easier to keep sane.

---

## Container Compilation

After adapters emit runtime-specific files, the compiler generates container artifacts at the output root.

See `CONTAINERS.md` for the full spec. The key rule is:

- one compile = one container
- the Dockerfile and entrypoint are derived from adapter-provided container metadata
- all agents, subagents, and team members in the compile graph share a single container

This is part of the main compile pipeline, not a separate authoring step.

### Moltnet Team Conversation E2E

Compiler unit tests are not sufficient to prove that emitted team-network artifacts can coordinate at runtime. Spawnfile v0.1 requires an opt-in, release-gating Moltnet conversation E2E for the team-network contract.

The E2E should compile, build, and run a fixture with a parent team, nested child teams, explicit child representatives, a parent Moltnet room, and at least one representative that also belongs to its own child-team room. It must verify behavior through Moltnet room history rather than runtime stdout:

- parent room membership is exactly the direct parent agent plus selected child representatives
- non-representative descendants are absent from the parent room
- a real agent-to-agent exchange occurs in the parent room using `moltnet send`
- the same representative can also answer in its child room
- room history contains expected sentinels and compiled Moltnet member IDs
- failures print Docker logs and relevant room histories

Slack, Discord, Telegram, and WhatsApp do not require equivalent team-chat E2Es for this contract because Spawnfile only carries their declared identity/roster metadata. Moltnet is the provider Spawnfile provisions and lowers.

## Coverage Targets

Compiler and adapter verification should target feature behavior, not statement/line counts.

At minimum for v0.1:

- 90% coverage of feature-behavior scenarios for schedules, resources, roster generation, and team-network lowering.
- Line-based metrics are allowed for tooling only and are not an acceptance gate by themselves.
- Any behavior in `specs/` not covered by tests is a blocker for feature completion.

---

## Deferred For Later Versions

These should stay out of the core compiler architecture for v0.1:

- package builders
- publish flows
- lockfile and reproducibility records
- runtime-native auth bootstrap
- runtime-native chat features outside declared portable surfaces
- memory engine contracts
- multi-container orchestration (Docker Compose, Kubernetes, etc.)

---

## First Fixtures

Before building adapters, the compiler should be tested against three canonical source projects:

1. Single agent
   - one runtime
   - docs, skills, MCP, execution
2. Agent with subagents
   - inherited runtime
   - merged execution
3. Multi-runtime team
   - direct members on different runtimes
   - shared skills/MCP
   - team with mode and lead

If these three fixtures compile cleanly and produce stable reports, the v0.1 foundation is strong enough to start adapters.
