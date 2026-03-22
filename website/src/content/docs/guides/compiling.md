---
title: Compiling
description: How the Spawnfile compile pipeline works, from manifest loading to adapter output, including the output layout and compile report.
---

The `spawnfile compile` command takes a Spawnfile project and produces runtime-specific output files plus a machine-readable compile report. This guide explains the pipeline, output layout, and report format.

## The Compile Pipeline

The reference compiler follows this pipeline:

1. **Parse** the root `Spawnfile`.
2. **Validate** local schema and file references.
3. **Walk** the manifest graph through `members[*].ref` and `subagents[*].ref`.
4. **Detect** cycles and incompatible duplicate references.
5. **Resolve** effective `runtime` and `execution` for every graph node.
6. **Build** a normalized intermediate representation (IR).
7. **Group** resolved nodes by runtime.
8. **Invoke** runtime adapters.
9. **Emit** output directories and `spawnfile-report.json`.

The compiler operates on resolved IR after the graph phase, not on raw YAML. Adapters receive fully resolved nodes with all inheritance applied.

## Validation Phases

Validation happens in three layers:

### Static Validation

- YAML validity
- Required fields (`spawnfile_version`, `kind`, `name`)
- Path existence for docs, skills, and member/subagent refs
- Enum checks (transport, isolation, sandbox mode)
- Duplicate name/id detection

### Graph Validation

- Cycle detection across teams and subagents
- Duplicate node resolution conflicts (same path, different effective config)
- Runtime resolution (every agent must have an effective runtime)
- Skill `requires.mcp` resolution against visible MCP scope

### Adapter Validation

- Runtime option validation
- Runtime-native config constraints
- Capability preservation checks

You can run validation without compiling using `spawnfile validate`:

```bash
spawnfile validate ./my-agent
```

This performs static and graph validation without invoking adapters or emitting output.

## Graph Resolution

### Node Identity

Graph nodes are keyed by canonical manifest path. One manifest path equals one logical node. If the same path is referenced multiple times, all references must resolve to the same effective `runtime` and `execution`. Otherwise the compiler fails.

### Edge Kinds

The compiler tracks two edge kinds:

- `team_member` -- from a team to one of its members
- `subagent` -- from a parent agent to one of its subagents

Adapters may treat these edge types very differently.

### Effective Resolution

- For agents: `runtime` is declared in the manifest.
- For subagents: `runtime` is inherited from the parent. If the subagent declares `runtime`, it must match the parent.
- For execution: parent `execution` is deep-merged with child `execution`. Objects merge recursively, scalars replace, arrays replace wholesale.
- For team members: each member declares its own runtime. Teams do not override member runtimes.

## Adapter Contract

Runtime adapters implement two operations:

- `compileAgent` (required) -- takes a resolved agent node, emits files and capability outcomes.
- `compileTeam` (optional) -- takes a resolved team node, emits native team artifacts if the runtime supports them.

Each operation returns:
- **files** -- emitted files relative to the node's output directory
- **capabilities** -- per-capability outcomes (`supported`, `degraded`, or `unsupported`)
- **diagnostics** -- warnings and errors discovered by the adapter

Every agent node is always compilable independently by its runtime adapter. Team compilation is optional and adapter-dependent.

For multi-runtime teams, the compiler compiles each member agent independently and reports any loss of native team semantics.

## Output Layout

The default output root is `./dist`. Within that root:

```text
dist/
  spawnfile-report.json
  runtimes/
    openclaw/
      agents/
        analyst/
      teams/
        research-cell/
    picoclaw/
      agents/
        researcher/
```

Rules:
- One directory per runtime
- One stable directory per compiled node
- Agent and team outputs are separated
- The report file is always at the root

Use `--out` to change the output directory:

```bash
spawnfile compile ./my-agent --out ./build
```

## Compile Report

The compiler emits a JSON report at `spawnfile-report.json` in the output root.

### Top-Level Shape

```json
{
  "spawnfile_version": "0.1",
  "root": "/abs/path/to/Spawnfile",
  "nodes": [],
  "diagnostics": []
}
```

### Node Entry

Each compiled graph node gets an entry:

```json
{
  "id": "agent:analyst",
  "kind": "agent",
  "source": "/abs/path/to/Spawnfile",
  "runtime": "openclaw",
  "output_dir": "runtimes/openclaw/agents/analyst",
  "capabilities": [],
  "diagnostics": []
}
```

### Capability Outcomes

For every declared capability, the compiler reports one of:

| Outcome | Meaning |
|---------|---------|
| `supported` | Fully preserved in the target with equivalent intent |
| `degraded` | Partially mapped; runtime behavior may differ |
| `unsupported` | Cannot be expressed in the target |

Example:

```json
{
  "key": "execution.model",
  "outcome": "supported",
  "message": ""
}
```

### Canonical Capability Keys

The compiler reports on these keys:

- `docs.identity`, `docs.soul`, `docs.system`, `docs.memory`, `docs.heartbeat`, `docs.extras.<name>`
- `skills.<name-or-ref>`
- `mcp.<name>`
- `execution.model`, `execution.workspace`, `execution.sandbox`
- `agent.subagents`
- `team.members`, `team.structure.mode`, `team.structure.leader`, `team.structure.external`, `team.shared`, `team.nested`

Adapters may add runtime-specific keys under `runtime.options.*` and `runtime.native.*`.

## Policy Enforcement

The compile report is always emitted regardless of policy. What changes is whether degradation stops the build:

- `policy.mode: permissive` -- continues, records outcomes
- `policy.mode: warn` -- continues with warnings
- `policy.mode: strict` -- fails on any unverifiable capability

- `policy.on_degrade: allow` -- degradations are silent
- `policy.on_degrade: warn` -- degradations produce warnings
- `policy.on_degrade: error` -- degradations fail the build

## CLI Commands

```bash
# Compile the project in the current directory
spawnfile compile

# Compile a specific project
spawnfile compile ./fixtures/single-agent

# Compile with custom output directory
spawnfile compile ./fixtures/single-agent --out ./build

# Validate without compiling
spawnfile validate ./fixtures/single-agent

# Scaffold a new agent project
spawnfile init

# Scaffold a new team project
spawnfile init --team
```
