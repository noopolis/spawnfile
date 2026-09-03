# Container Compilation v0.1

This document specifies how the Spawnfile compiler emits container artifacts alongside runtime-specific config and workspace files.

The goal is simple: `spawnfile compile` should produce output that can be built and run with `docker build` and `docker run`, giving developers and operators a way to verify that compiled output actually works against the real runtime. `STATUS.md` defines the read-only status layer over detached Docker deployments created from these artifacts.

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
    sourceWorkspacePathTemplate?: string;
    workspacePathTemplate: string;
  };
  globalNpmPackages?: string[];
  port?: number;
  portStride?: number;
  portEnv?: string;
  postRootfsCommands?: string[];
  standaloneBaseImage: string;
  startCommand: string[];
  staticEnv?: Record<string, string>;
  systemDeps: string[];
}

interface ContainerTarget {
  configEnvBindings?: Array<{
    envName: string;
    jsonPath: string;
  }>;
  id: string;
  files: EmittedFile[];
  envFiles?: Array<{
    envName: string;
    relativePath: string;
  }>;
  sourceIds?: string[];
}
```

The compiler uses this metadata to compose the Dockerfile and entrypoint. Adapters own their runtime's container story; the compiler just stitches them together.

`sourceWorkspacePathTemplate` is used by grouped runtimes where one process hosts several concrete source agents but each source still needs its own workspace directory. `sourceIds` records which compile nodes a grouped container target serves. Files emitted under the reserved `runtime/` target path are placed in the adapter's runtime install root; adapters may use this for generated harness apps that are installed alongside pinned runtime packages.

`postRootfsCommands` run in the generated Dockerfile after `container/rootfs/` has been copied into the image. They are only for adapter-owned install steps that truly depend on generated rootfs files. Runtime package installs SHOULD run before `container/rootfs/` is copied so Docker can reuse the expensive dependency layer when only agent prompts, docs, skills, or generated configs change.

### Pinned Versions

The runtime version used in the Dockerfile should match the pinned registry metadata from `runtimes.yaml`. This keeps the compiled container aligned with the runtime version the adapters were written against.

`spawnfile compile` itself should not require local runtime clones on the compiler machine. The compile step reads the registry metadata and adapter contracts; the Docker build step is responsible for fetching or installing the pinned runtime artifact.

The v0.1 reference implementation uses pinned compiled runtime artifacts:

- npm packages where the runtime publishes them
- release archives or bundles where the runtime ships them

Generated Dockerfiles must not clone runtime repositories or rebuild runtime sources during image build.

Runtimes MAY provide a reusable artifact image that already contains their pinned runtime package dependencies. Copyable artifact images are preferred for runtimes that may appear in mixed-runtime organizations, because generated Dockerfiles can compose them with `COPY --from` instead of requiring one base image for every runtime combination.

The Daimon, OpenClaw, and PicoClaw adapters use published runtime artifact images by default. Generated Dockerfiles copy each runtime from `/opt/spawnfile/runtime-installs/<runtime>` and skip runtime npm/archive installs during organization builds.

Current default images include a generic Daimon engine runtime selected by
immutable digest and capability receipt:

```text
noopolis/spawnfile-runtime-daimon@sha256:<pinned-digest>
noopolis/spawnfile-runtime-openclaw:2026.6.11
noopolis/spawnfile-runtime-picoclaw:0.3.1
```

Public Daimon hosts do not accept raw or tag-only image overrides. Standard
compiles always use the `runtimes.yaml` digest and receipt. Local development is
an explicit, fail-closed authority seam: `SPAWNFILE_DAIMON_LOCAL_RUNTIME_IDENTITY`
must name an absolute generated identity file containing the exact non-production
stamp, an explicitly selected `127.0.0.1:<port>/noopolis/spawnfile-runtime-daimon@sha256:<manifest>`, and
the embedded capability-receipt SHA-256. Missing receipts, other repositories,
mutable tags, extensible identity documents, and legacy raw override variables
are rejected. The ignored identity file never updates `runtimes.yaml` and the
organization build still only copies the prebuilt runtime artifact.

The local builder pins the official AGY Linux archive's manifest version, public
credential-free URL, and SHA-512 before extracting `antigravity`; it then verifies
the installed executable SHA-256. Its receipt also records those AGY fields and
the pinned Grok version, public URL, and SHA-256. Codex executable verification
remains mandatory. After building, the helper pushes only to the fixed loopback
development repository and records the returned OCI manifest digest. Until an
official AGY artifact exists for another architecture, this seam accepts only
`linux/amd64` and fails closed elsewhere.

The helper requires explicit `AGY_CLI_VERSION`, `AGY_CLI_URL`,
`AGY_CLI_SHA512`, and extracted `AGY_CLI_SHA256` pins. It preserves the Grok
artifact's `GROK_CLI_URL`/`GROK_CLI_SHA256` pin and additionally requires
`GROK_CLI_VERSION` for provenance. `CODEX_CLI_SHA256` remains required. All
artifact URLs must be credential-free HTTPS URLs without query or fragment.

OpenClaw and PicoClaw have equivalent overrides:

```bash
SPAWNFILE_OPENCLAW_RUNTIME_IMAGE=noopolis/spawnfile-runtime-openclaw:2026.6.11-local spawnfile up ./org --detach
SPAWNFILE_PICOCLAW_RUNTIME_IMAGE=noopolis/spawnfile-runtime-picoclaw:0.3.1-local spawnfile up ./org --detach
```

Declared `environment.packages` are installed into the generated image before runtime startup:

- `apt` packages are added to the Debian `apt-get install` layer; `version` is rendered as `name=version`.
- `npm` packages are installed globally with `npm install -g`; `version` is rendered as `name@version`.
- `pipx` packages are installed with `PIPX_HOME=/opt/pipx` and `PIPX_BIN_DIR=/usr/local/bin`; `version` is rendered as `name==version`.

Project-declared npm packages override runtime default global npm packages with the same package name, so a project can pin a runtime-adjacent CLI version intentionally.

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

- For `spawnfile build` / `spawnfile up` with `--context`, the compiler resolves the docker context architecture before staging Moltnet artifacts and selects `moltnet_linux_<architecture>.tar.gz` for that architecture. For manual compile without `--context`, you can force the target with `SPAWNFILE_MOLTNET_TARGET_ARCH=amd64|arm64` (or `x86_64`/`aarch64` aliases).
- By default, a Moltnet-bearing compile downloads the exact architecture asset
  named by `moltnet-releases.json`, applies a bounded response limit, and checks
  its SHA-256 digest before extraction. `SPAWNFILE_MOLTNET_RELEASE_DIR` is an
  explicit offline/development override containing
  `moltnet_linux_<arch>.tar.gz` plus `moltnet_release_stamp_<arch>.json`. The
  strict local-development stamp binds the asset digest and source digest and
  asserts the ordered `daimon-bridge`, `pi-bridge` capability set. It is usable
  only with `SPAWNFILE_ALLOW_LOCAL_E2E=1`; production compiles accept only the
  pinned public `pi-bridge` identity. Both paths verify the built archive rather
  than trusting a source declaration.
  the same checked-in authority; a self-authored matching stamp/tarball pair
  and every unpinned `latest` coordinate are rejected.
- `server.store.kind: sqlite` and `server.store.kind: json` create the configured or default store directory before server start.
- Durable `sqlite` and `json` stores emit `container.persistent_mounts[]` entries that `spawnfile run` and `spawnfile up` translate into Docker named volumes.
- `server.store.persistence.mode: ephemeral` skips persistent mount emission but still creates the in-container store directory before server start.
- `server.store.kind: postgres` injects `server.store.dsn_secret` into runtime config and skips local path creation.
- `server.store.kind: memory` creates no local persistence directory.

Secret materialization rules:

- `server.auth.tokens[].secret` is never written into source-controlled files.
- `server.auth.tokens[].secret` is written into private Moltnet config values at runtime start.
- `server.store.dsn_secret` is written as `storage.postgres.dsn` in managed server config.
- `server.pairings[].token_secret` is written as `pairings[].token` in managed server config. When a pairing uses the relay transport, `server.pairings[].relay.token_secret` is independently written as `pairings[].relay.token`.
- Generated open-mode token files for attach/self-claiming clients are runtime state files with private permissions (equivalent to `0600`), and token directories use private directory mode (equivalent to `0700`).
- Generated open-mode token directories are reported as persistent mounts so claimed agent identities survive container replacement.

---

## Detached Deployment Records

`spawnfile run --detach` and `spawnfile up --detach` write deployment records after a container starts successfully. Records live under the selected output directory:

```text
.spawn/deployments/default.json
.spawn/deployments/<name>.json
```

Deployment names are operator-local kebab-case slugs. They are not declared in Spawnfile source.

The Docker deployment record schema and behavior are defined in `STATUS.md`. Container compilation must provide the fields that records need:

- `compile_fingerprint`
- `output_directory`
- runtime instance ids and the compile node ids each instance serves
- image tag/id and container name/id after successful start
- Docker target information for context execution
- persistent mounts and published ports

A failed detached start MUST NOT write a record. Redeploying the same deployment name MUST replace the record atomically only after the new detached start succeeds.

`spawnfile dev up` writes the same record shape under `.spawn-dev/deployments/`
by default. `spawnfile dev apply --agent <id>` reads that record to find the
running Docker target and container, recompiles into `.spawn-dev` without
removing records, and mutates the running development container in place. The
v0.1 hot-apply path is `runtime: pi`-only: it copies the refreshed generated Pi app config, the
selected agent workspace, every matching Moltnet node config, and managed
Moltnet server configs into the container, then calls the generated Pi control
endpoint to load or reload that agent. New-agent Moltnet nodes are started as
that agent is applied. Existing agents and the container are not restarted.
Running managed Moltnet servers keep their current in-memory room membership
until the copied server config is reconciled by an operator-token `moltnet
apply` or a server restart.

`spawnfile dev activity` uses the same deployment record to read the generated
Pi app's bounded activity buffer from the running container. It is a runtime
diagnostic surface, not a Moltnet message reader.

### Docker Targets

Detached Docker execution may run against the default Docker context, an explicit `--context <name>`, or `DOCKER_HOST`. The deployment record must store the Docker target actually used:

```json
{ "kind": "context", "name": "vm1", "endpoint_fingerprint": "sha256:4be91d2b0d4f3a7c99e8123400aa55cc" }
{ "kind": "host", "value": "ssh://ops@my-vm" }
```

`endpoint_fingerprint` is a hash of the resolved Docker context endpoint. Status must re-resolve the context and report endpoint drift as an error instead of falling back to the local daemon.

### Docker Labels

Detached containers should receive non-secret status/deployment labels:

```text
com.spawnfile.version=0.1
com.spawnfile.project=<project-slug>
com.spawnfile.deployment=<deployment-name>
com.spawnfile.unit=<unit-id>
com.spawnfile.compile_fingerprint=<compile-fingerprint>
```

Labels are identifiers only. They must not include absolute paths, usernames, hostnames, auth profile names, env values, generated token values, or secrets.

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
    "persistent_mounts": [
      {
        "id": "moltnet-local_lab-store",
        "mount_path": "/var/lib/spawnfile/moltnet/networks/local_lab",
        "volume_name": "spawnfile-project-moltnet-local-lab-store-00000000",
        "reason": "managed Moltnet sqlite store for local_lab"
      }
    ],
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
    "ports": [
      {
        "id": "openclaw-gateway",
        "internal": 3000,
        "published": 3000
      }
    ],
    "moltnet": {
      "servers": [
        {
          "network_id": "local_lab",
          "mode": "managed",
          "auth_mode": "open",
          "rooms": ["research"],
          "listen_port": 8787,
          "published_port": 8787
        }
      ],
      "nodes": [
        {
          "network_id": "local_lab",
          "agent_ids": ["analyst"],
          "rooms": ["research"]
        }
      ]
    },
    "runtime_instances": [
      {
        "id": "agent-analyst",
        "node_ids": ["agent:analyst"],
        "runtime": "openclaw",
        "config_path": "/var/lib/spawnfile/instances/openclaw/agent-analyst/home/.openclaw/openclaw.json",
        "home_path": "/var/lib/spawnfile/instances/openclaw/agent-analyst/home",
        "workspace_path": "/var/lib/spawnfile/instances/openclaw/agent-analyst/home/.openclaw/workspace",
        "model_auth_methods": {
          "anthropic": "claude-code"
        },
        "model_secrets_required": []
      }
    ]
  }
}
```

The `moltnet` report data is sanitized. It records ids, modes, rooms, and ports only; it must not include operator tokens, agent tokens, pairing tokens, generated token file contents, or secret-bearing config patches.

---

## What This Does Not Cover

These are explicitly out of scope for v0.1 container compilation:

Image publishing and sourceless run are covered separately by `DISTRIBUTION.md`.

- Docker Compose generation for multi-container topologies
- Orchestration beyond the Docker detached record model (Kubernetes, ECS, Fly, etc.)
- Runtime-native auth bootstrap (onboarding flows stay manual)
- emitted Docker `HEALTHCHECK` instructions or richer readiness contracts beyond adapter-owned status probes
- General volume orchestration beyond compiler-reported persistent mounts
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
spawnfile auth sync test/fixtures/single-agent --profile dev --env-file ./.env

# compile and build the container
spawnfile build test/fixtures/single-agent --out ./bundle/single-agent --tag my-agent

# run with the local auth profile
spawnfile run test/fixtures/single-agent --out ./bundle/single-agent --tag my-agent --auth-profile dev
```

For teams:

```bash
spawnfile auth sync test/fixtures/multi-runtime-team --profile dev --env-file ./.env
spawnfile build test/fixtures/multi-runtime-team --out ./bundle/team --tag my-team
spawnfile run test/fixtures/multi-runtime-team --out ./bundle/team --tag my-team --auth-profile dev
```

Same flow regardless of project complexity. One compile, one build, one run.

For interactive Pi org development, use the dev loop:

```bash
spawnfile auth sync test/fixtures/e2e/daimon-org --profile dev --env-file ./.env
spawnfile dev up test/fixtures/e2e/daimon-org --auth-profile dev --deployment dev
spawnfile dev apply test/fixtures/e2e/daimon-org --agent new-agent --deployment dev
spawnfile dev activity test/fixtures/e2e/daimon-org --agent new-agent --deployment dev
```

Dev mode uses `.spawn-dev` by default and keeps the deployment record there.
`dev apply` is intentionally source-backed and `runtime: pi`-specific in v0.1. It does not
rebuild the image or restart the container; it updates one generated Pi agent in
the running container and starts that agent's Moltnet bridges only when the
agent is new.

`spawnfile compile` still emits a standard Docker build context, so manual `docker build` remains supported when developers want to inspect or tweak the emitted output before building the image.

The intended auth split is:

- `Spawnfile` declares model auth intent on each model target via `auth`, plus `endpoint` for `custom` and `local` backends
- `Spawnfile` declares runtime/project secret requirements through `environment.secrets` and team `shared.environment.secrets`
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
### Offline workspace bundles

`workspace.resources` may declare a read-only `bundle` with `source`, exact
`sha256`, and `mount`. Compilation accepts only a bounded safe tar, copies its
exact bytes into the Docker context, and binds its digest into the resource
identity and generated entrypoint. The image therefore starts offline and the
normal build-context digest covers every tracked or untracked byte present in
the archive. Dependency artifacts needed at runtime belong inside that archive.

Local production-candidate Daimon builds retain the clean-Git provenance mode
by default. A reviewed dirty integration tree instead uses two deterministic,
checksum-bound `spawnfile.source-input-manifest.v1` archives: one for source
(including intended untracked inputs) and one rooted at the exact installed
dependency tree. Creation excludes VCS metadata, secrets, generated output,
and caches, rejects escaping links, and rechecks the whole manifest after
reading. The amd64 Docker builder validates both archives and builds the npm
package from only those bytes; it neither copies Git metadata nor resolves
package dependencies from the network. The dependency archive is rooted at a
prepared package/lock/npm-cache closure with no installed `node_modules`; its manifest binds the
lock digest, required compiler/runtime packages, and exact `linux/amd64`
target. An arm64 host may drive this amd64 builder, but archive mode does not
produce an arm64 runtime image. Known credential files/directories are omitted
and credential-shaped file content fails creation before archive publication.

Blue/green runs use distinct run-scoped volumes EXCEPT `exclusive-reattach`
mounts. Durable memory stores, durable managed Moltnet `sqlite`/`json` stores,
generated open-mode agent token directories, workspace `kind: volume`
resources, and the Daimon per-turn usage ledger are all `exclusive-reattach`:
their volumes are named from the project root and deployment lineage, never
the run id, and an author-declared name (`persistence.name`, a resource
`name`) is used verbatim. They survive a redeploy. A report carrying one
cannot use the concurrent canary workflow below.

A derived `exclusive-reattach` name depends on the deployment lineage, and each
entrypoint supplies a different default lineage (`spawnfile run`: `ephemeral`;
`spawnfile up`: `default`; bare `spawnfile compile`: `compile`). Changing
launcher or `--deployment` name therefore selects a different volume.

`spawnfile dev up` additionally namespaces its lineage, so a dev deployment can
never resolve to the derived volumes of a production `spawnfile up` of the same
project under ANY `--deployment` name. The namespace applies to the lineage
only, never to the deployment name, so dev deployment records and labels are
unchanged.

An author-declared name carries no lineage and is the same volume under every
launcher and in a sourceless image deployment. The dev namespace therefore
cannot protect it, so `spawnfile dev up` REFUSES to start when any durable
mount carries a declared name, listing them; `--allow-declared-volumes` is the
explicit override for an operator who means to attach that live state.

Compiler-owned persistent mounts are attached WITHOUT `volume-nocopy`. The
image is the authority for the bootstrap preimage at those paths, and Docker
copies image content up only into an empty volume, so an already-populated
volume that is reattached is never overwritten. Product-state transfer is a separate explicit operation over a strict
`spawnfile.product-state-quiescence.v1` proof. Only listed regular files whose
checksums remain stable before and after copying are cloned. Auth, credential,
token, secret, session, wake, and SQLite paths are rejected; live volumes are
never mounted into the candidate.

The mechanically executable workflow is `spawnfile product-state clone
request.json`. Its strict `spawnfile.product-state-clone-request.v1` names the
authority receipt, candidate-volume mountpoint, proof file, no-replace receipt
file, and candidate run id. `spawnfile product-state authority` first binds the
actual managed source container id, image, run label, start identity, exact
writable named-volume root, and candidate volume. It preserves an already
paused container; otherwise it pauses the whole container cgroup, proves the
pause, generates the complete source-tree proof, and restores the prior state.
Clone re-inspects every identity, pauses that same cgroup again, holds an
exclusive source fence, verifies before/copy/after checksums and the complete
manifest again,
atomically activates the candidate, and publishes a
`spawnfile.product-state-clone-receipt.v1`. Any copy or receipt failure removes
candidate output. Only a cgroup paused by Spawnfile is unpaused in `finally`;
an unrelated/restarted/reused container or rebound volume fails closed.

### Generic canary, cutover, and rollback runbook

The following is the complete operator workflow. The source proof MUST cover
the whole product-state tree, and `product-check` MUST be a project-owned,
read-only checker that emits `spawnfile.product-check-receipt.v1` with
`state:"passed"` and the candidate run id. No cutover command is run before
all three immutable receipts pass.

The ingress adapter MUST atomically switch its provider and write the requested
strict `spawnfile.ingress-cutover-receipt.v1`: `state:"switched"`, exact from/to
deployment and target run id, a fresh 128-bit transaction `nonce`, plus `readiness_sha256` over the byte-exact up
receipt. Spawnfile validates it, tears the former deployment down, and only then
publishes the decision receipt. A durable transaction reservation makes retries
reconcile an already-switched ingress and idempotent teardown without switching
again. Candidate ports are read from both compiled
reports and must be unique and disjoint.

A report containing a shared `exclusive-reattach` mount cannot use this
concurrent canary workflow. The rotating provider authority has one live
writer: replace under the same deployment identity, or stop the live
deployment while retaining volumes and then start the candidate so it
reattaches the same host-stable realm.

```bash
set -euo pipefail
export PROJECT_PATH=/absolute/project
export CANDIDATE_PROJECT_PATH=/absolute/candidate-project-with-isolated-published-ports
export AUTH_PROFILE=production
export LIVE_DEPLOYMENT=live
export LIVE_RUN_ID=live-original-run-id
export LIVE_OUT=/absolute/live/build
export LIVE_TAG=local/live:attested
export LIVE_UP_RECEIPT=/absolute/live/up-receipt.json
export LIVE_IDENTITY=/absolute/live/deployment-identity.json
export CANDIDATE_DEPLOYMENT=candidate
export CANDIDATE_RUN_ID=candidate-20260825
export CANDIDATE_OUT=/absolute/state/candidate-20260825/build
export CANDIDATE_TAG=local/candidate:candidate-20260825
export CLONE_REQUEST=/absolute/state/candidate-20260825/clone-request.json
export AUTHORITY_REQUEST=/absolute/state/candidate-20260825/authority-request.json
export AUTHORITY_RECEIPT=/absolute/state/candidate-20260825/authority-receipt.json
export PROOF_PATH=/absolute/state/candidate-20260825/product-state-proof.json
export CLONE_RECEIPT=/absolute/state/candidate-20260825/clone-receipt.json
export UP_RECEIPT=/absolute/state/candidate-20260825/up-receipt.json
export PRODUCT_RECEIPT=/absolute/state/candidate-20260825/product-receipt.json
export DECISION_RECEIPT=/absolute/state/candidate-20260825/decision-receipt.json
export CUTOVER_REQUEST=/absolute/state/candidate-20260825/cutover-request.json
export INGRESS_RECEIPT=/absolute/state/candidate-20260825/ingress-receipt.json
export CANDIDATE_IDENTITY=/absolute/state/candidate-20260825/deployment-identity.json
export CUTOVER_TRANSACTION=/absolute/state/candidate-20260825/cutover-transaction.json
export LIVE_REPORT=/absolute/live/build/spawnfile-report.json
export LIVE_CONTAINER=live-container
export PRODUCT_MOUNT=/var/lib/product/state
export INGRESS_CUTOVER_EXECUTABLE=/absolute/operator/ingress-cutover
export CUTOVER_NONCE="$(openssl rand -hex 16)"
export LIVE_EXPORT=/absolute/state/candidate-20260825/exported-live
export CANDIDATE_EXPORT=/absolute/state/candidate-20260825/exported-candidate

node -e 'const fs=require("fs"),e=process.env,p=e.LIVE_IDENTITY+".request";fs.writeFileSync(p,JSON.stringify({version:"spawnfile.deployment-identity-request.v1",readiness_path:e.LIVE_UP_RECEIPT,deployment_mode:"project",docker_command:"docker",receipt_path:e.LIVE_IDENTITY})+"\n",{flag:"wx",mode:0o600})'
spawnfile canary identity "$LIVE_IDENTITY.request"

NOOPOLIS_RUN_ID="$CANDIDATE_RUN_ID" spawnfile build "$CANDIDATE_PROJECT_PATH" --out "$CANDIDATE_OUT" --tag "$CANDIDATE_TAG"
node -e 'const [l,c]=process.argv.slice(1).map(require),a=new Set(l.published_ports||[]),b=c.published_ports||[];if(new Set(b).size!==b.length||b.some(p=>a.has(p)))process.exit(1)' "$LIVE_REPORT" "$CANDIDATE_OUT/spawnfile-report.json"
BUILD_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$CANDIDATE_TAG")"
export CANDIDATE_VOLUME_NAME="$(node -e 'const r=require(process.argv[1]),m=(r.persistent_mounts||[]).filter(x=>x.mount_path===process.argv[2]);if(m.length!==1||!m[0].volume_name)process.exit(1);process.stdout.write(m[0].volume_name)' "$CANDIDATE_OUT/spawnfile-report.json" "$PRODUCT_MOUNT")"
export CANDIDATE_RESOURCE_IDENTITY="$(node -e 'const r=require(process.argv[1]),m=(r.workspace_resources||[]).filter(x=>x.backing_path===process.argv[2]);if(m.length!==1||!m[0].resolved_identity)process.exit(1);process.stdout.write(m[0].resolved_identity)' "$CANDIDATE_OUT/spawnfile-report.json" "$PRODUCT_MOUNT")"
docker volume create "$CANDIDATE_VOLUME_NAME" >/dev/null
export CANDIDATE_VOLUME_PATH="$(docker volume inspect --format '{{.Mountpoint}}' "$CANDIDATE_VOLUME_NAME")"
node -e 'const fs=require("fs"),e=process.env;fs.writeFileSync(e.AUTHORITY_REQUEST,JSON.stringify({version:"spawnfile.product-state-source-authority-request.v1",docker_command:"docker",container:e.LIVE_CONTAINER,source_run_id:e.LIVE_RUN_ID,mount_path:e.PRODUCT_MOUNT,candidate_volume_name:e.CANDIDATE_VOLUME_NAME,candidate_resource_identity:e.CANDIDATE_RESOURCE_IDENTITY,receipt_path:e.AUTHORITY_RECEIPT,proof_path:e.PROOF_PATH})+"\n",{flag:"wx",mode:0o600})'
spawnfile product-state authority "$AUTHORITY_REQUEST" >/dev/null
node -e 'const fs=require("fs"),e=process.env;fs.writeFileSync(e.CLONE_REQUEST,JSON.stringify({version:"spawnfile.product-state-clone-request.v1",authority_receipt_path:e.AUTHORITY_RECEIPT,docker_command:"docker",destination:e.CANDIDATE_VOLUME_PATH,proof_path:e.PROOF_PATH,receipt_path:e.CLONE_RECEIPT,candidate_run_id:e.CANDIDATE_RUN_ID})+"\n",{flag:"wx",mode:0o600})'
spawnfile product-state clone "$CLONE_REQUEST" > /dev/null
NOOPOLIS_RUN_ID="$CANDIDATE_RUN_ID" spawnfile up "$CANDIDATE_PROJECT_PATH" --out "$CANDIDATE_OUT" --tag "$CANDIDATE_TAG" --deployment "$CANDIDATE_DEPLOYMENT" --auth-profile "$AUTH_PROFILE" --detach --json > "$UP_RECEIPT"
product-check --run-id "$CANDIDATE_RUN_ID" --deployment "$CANDIDATE_DEPLOYMENT" > "$PRODUCT_RECEIPT"
node -e 'const fs=require("fs"),cp=require("child_process");const [c,u,p,r,image]=process.argv.slice(1),C=JSON.parse(fs.readFileSync(c)),U=JSON.parse(fs.readFileSync(u)),P=JSON.parse(fs.readFileSync(p)),ids=U.deployment?.container_ids;if(C.version!=="spawnfile.product-state-clone-receipt.v1"||C.candidate_run_id!==r||U.version!=="spawnfile.up-receipt.v1"||U.organization_ready?.state!=="ready"||U.organization_ready?.run_id!==r||!Array.isArray(ids)||ids.length!==1||cp.execFileSync("docker",["inspect","--format","{{.Image}}",ids[0]],{encoding:"utf8"}).trim()!==image||P.version!=="spawnfile.product-check-receipt.v1"||P.state!=="passed"||P.run_id!==r)process.exit(1)' "$CLONE_RECEIPT" "$UP_RECEIPT" "$PRODUCT_RECEIPT" "$CANDIDATE_RUN_ID" "$BUILD_IMAGE_ID"
node -e 'const fs=require("fs"),e=process.env,p=e.CANDIDATE_IDENTITY+".request";fs.writeFileSync(p,JSON.stringify({version:"spawnfile.deployment-identity-request.v1",readiness_path:e.UP_RECEIPT,deployment_mode:"project",docker_command:"docker",receipt_path:e.CANDIDATE_IDENTITY})+"\n",{flag:"wx",mode:0o600})'
spawnfile canary identity "$CANDIDATE_IDENTITY.request"
node -e 'const fs=require("fs"),e=process.env;fs.writeFileSync(e.CUTOVER_REQUEST,JSON.stringify({version:"spawnfile.canary-cutover-request.v1",live_report_path:e.LIVE_REPORT,candidate_report_path:e.CANDIDATE_OUT+"/spawnfile-report.json",readiness_path:e.UP_RECEIPT,expected_identity:JSON.parse(fs.readFileSync(e.CANDIDATE_IDENTITY)),docker_command:"docker",nonce:e.CUTOVER_NONCE,transaction_path:e.CUTOVER_TRANSACTION,ingress_command:e.INGRESS_CUTOVER_EXECUTABLE,ingress_args:["--from",e.LIVE_DEPLOYMENT,"--to",e.CANDIDATE_DEPLOYMENT,"--nonce",e.CUTOVER_NONCE,"--require-up-receipt",e.UP_RECEIPT,"--receipt",e.INGRESS_RECEIPT],ingress_receipt_path:e.INGRESS_RECEIPT,teardown_command:"spawnfile",teardown_args:["down",e.PROJECT_PATH,"--compiled",e.LIVE_OUT,"--deployment",e.LIVE_DEPLOYMENT,"--export-to",e.LIVE_EXPORT,"--json","--lifecycle-invocation","lci_canary_"+e.CUTOVER_NONCE],teardown_policy:"export",teardown_project_path:e.PROJECT_PATH,teardown_compiled_path:e.LIVE_OUT,decision_receipt_path:e.DECISION_RECEIPT,from_deployment:e.LIVE_DEPLOYMENT,to_deployment:e.CANDIDATE_DEPLOYMENT})+"\n",{flag:"wx",mode:0o600})'
spawnfile canary cutover "$CUTOVER_REQUEST"
```

Pre-cutover rollback re-attests/rebinds ingress to the already-live deployment
and tears down only the fresh candidate through the same receipt-gated transaction:

```bash
set -euo pipefail
export ABORT_NONCE="$(openssl rand -hex 16)"
export ABORT_INGRESS_RECEIPT="$DECISION_RECEIPT.abort-ingress"
export ABORT_TRANSACTION="$DECISION_RECEIPT.abort-transaction"
export ABORT_DECISION="$DECISION_RECEIPT.abort-decision"
node -e 'const fs=require("fs"),e=process.env,p=e.ABORT_DECISION+".request";fs.writeFileSync(p,JSON.stringify({version:"spawnfile.canary-cutover-request.v1",live_report_path:e.CANDIDATE_OUT+"/spawnfile-report.json",candidate_report_path:e.LIVE_REPORT,readiness_path:e.LIVE_UP_RECEIPT,expected_identity:JSON.parse(fs.readFileSync(e.LIVE_IDENTITY)),docker_command:"docker",nonce:e.ABORT_NONCE,transaction_path:e.ABORT_TRANSACTION,ingress_command:e.INGRESS_CUTOVER_EXECUTABLE,ingress_args:["--from",e.CANDIDATE_DEPLOYMENT,"--to",e.LIVE_DEPLOYMENT,"--nonce",e.ABORT_NONCE,"--require-up-receipt",e.LIVE_UP_RECEIPT,"--receipt",e.ABORT_INGRESS_RECEIPT],ingress_receipt_path:e.ABORT_INGRESS_RECEIPT,teardown_command:"spawnfile",teardown_args:["down",e.CANDIDATE_PROJECT_PATH,"--compiled",e.CANDIDATE_OUT,"--deployment",e.CANDIDATE_DEPLOYMENT,"--export-to",e.CANDIDATE_EXPORT,"--json","--lifecycle-invocation","lci_canary_"+e.ABORT_NONCE],teardown_policy:"export",teardown_project_path:e.CANDIDATE_PROJECT_PATH,teardown_compiled_path:e.CANDIDATE_OUT,decision_receipt_path:e.ABORT_DECISION,from_deployment:e.CANDIDATE_DEPLOYMENT,to_deployment:e.LIVE_DEPLOYMENT})+"\n",{flag:"wx",mode:0o600})'
spawnfile canary cutover "$ABORT_DECISION.request"
```

Post-cutover rollback removes only the candidate and restarts the exact
attested prior image with its original run identity; retained prior volumes
remain isolated and are never mounted by the candidate:

```bash
set -euo pipefail
export ROLLBACK_UP_RECEIPT="$DECISION_RECEIPT.rollback-readiness"
export ROLLBACK_NONCE="$(openssl rand -hex 16)"
export ROLLBACK_INGRESS_RECEIPT="$DECISION_RECEIPT.rollback-ingress"
export ROLLBACK_TRANSACTION="$DECISION_RECEIPT.rollback-transaction"
export ROLLBACK_DECISION="$DECISION_RECEIPT.rollback-decision"
NOOPOLIS_RUN_ID="$LIVE_RUN_ID" spawnfile up "$PROJECT_PATH" --out "$LIVE_OUT" --tag "$LIVE_TAG" --deployment "$LIVE_DEPLOYMENT" --auth-profile "$AUTH_PROFILE" --detach --json > "$ROLLBACK_UP_RECEIPT"
node -e 'const fs=require("fs"),e=process.env,p=e.ROLLBACK_DECISION+".request";fs.writeFileSync(p,JSON.stringify({version:"spawnfile.canary-cutover-request.v1",live_report_path:e.CANDIDATE_OUT+"/spawnfile-report.json",candidate_report_path:e.LIVE_REPORT,readiness_path:e.ROLLBACK_UP_RECEIPT,expected_identity:JSON.parse(fs.readFileSync(e.LIVE_IDENTITY)),docker_command:"docker",nonce:e.ROLLBACK_NONCE,transaction_path:e.ROLLBACK_TRANSACTION,ingress_command:e.INGRESS_CUTOVER_EXECUTABLE,ingress_args:["--from",e.CANDIDATE_DEPLOYMENT,"--to",e.LIVE_DEPLOYMENT,"--nonce",e.ROLLBACK_NONCE,"--require-up-receipt",e.ROLLBACK_UP_RECEIPT,"--receipt",e.ROLLBACK_INGRESS_RECEIPT],ingress_receipt_path:e.ROLLBACK_INGRESS_RECEIPT,teardown_command:"spawnfile",teardown_args:["down",e.CANDIDATE_PROJECT_PATH,"--compiled",e.CANDIDATE_OUT,"--deployment",e.CANDIDATE_DEPLOYMENT,"--export-to",e.CANDIDATE_EXPORT,"--json","--lifecycle-invocation","lci_canary_"+e.ROLLBACK_NONCE],teardown_policy:"export",teardown_project_path:e.CANDIDATE_PROJECT_PATH,teardown_compiled_path:e.CANDIDATE_OUT,decision_receipt_path:e.ROLLBACK_DECISION,from_deployment:e.CANDIDATE_DEPLOYMENT,to_deployment:e.LIVE_DEPLOYMENT})+"\n",{flag:"wx",mode:0o600})'
spawnfile canary cutover "$ROLLBACK_DECISION.request"
```
