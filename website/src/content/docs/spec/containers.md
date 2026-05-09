---
title: Container Compilation
description: How the Spawnfile compiler emits Docker container artifacts -- Dockerfile generation, entrypoint scripts, environment handling, and the adapter container contract.
---

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
.spawn/
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

This is the default hidden output root. `--out <dir>` may be used to export the same artifacts into a visible directory when needed.

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
  configEnvBindings?: Array<{
    envName: string;
    jsonPath: string;
  }>;
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

The runtime version used in the Dockerfile should match the pinned registry metadata from `runtimes.yaml`. This keeps the compiled container aligned with the runtime version the adapters were written against.

`spawnfile compile` itself should not require local runtime clones on the compiler machine. The compile step reads the registry metadata and adapter contracts; the Docker build step is responsible for fetching or installing the pinned runtime artifact.

The v0.1 reference implementation uses pinned compiled runtime artifacts:

- npm packages where the runtime publishes them
- release archives or bundles where the runtime ships them

Generated Dockerfiles must not clone runtime repositories or rebuild runtime sources during image build.

---

## Entrypoint Generation

The entrypoint script is responsible for:

1. Validating required env and required files
2. Materializing env-backed secret files when a runtime expects file-based auth
3. Materializing env-backed runtime config fields when a runtime stores auth in config
4. Preparing workspace resources and managed state before startup
5. Starting any managed Moltnet services and runtime process(es)

### Single-Runtime

For a single runtime, the compiler should prefer build-time placement into the runtime's final config and workspace paths under `container/rootfs/`.

The entrypoint should then stay minimal:

- validate required env vars
- validate that the compiled config exists at the expected final path
- write env-backed secret files when needed
- patch runtime-native config fields from env when needed
- prepare workspace resources and managed Moltnet services
- `exec` the runtime's start command

### Multi-Runtime

For multiple runtimes in one container, the compiler should still pre-place config and workspace files into final paths at build time.

The entrypoint then:

- validates required env and config for each target
- writes env-backed secret files for each target when needed
- patches runtime-native config fields from env when needed
- starts each runtime process
- prepares workspace resources and managed Moltnet services
- traps signals and forwards them to all child processes
- waits for all processes

This follows the pattern used by existing multi-agent deployments (e.g. picoclaw multi-gateway entrypoints that spawn one process per agent and manage the process group).

### Workspace Resource Lifecycle

For each effective `workspace.resource` attached to a concrete agent lifecycle, startup must enforce mount behavior:

- Resolve the declared `mount` to the agent-visible link path:
  - `./path` and `${workspace}/path` resolve under the concrete runtime workspace.
  - `/absolute/path` is used as an explicit container path.
- Prepare the resource under Spawnfile-managed backing storage.
- Expose the backing path at the agent-visible link path with a symlink before the runtime starts.
- `volume` resources: create backing directories and verify ownership/permissions before first launch.
- `git` resources:
  - clone into empty backing paths using declared selector (`branch`, `tag`, or `ref`)
  - reuse compatible existing checkouts when present
  - fail fast when the backing path contains an incompatible checkout

Compatibility uses exact remote URL match (after trim) and exact selector match.

The compiler does not perform git mutation at build time.

`sharing: per_agent` resources use backing storage scoped to the concrete runtime target. `sharing: team` volume resources use backing storage scoped to the team where the resource was declared, so all inheriting concrete members see the same files at their own workspace-relative link paths.

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
- model auth variables for providers that still use `api_key` auth (e.g. `ANTHROPIC_API_KEY`)
- surface auth variables for declared communication surfaces (e.g. `DISCORD_BOT_TOKEN`)
- runtime auth variables (e.g. `OPENCLAW_GATEWAY_TOKEN`)
- Moltnet auth/store variables declared under managed/external server blocks (for example `MOLTNET_STORE_DSN` or static attachment token names)
- any variables the entrypoint or runtime expects

Actual secret values are never emitted. The `.env.example` contains variable names with empty values and comments describing their purpose.

At runtime, secrets are injected via:

- `--env-file` on `docker run`
- environment variable pass-through
- mounted secret files

If a runtime expects secret file references in its config, the adapter should declare those env-to-file bindings and the entrypoint should materialize them before startup.

Model auth intent itself is declared on each source model target under `execution.model.primary` and `execution.model.fallback[*]`. The compile output should therefore reflect:

- which provider/runtime instances still require `api_key` env at run time
- which provider/runtime instances expect imported CLI credential stores such as `claude-code` or `codex`
- which declared communication surfaces require env-backed secrets at run time

## Moltnet Storage and Secret Materialization

Container startup must support Moltnet server and node artifacts emitted from `team.networks[].server`:

- `server.store.kind: sqlite` and `server.store.kind: json` create durable directories for the configured `path` before server start.
- `server.store.kind: postgres` injects `server.store.dsn_secret` into runtime config and skips local path creation.
- `server.store.kind: memory` creates no local persistence directory.

Secret materialization rules:

- `server.auth.tokens[].secret` is never written into source-controlled files.
- `server.auth.tokens[].secret` is written into private Moltnet config values at runtime start.
- `server.store.dsn_secret` is written as `storage.postgres.dsn` in managed server config.
- `server.pairings[].token_secret` is written as `pairings[].token` in managed server config.
- Generated open-mode token files for attach/self-claiming clients are runtime state files with private permissions (equivalent to `0600`), and token directories use private directory mode (equivalent to `0700`).

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
    "model_secrets_required": ["ANTHROPIC_API_KEY"],
    "runtime_secrets_required": ["OPENCLAW_GATEWAY_TOKEN"],
    "runtime_homes": ["/var/lib/spawnfile/instances/openclaw/agent-analyst/home"],
    "workspace_resources": [
      {
        "id": "project-repo",
        "kind": "git",
        "mount": "./repos/project",
        "link_path": "/var/lib/spawnfile/instances/openclaw/agent-analyst/home/.openclaw/workspace/repos/project",
        "backing_path": "/var/lib/spawnfile/resources/instances/agent-analyst-00000000/project-repo-00000000",
        "mode": "mutable",
        "sharing": "per_agent"
      }
    ],
    "secrets_required": ["SEARCH_API_KEY", "ANTHROPIC_API_KEY"],
    "ports": [3000],
    "runtime_instances": [
      {
        "id": "agent-analyst",
        "runtime": "openclaw",
        "config_path": "/var/lib/spawnfile/instances/openclaw/agent-analyst/home/.openclaw/openclaw.json",
        "home_path": "/var/lib/spawnfile/instances/openclaw/agent-analyst/home",
        "model_auth_methods": {
          "anthropic": "claude-code"
        },
        "model_secrets_required": []
      }
    ]
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

Spawnfile-managed auth profile storage and `spawnfile run` orchestration are adjacent UX layers, not part of compile output itself, but the compile output does include the metadata needed for `run` to validate declared model auth and mount the right credential material.

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
# sync declared model auth and project secrets into a local profile
spawnfile auth sync fixtures/single-agent --profile dev --env-file ./.env

# compile and build the container
spawnfile build fixtures/single-agent --out ./bundle/single-agent --tag my-agent

# run with the local auth profile
spawnfile run fixtures/single-agent --out ./bundle/single-agent --tag my-agent --auth-profile dev
```

For teams:

```bash
spawnfile auth sync fixtures/multi-runtime-team --profile dev --env-file ./.env
spawnfile build fixtures/multi-runtime-team --out ./bundle/team --tag my-team
spawnfile run fixtures/multi-runtime-team --out ./bundle/team --tag my-team --auth-profile dev
```

Same flow regardless of project complexity. One compile, one build, one run.

`spawnfile compile` still emits a standard Docker build context, so manual `docker build` remains supported when developers want to inspect or tweak the emitted output before building the image.

The intended auth split is:

- `Spawnfile` declares model auth intent on each model target via `auth`, plus `endpoint` for `custom` and `local` backends
- `Spawnfile` declares runtime/project secret requirements through `secrets` and team `shared.secrets`
- `spawnfile auth sync` materializes matching local auth and declared secret values into a profile
- `spawnfile build` stays secrets-free
- `spawnfile run --auth-profile ...` injects only the auth material required by the declared methods and secrets
- `spawnfile run --env-file ...` MAY inject external env values directly for a single run without first storing them in an auth profile

For repository-level verification, an opt-in Docker auth E2E harness SHOULD exist outside the normal unit-test flow.
That harness SHOULD:

- build generated images from compiled output
- start containers with a local Spawnfile auth profile
- wait for host-reachable runtime readiness
- send real prompts through each supported runtime path
- fail unless the expected sentinel reply is observed

This harness is intentionally separate from `npm test` because it requires Docker, network access, and real credentials.
