# Container Compilation v0.1

This document specifies how the Spawnfile compiler emits container artifacts alongside runtime-specific config and workspace files.

The goal is simple: `spawnfile compile` should produce output that can be built and run with `docker build` and `docker run`, giving developers and operators a way to verify that compiled output actually works against the real runtime.

---

## Core Rule

One compile = one container.

The compiler walks the full graph from the root Spawnfile. Everything it resolves — agents, subagents, team members — lands in a single container image. This applies regardless of:

- how many Spawnfiles are in the graph
- how many agents or subagents are resolved
- how many distinct runtimes appear in the compile plan

---

## Output Layout

The compiler should emit container artifacts at the compile output root, alongside the existing runtime output:

```text
dist/
├── Dockerfile
├── entrypoint.sh
├── .env.example
├── runtimes/
│   ├── openclaw/agents/analyst/...
│   └── picoclaw/agents/editor/...
└── spawnfile-report.json
```

The `Dockerfile` and `entrypoint.sh` are derived from the compile plan. They are not templates chosen by the user — the compiler generates them based on the resolved graph.

---

## Dockerfile Generation

### Base Image

Each runtime adapter should declare:

- a base image or install strategy (e.g. `npm install -g openclaw@latest`, `FROM sipeed/picoclaw:latest`)
- system dependencies required
- the expected config and workspace paths inside the container

For single-runtime compiles, the Dockerfile uses that runtime's base image or install strategy directly.

For multi-runtime compiles, the Dockerfile should use a common base (e.g. `node:22-bookworm-slim`) and install each runtime.

### Runtime Installation

Each adapter should expose enough information to generate install steps:

```yaml
containerMeta:
  base_image: node:22-bookworm-slim          # or null if using install strategy
  official_image: sipeed/picoclaw:latest      # if available
  install: npm install -g openclaw@latest     # package install command
  system_deps:                                # apt packages needed
    - git
    - bash
    - ca-certificates
  config_dir: /data/openclaw                  # where config lives
  workspace_dir: /data/openclaw/workspace     # where workspace docs go
  bin: openclaw                               # CLI binary name
```

The compiler uses this metadata to compose the Dockerfile. Adapters own their runtime's container story; the compiler just stitches them together.

### Pinned Versions

The runtime version used in the Dockerfile should match the pinned `ref` from `runtimes.yaml`. This keeps the compiled container aligned with the runtime version the adapters were written against.

If the adapter's install command supports version pinning (e.g. `npm install -g openclaw@v2026.3.13-1`), the compiler should use the pinned version. Otherwise, it should note this in the compile report as a diagnostic.

---

## Entrypoint Generation

The entrypoint script is responsible for:

1. Provisioning compiled config and workspace files into the paths the runtime expects
2. Starting the runtime process(es)

### Single-Runtime

For a single runtime, the entrypoint:

- copies or symlinks compiled config into the runtime's config path
- copies compiled workspace files into the runtime's workspace path
- execs the runtime's start command

### Multi-Runtime

For multiple runtimes in one container, the entrypoint:

- provisions each runtime's config and workspace files
- starts each runtime process
- traps signals and forwards them to all child processes
- waits for all processes

This follows the pattern used by existing multi-agent deployments (e.g. picoclaw multi-gateway entrypoints that spawn one process per agent and manage the process group).

### Single Agent vs Team vs Subagents

- **Single agent**: one runtime process, one config
- **Agent with subagents**: one runtime process — the runtime itself manages subagent delegation internally
- **Team with members on one runtime**: one runtime process with multi-agent config (if the runtime supports it), or one process per agent
- **Team with members on multiple runtimes**: one process group, one runtime process per distinct runtime

The entrypoint does not need to understand agent semantics. It only needs to know which runtime processes to start and which config to provision for each.

---

## Environment and Secrets

The compiler should emit a `.env.example` file listing all required and optional environment variables:

- secrets declared in manifests (e.g. `SEARCH_API_KEY`)
- runtime auth variables (e.g. `ANTHROPIC_API_KEY`)
- any variables the entrypoint or runtime expects

Actual secret values are never emitted. The `.env.example` contains variable names with empty values and comments describing their purpose.

At runtime, secrets are injected via:

- `--env-file` on `docker run`
- environment variable pass-through
- mounted secret files

---

## Adapter Container Contract

Each runtime adapter should expose container metadata as part of its adapter interface. Suggested shape:

```typescript
interface ContainerMeta {
  /** Base image for standalone use, or null to use common base */
  officialImage?: string;

  /** Install command when using common base */
  install: string;

  /** System packages needed (apt-get) */
  systemDeps: string[];

  /** Path where runtime config should be placed */
  configDir: string;

  /** Path where workspace docs should be placed */
  workspaceDir: string;

  /** CLI binary name */
  bin: string;

  /** Default start command */
  startCommand: string[];

  /** Default exposed port, if any */
  port?: number;
}
```

The compiler calls each relevant adapter for its `ContainerMeta`, then composes the Dockerfile and entrypoint from the combined metadata.

---

## Compile Report Extensions

The compile report should include a `container` section:

```json
{
  "container": {
    "runtimes_installed": ["openclaw", "picoclaw"],
    "dockerfile": "Dockerfile",
    "entrypoint": "entrypoint.sh",
    "env_example": ".env.example",
    "secrets_required": ["SEARCH_API_KEY", "ANTHROPIC_API_KEY"],
    "ports": [3000]
  }
}
```

---

## What This Does Not Cover

These are explicitly out of scope for v0.1 container compilation:

- Docker Compose generation for multi-container topologies
- Orchestration (Kubernetes, ECS, Fly, etc.)
- Image publishing and registry
- Runtime-native auth bootstrap (onboarding flows stay manual)
- Health checks beyond basic process liveness
- Volume management and persistence strategy
- Network topology between containers
- CI/CD integration

---

## Validation

The compiler should verify at compile time:

- every runtime in the compile plan has container metadata
- all declared secrets are listed in the `.env.example`
- all runtime bins are installed in the Dockerfile
- config and workspace paths do not collide across runtimes

At build/run time, validation is the container's responsibility — the entrypoint should fail fast with clear errors if required config or secrets are missing.

---

## Developer Workflow

The intended workflow for testing compiled output:

```bash
# compile the project
spawnfile compile fixtures/single-agent --out ./dist/single-agent

# build the container
cd dist/single-agent
docker build -t my-agent .

# create .env from example
cp .env.example .env
# fill in secrets...

# run
docker run --env-file .env my-agent
```

For teams:

```bash
spawnfile compile fixtures/multi-runtime-team --out ./dist/team
cd dist/team
docker build -t my-team .
docker run --env-file .env my-team
```

Same flow regardless of project complexity. One compile, one build, one run.
