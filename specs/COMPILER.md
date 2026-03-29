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
- emit stable outputs plus a machine-readable compile report

It should not try to solve packaging, publishing, deployment orchestration, or runtime-native channel setup in v0.1.

---

## Compiler Pipeline

The reference pipeline is:

1. Parse the root `Spawnfile`.
2. Validate local schema and file references.
3. Walk the manifest graph through `members[*].ref` and `subagents[*].ref`.
4. Detect cycles and incompatible duplicate references.
5. Resolve effective `runtime` and `execution` for every graph node.
6. Resolve `description` for every agent node (from manifest or derived from docs).
7. Build a normalized intermediate representation.
8. For team roots, generate per-member rosters.
9. Group resolved nodes by runtime.
10. Invoke runtime adapters.
11. Emit runtime output directories (including rosters in agent workspaces).
12. Generate container artifacts from adapter container metadata.
13. Emit `spawnfile-report.json`.

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

The compiler resolves effective configuration during graph walking, not as a separate pass. Each node's effective runtime, execution, and surfaces are computed when the node is first visited, and the result is cached by canonical manifest path with a fingerprint to detect conflicting resolutions.

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
docs: {}
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

`description` is the agent's short summary. If the manifest does not declare one, the compiler derives it from `docs.identity` by extracting the first non-empty paragraph, truncated to 200 characters. If no `docs.identity` is declared, the description is left empty.

### Resolved Team

```yaml
kind: team
id: team:research-cell
source: /abs/path/to/Spawnfile
description: "Research team that finds, analyzes, and writes up findings"
docs: {}
shared:
  skills: []
  mcp_servers: []
  env: {}
  secrets: []
members: []
mode: swarm
lead: null
external: []
auth: null
```

Note: `mode`, `lead`, `external`, and `auth` are top-level team fields, not nested under `structure`. `auth` is `null` when the team manifest omits it.

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

When compiling a team, the compiler generates a roster for each direct member after resolving all member nodes.

### Compilation Steps

1. Resolve each member's `description` — from the agent manifest's `description` field, or derived from `docs.identity` if available.
2. Compute reachability based on `mode`:
   - `hierarchical`: non-lead members can only reach the lead. The lead can reach all members.
   - `swarm`: all members can reach all other members.
3. Resolve each member's HTTP endpoint — from the agent's `surfaces.http` config, or auto-enabled if not declared.
4. Generate a per-member roster YAML at `{workspace}/.spawnfile/roster.yaml`.
5. Register the roster in the doc injection pipeline with `role: roster`.
6. Generate a `team_message` MCP server script for each member. The script exposes one tool that POSTs to teammate endpoints using the roster data.
7. Inject the `team_message` MCP server into each member's `mcp_servers` list during compilation.

### Roster Schema

```yaml
team: research-cell
mode: hierarchical
lead: orchestrator
self: researcher
external: false
auth:
  mode: shared_secret
  secret_env: TEAM_SHARED_SECRET

members:
  - name: orchestrator
    role: lead
    description: "Coordinates the research team, assigns tasks, synthesizes results"
    endpoint: http://localhost:9100/route/orchestrator/v1/messages
  - name: writer
    role: member
    description: "Writes reports and articles from research findings"
    endpoint: http://localhost:9100/route/writer/v1/messages
```

The `auth` block is present only when the team manifest declares `team.auth`. The `endpoint` is the HTTP URL where each teammate receives messages. For same-container deployments, endpoints route through the surface router on localhost. For cross-container or cross-network deployments, endpoints are the agent's actual HTTP surface URLs.

The `team_message` MCP tool (compiler-generated for each team member) uses these endpoints to deliver messages. Auth is attached automatically when `team.auth` is declared.

The roster is a per-member view:

- `self` identifies which member this roster belongs to. The self agent does not appear in `members`.
- `external` indicates whether this member can communicate outside the team (from the team's `external` list).
- `role` is `lead` for the team lead, `member` for everyone else. For nested team entries, `role` is `team`.
- `description` comes from each agent's resolved description.
- In `hierarchical` mode, non-lead members only see the lead in their roster. The lead sees all members.
- In `swarm` mode, all members see all other members.

For nested team members, the inner team appears as a single entry with `role: team` and its own description. The outer team does not see the inner team's individual members.

### Compile Report

The compile report should include a `roster` entry for each team member documenting whether the roster was generated successfully.

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

- `docs.identity`
- `docs.soul`
- `docs.system`
- `docs.memory`
- `docs.heartbeat`
- `docs.extras.<name>`
- `skills.<name-or-ref>`
- `mcp.<name>`
- `execution.model`
- `execution.workspace`
- `execution.sandbox`
- `agent.subagents`
- `team.members`
- `team.mode`
- `team.lead`
- `team.external`
- `team.auth`
- `team.roster`
- `team.shared`
- `team.nested`

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
- skill `requires.mcp` resolution

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

---

## Deferred For Later Versions

These should stay out of the core compiler architecture for v0.1:

- package builders
- publish flows
- lockfile and reproducibility records
- runtime-native auth bootstrap
- public chat surfaces as portable schema
- workflow schedulers
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
