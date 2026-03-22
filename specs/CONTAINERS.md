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
├── container/
│   └── rootfs/
│       └── var/lib/spawnfile/instances/...
├── runtimes/
│   ├── openclaw/agents/analyst/...
│   └── picoclaw/agents/editor/...
└── spawnfile-report.json
```

The `Dockerfile` and `entrypoint.sh` are derived from the compile plan. They are not templates chosen by the user — the compiler generates them based on the resolved graph.

`runtimes/` is the human-inspectable adapter output. `container/rootfs/` is the final container filesystem emitted by the compiler for build-time placement into the runtime's expected paths.

---

## Dockerfile Generation

### Base Image

Each runtime adapter should declare:

- a standalone base image or install strategy aligned with the pinned runtime ref
- system dependencies required
- the expected config and workspace paths inside the container
- the start command and any runtime env it needs

For single-runtime compiles, the Dockerfile uses that runtime's standalone base image or install strategy directly.

For multi-runtime compiles, the Dockerfile should use a common base and install each runtime.

### Runtime Installation

Each adapter should expose enough information to generate install steps:

```typescript
interface RuntimeContainerMeta {
  configFileName: string;
  configPathEnv?: string;
  env?: Array<{
    description: string;
    name: string;
    required: boolean;
  }>;
  homeEnv?: string;
  instancePaths: {
    configPathTemplate: string;
    homePathTemplate?: string;
    workspacePathTemplate: string;
  };
  port?: number;
  portEnv?: string;
  standaloneBaseImage: string;
  startCommand: string[];
  staticEnv?: Record<string, string>;
  systemDeps: string[];
}

interface ContainerTarget {
  id: string;
  files: EmittedFile[];
  envFiles?: Array<{
    envName: string;
    relativePath: string;
  }>;
}
```

The compiler uses this metadata to compose the Dockerfile and entrypoint. Adapters own their runtime's container story; the compiler just stitches them together.

### Pinned Versions

The runtime version used in the Dockerfile should match the pinned `ref` from `runtimes.yaml`. This keeps the compiled container aligned with the runtime version the adapters were written against.

`spawnfile compile` itself should not require local runtime clones on the compiler machine. The compile step reads the registry metadata and adapter contracts; the Docker build step is responsible for fetching or installing the pinned runtime artifact.

The v0.1 reference implementation currently uses pinned source-checkout install recipes. Other install strategies may be added later, but they must stay aligned with the pinned ref.

---

## Entrypoint Generation

The entrypoint script is responsible for:

1. Validating required env and required files
2. Materializing env-backed secret files when a runtime expects file-based auth
3. Starting the runtime process(es)

### Single-Runtime

For a single runtime, the compiler should prefer build-time placement into the runtime's final config and workspace paths under `container/rootfs/`.

The entrypoint should then stay minimal:

- validate required env vars
- validate that the compiled config exists at the expected final path
- write env-backed secret files when needed
- `exec` the runtime's start command

### Multi-Runtime

For multiple runtimes in one container, the compiler should still pre-place config and workspace files into final paths at build time.

The entrypoint then:

- validates required env and config for each target
- writes env-backed secret files for each target when needed
- starts each runtime process
- traps signals and forwards them to all child processes
- waits for all processes

This follows the pattern used by existing multi-agent deployments (e.g. picoclaw multi-gateway entrypoints that spawn one process per agent and manage the process group).

### Single Agent vs Team vs Subagents

- **Single agent**: one runtime process, one config
- **Agent with subagents**: one runtime process — the runtime itself manages subagent delegation internally
- **Team with members on one runtime**: one runtime process with multi-agent config (if the runtime supports it), or one process per agent
- **Team with members on multiple runtimes**: one process group, one runtime process per distinct runtime

The entrypoint does not need to understand agent semantics. It only needs to know which runtime processes to start, which env files to materialize, and where the final compiled config already lives.

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

If a runtime expects secret file references in its config, the adapter should declare those env-to-file bindings and the entrypoint should materialize them before startup.

---

## Adapter Container Contract

Each runtime adapter should expose container metadata as part of its adapter interface, plus optional per-target container overrides such as env-backed secret files.

The compiler calls each relevant adapter for its container metadata and container targets, then composes the Dockerfile and entrypoint from the combined metadata.

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
- emitted Docker `HEALTHCHECK` instructions or richer readiness contracts
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

Adapter verification at the pinned ref should include:

- `spawnfile compile`
- `spawnfile build`
- `docker build`
- `docker run`
- a host-side smoke check against the runtime's exposed health or API endpoint when the runtime exposes network services

---

## Developer Workflow

The intended workflow for testing compiled output:

```bash
# compile and build the container
spawnfile build fixtures/single-agent --out ./dist/single-agent --tag my-agent

# create .env from example
cp dist/single-agent/.env.example dist/single-agent/.env
# fill in secrets...

# run
docker run --env-file dist/single-agent/.env my-agent
```

For teams:

```bash
spawnfile build fixtures/multi-runtime-team --out ./dist/team --tag my-team
cp dist/team/.env.example dist/team/.env
docker run --env-file dist/team/.env my-team
```

Same flow regardless of project complexity. One compile, one build, one run.

`spawnfile compile` still emits a standard Docker build context, so manual `docker build` remains supported when developers want to inspect or tweak the emitted output before building the image.
