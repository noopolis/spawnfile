# Spawnfile

> *Canonical source for autonomous agents. Write once. Compile to any runtime.*

---

## What Spawnfile Is

Spawnfile is a spec and source format for declaring autonomous agents and teams independently of the runtime that will host them.

A Spawnfile source project is a directory you own and version. It describes the portable parts of an agent: markdown identity docs, skills, MCP connections, runtime binding, execution intent, and team structure.

`spawnfile compile` lowers that canonical source into runtime-specific config and workspace files. It is not a runtime-to-runtime translator. The compiler starts from the canonical source and emits each declared adapter's output.

---

## V0.1 Scope

Spawnfile v0.1 targets **autonomous agent runtimes** — systems that host agents as long-lived services with markdown workspace identity. It focuses on the portable surface shared across compatible runtimes:

- identity and personality docs (SOUL.md, IDENTITY.md, AGENTS.md)
- memory and heartbeat intent docs
- skills with SKILL.md
- MCP declarations
- runtime binding
- execution intent (model, workspace, sandbox)
- team structure (members, hierarchy, shared surfaces)

v0.1 does not try to standardize every runtime-native feature. Communication surfaces, memory engines, task schedulers, UI surfaces, and other runtime-specific features stay adapter-defined for now.

---

## Companion Docs

- `specs/INDEX.md` - map of all specs with status and relationships
- `specs/SPEC.md` - canonical Spawnfile source spec
- `specs/COMPILER.md` - v0.1 compiler architecture, graph resolution, and adapter contract
- `specs/CONTAINERS.md` - container compilation spec
- `specs/RUNTIMES.md` - runtime registry, version pinning, and adapter lifecycle
- `specs/research/` - per-runtime research notes and adapter strategies
- `fixtures/` - canonical v0.1 source projects for compiler validation

---

## Technology

Spawnfile v0.1 is implemented as a Node.js CLI in TypeScript.

- runtime: Node.js 22+
- CLI: `commander`
- manifest parsing: `yaml` + `zod`
- tests: `vitest`

That gives us fast iteration, a conventional `bin`-based CLI, and a clean path to future install surfaces such as npm or a shell bootstrapper.

---

## Install

From a repository checkout:

```bash
nvm use
npm install
npm run build
npm link
```

Or use the bootstrap script:

```bash
./scripts/install.sh
```

Then:

```bash
spawnfile --help
```

To clone the target runtimes and generate reference blueprints:

```bash
npm run runtimes:sync
```

This clones each runtime at the version pinned in `runtimes.yaml` and generates blueprints showing the expected config and workspace layout. See `blueprints/` for the output.

For local development without linking globally:

```bash
npm run dev -- validate fixtures/single-agent
```

---

## Why

The autonomous agent runtimes are different, but they already share a meaningful core: markdown workspace identity, skill folders, MCP, model selection, and workspace isolation. Today that core is re-authored by hand for each runtime. Spawnfile makes it canonical.

---

## How It Works

You write a source project once. Then you compile it:

```bash
spawnfile init
spawnfile validate
spawnfile compile
```

For a single agent, the compiler uses that manifest's declared runtime. For a team, it walks the member graph and compiles each member using that member's declared runtime.

Each adapter maps the canonical project into runtime-native forms. If a runtime cannot preserve a declaration, the compiler reports `supported`, `degraded`, or `unsupported` according to the project's compile policy.

Each compile also produces a machine-readable report describing the resolved graph, chosen runtimes, output locations, and capability outcomes.

The portable model stays intentionally small:

- `runtime` names the host runtime and may carry runtime-specific options
- `execution` carries portable intent like model, workspace, and sandbox
- `agent` may hold internal `subagents`
- `team` is for first-class agents that coordinate as a group

---

## Project Structure

A source project has a `kind` - either `agent` or `team`.

### Agent

```text
my-agent/
├── Spawnfile
├── IDENTITY.md
├── SOUL.md
├── AGENTS.md
├── MEMORY.md
├── HEARTBEAT.md
├── subagents/
│   └── researcher/
│       └── Spawnfile
└── skills/
    ├── web_search/
    │   └── SKILL.md
    └── memory_store/
        └── SKILL.md
```

Not every file is required. Spawnfile names portable document roles; adapters decide how to lower them into target-native surfaces.

### Team

```text
my-team/
├── Spawnfile
├── TEAM.md
├── shared/
│   └── skills/
│       └── web_search/
│           └── SKILL.md
└── agents/
    ├── orchestrator/
    │   ├── Spawnfile
    │   └── AGENTS.md
    ├── researcher/
    │   ├── Spawnfile
    │   └── SOUL.md
    └── writer/
        ├── Spawnfile
        └── SOUL.md
```

Teams can reference agents or other teams. Team structure (hierarchy, leadership) is part of the canonical model, but preservation is target-dependent and explicitly reported by the compiler.
Team members may be on the same runtime or on different runtimes depending on what each member declares.

An `agent` may also declare internal `subagents`. Those are not the same as a `team`: they are helper agents owned by a parent agent and lowered according to that runtime's own delegation or subagent model.

---

## Policy

Not every target supports every declared capability. Spawnfile makes that explicit:

```yaml
policy:
  mode: strict
  on_degrade: error
```

The compiler reports one of three outcomes per declared capability: `supported`, `degraded`, or `unsupported`.

---

## The CLI

```bash
spawnfile init
spawnfile init --team
spawnfile validate
spawnfile compile
```

For example:

```bash
spawnfile validate fixtures/single-agent
spawnfile compile fixtures/single-agent --out ./dist/example
```

The compiler emits runtime-specific artifacts under `dist/runtimes/...` and writes a machine-readable `spawnfile-report.json`.

---

## The Builder

**spawnfile.ai** is a web-based authoring surface for the canonical format. It walks through docs, skills, MCP, runtime binding, execution intent, and team composition, then produces a source project you own and can edit by hand.

---

## The Name

**Spawn** - in computing, you spawn a process. In games, you spawn a character. In biology, you spawn life. Deliberate creation. Independent existence from that point forward.

**File** - the atomic unit of software. Something you can read, version, fork, check into git, and own completely. It anchors a project - a directory, a complete picture of what something is.

Together: *a canonical source project that spawns an agent and can be compiled into the runtimes that can host it.*

---

*One source format. Many runtimes. Manifest-driven compilation.*

**spawnfile.ai** · **github.com/noopolis/spawnfile**
