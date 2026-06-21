# Spawnfile Image Distribution Design

## Goal

A creator compiles an agentic organization once and publishes it as a standard OCI image. A consumer runs that organization with Docker, an image reference, and their own secrets. No Spawnfile source checkout, no consumer-side compile step, no creator-operated infrastructure.

```bash
# creator
spawnfile build --tag you/research-cell:1.0.0
docker push you/research-cell:1.0.0

# consumer
spawnfile up you/research-cell:1.0.0 --deployment research-cell --detach --auth-profile me
spawnfile status --deployment research-cell --live
```

This works because the default compile target produces one container (`specs/CONTAINERS.md`): the image already is the complete deployable organization. Distribution is therefore a registry problem, and registries are a solved problem. Later sections extend the same model to multi-image packaging, non-Docker substrates, and mixed placements without changing the sharing unit: one ref names the organization.

## Why OCI Registries, Not a Spawnfile Registry

Do not reinvent well-understood workflows. Helm abandoned its own chart registry for OCI registries. Devcontainer features ship as OCI artifacts. Compose images are just images.

- Docker Hub is the first target, but nothing here is Hub-specific: GHCR, ECR, and any OCI registry work identically.
- Registry auth is delegated entirely to `docker login`. Spawnfile never stores or proxies registry credentials.
- A future Spawnfile registry is a discovery index over images stored in ordinary registries, not new artifact storage. Nothing in this design needs to change to add it later.

## Non-Goals

- Not DRM. The image contains identity docs, skills, generated configs, and runtime entrypoints; anyone who can pull it can extract them. Publishing hides the original Spawnfile source checkout and local build layout, not the generated runtime material. Access control is the registry's private-repository mechanism; spawnfile adds nothing on top.
- No source distribution or remixing. Consumers run organizations; they do not edit them. Source sharing stays git's job.
- No spawnfile registry service in this design.
- No multi-arch builds yet. Deferred, see below.
- No image signing/provenance yet. Deferred, see below.

## Image Contract

A published spawnfile image is a normal runnable image plus three additions emitted by the compiler-generated container artifacts. This must live in the generated Dockerfile/rootfs, not only in `spawnfile build`, so a manual `docker build` from the generated output root produces the same self-describing image.

### 1. Embedded Distribution Report

The image contains a distribution-safe report at:

```text
/spawnfile/spawnfile-report.json
```

This is not the raw status compile report. Status sanitization is secret-free, but today it can still contain creator host paths such as project roots, output directories, and node source paths. Public image distribution needs a stricter transform.

The distribution report must be:

- secret-free: secret names only, never values;
- host-path-free: no absolute creator paths, no local checkout roots, no `.spawn` output directories;
- sourceless-runnable: contains enough data for consumer-side `up` and `status` without reading project files;
- renderer-compatible: contains enough data to build a status `OrganizationView` projection without inventing a separate image-only status format.

Minimum report shape:

```json
{
  "version": "spawnfile.distribution-report.v1",
  "compile_fingerprint": "sf1:...",
  "generated_at": "2026-06-12T00:00:00.000Z",
  "organization": {
    "project": "research-cell",
    "agents": [
      {
        "id": "analyst",
        "name": "Analyst",
        "runtime": "picoclaw",
        "teams": ["research-cell"]
      }
    ],
    "teams": [
      {
        "id": "research-cell",
        "agents": ["analyst"]
      }
    ]
  },
  "model_auth_methods": {
    "openai": "api_key"
  },
  "secrets": {
    "model": [
      {
        "name": "OPENAI_API_KEY",
        "required": true,
        "generated": false
      }
    ],
    "project": [
      {
        "name": "SEARCH_API_KEY",
        "required": false,
        "generated": false
      }
    ],
    "runtime": [
      {
        "name": "OPENCLAW_GATEWAY_TOKEN",
        "required": true,
        "generated": true
      }
    ],
    "surface": [
      {
        "name": "SLACK_BOT_TOKEN",
        "required": true,
        "generated": false
      }
    ]
  },
  "ports": [],
  "resources": [],
  "persistent_mounts": [
    {
      "id": "moltnet-state",
      "kind": "volume",
      "target": "/var/lib/spawnfile/moltnet",
      "durability": "persistent"
    }
  ],
  "runtime_instances": [
    {
      "id": "picoclaw-analyst",
      "runtime": "picoclaw",
      "node_ids": ["analyst"],
      "model_auth_methods": {
        "openai": "api_key"
      }
    }
  ],
  "moltnet": {
    "networks": []
  }
}
```

The exact fields can reuse existing report structures where they are already safe, but the distribution report has its own schema and tests. A path-free test must assert that no serialized string contains the creator project root, output directory, or an absolute node source path. The existing secret-free tests still apply.

`organization.project` comes from the root manifest's `name`, not the creator checkout directory basename and not the image repository/tag. It must be an author-chosen source value so the distribution report stays host-independent and stable across registries. Image and container labels use a normalized slug of that manifest name, using the existing label validator's identifier charset. Phase 1 should switch managed container labels to the same source so image and container `com.spawnfile.project` values agree.

Keep secret categories aligned with the compiler's actual container secret plan: `model`, `project`, `runtime`, and `surface`. `model` covers model provider credentials. `project` covers user-declared Spawnfile secrets. `runtime` covers runtime-local credentials such as gateway tokens. `surface` covers connector/bot tokens such as Slack or Telegram credentials. Do not invent `resources` or `moltnet` categories in v1 unless the compiler emits those categories at the same time.

Every secret entry carries `required: boolean` and `generated: boolean`. Consumer preflight demands only entries where `required: true` and `generated: false`. Optional secrets remain visible so consumers can discover optional integrations without being blocked. Generated runtime secrets may be created by Spawnfile during deployment and must not be required from the user. This marker belongs in the report, not in a hardcoded CLI name list, because published images and CLIs can be version-skewed.

`generated` requires an adapter contract addition in Phase 1: runtime/container artifact planners must mark generated env declarations explicitly instead of relying on CLI-side name lists. Without that flag, distribution cannot safely decide which runtime secrets to demand from consumers.

`model_auth_methods` is a provider-keyed record (`Record<provider, method>`), both at report level and per runtime instance. Do not serialize it as an array; auth validation needs to know which provider each method belongs to.

Moltnet bearer client tokens are not currently represented in the compiler's secret categories or `secrets_required` output. Until that gap is closed, the distribution report can only claim full coverage for model/project/runtime/surface secrets and must not imply Moltnet token preflight is solved.

`persistent_mounts` is required in v1. If a generated image needs named volumes or host-independent stores, the consumer-side `up` path must know that before the image starts. Omitting these fields in Phase 1 would strand every immutable image built before Phase 2. The report does not carry creator volume names. Consumer deployments derive volume names from the deployment name plus mount id, e.g. `spawnfile_<deployment>_<mount-id>`, so two deployments of the same image do not accidentally share a Moltnet store.

### 2. Image Labels

```text
com.spawnfile.image_contract=spawnfile.image.v1
com.spawnfile.project=research-cell
com.spawnfile.compile_fingerprint=sf1:9c4e2b...
com.spawnfile.report=/spawnfile/spawnfile-report.json
```

Labels follow the same identifier-only rule as container labels from `specs/STATUS.md`: no host paths, no secrets. `com.spawnfile.report` is an in-image path, not a host path, and exists so the report location is advertised rather than frozen forever. These labels intentionally overlap with managed container labels where the concepts match, so context label recovery must still match on deployment/unit labels when looking for running containers; image labels alone are not enough to identify a managed deployment.

For now, `com.spawnfile.image_contract` is exact-match only. If the local CLI does not support the literal contract value, it fails before container start with exit 2. Major/minor compatibility can be designed later.

The `com.spawnfile.compile_fingerprint` label and embedded report both require an emission-order change: compute the fingerprint from the path-free distribution report, then render the final Dockerfile and report with that fingerprint inserted. This is intentionally a v1 fingerprint discontinuity: existing deployments may report one drift warning after the upgrade until redeployed, because older fingerprints included creator-path-bearing inputs.

### 3. Network Binding Contract

Declared networks are optional, so this addition applies only to images whose organizations declare them. When present, bridges and clients resolve their network endpoint and credential from the environment at start:

```text
SPAWNFILE_NETWORK_<id>_URL=<reachable Moltnet endpoint>
SPAWNFILE_NETWORK_<id>_TOKEN=<admission credential>
```

Rules:

- When the env vars are absent, the entrypoint falls back to the compiled-in defaults. Single-container deployments keep working unchanged with the in-image server.
- When the env vars are present, they override the compiled-in endpoint. This is what lets the same immutable image join a multi-container deployment, a compose fleet, a cluster, or another organization's network.
- The distribution report declares which networks are env-rebindable (`moltnet.networks[].binding: "env"`), so consumers and importing compilers can tell rebindable images from pre-contract images.
- Reachability is connectivity, not membership. Tokens are minted for declared members and admission is governed by Moltnet auth policy. Attaching a container to a network substrate never adds an agent to a room by itself.

Mechanics that are frozen into every published entrypoint, decided now:

- Env name normalization: ids are uppercased and every character outside `[A-Z0-9]` becomes `_`. `research-cell` yields `SPAWNFILE_NETWORK_RESEARCH_CELL_URL`. The uniqueness rule is global, not per id kind: every generated binding env name (URL and token vars, across all networks and members) must be unique after normalization, or compile fails. This covers network-id collisions, member-id collisions within a network, and cross-kind collisions such as a member named `url` colliding with another network's URL var.
- Tokens are per member, not per network, because one container can host several members of one network: `SPAWNFILE_NETWORK_<ID>_TOKEN_<MEMBER_ID>`, same normalization. When a container hosts exactly one member of a network, the unsuffixed `SPAWNFILE_NETWORK_<ID>_TOKEN` is accepted as a fallback.
- The entrypoint applies these overrides to every generated config that embeds a network endpoint or token reference (Moltnet node config `base_url` values, attachment runtime client configs), reusing the existing entrypoint JSON-patching mechanism. The implementation enumerates the exact files; the contract is that no generated config may embed an endpoint the env cannot override.
- In-image server suppression: when `SPAWNFILE_NETWORK_<ID>_URL` is set for a network whose managed server is compiled into the image, the entrypoint does not start that in-image server and does not block on its health. Absent the var, the image behaves exactly as today.

The report's `moltnet.networks[]` entries are part of the Phase 1 v1 schema, so adding the binding behavior later never causes a second schema or fingerprint discontinuity:

```json
"moltnet": {
  "networks": [
    { "id": "research_floor", "server_mode": "managed", "binding": "env" }
  ]
}
```

`binding: "env"` means the image honors this contract for that network. Reports without a `binding` value mark pre-contract images that can never be rebound.

The contract is deliberately substrate-free: plain env configuration, satisfiable by docker, compose, Kubernetes, ECS, or anything else. How the endpoint becomes reachable is a deployment manager concern (see The Two Planes).

Sequencing matters here more than anywhere else in this design: images published without this contract can never be rebound, split, or composed. The report schema entries ship in Phase 1; the entrypoint behavior should land as close to Phase 1 as possible.

## Image References in the CLI

`up` and `status` accept an image reference where they accept a project path today. Detection is deterministic:

1. If the argument resolves to an existing directory or file, it is a project path. This preserves documented inputs such as `spawnfile up ./fixtures/single-agent/Spawnfile`.
2. Otherwise, implicit image mode accepts only refs with a tag, digest, or registry component: `name:tag`, `registry/name:tag`, `registry/name@sha256:...`, `localhost:5000/name:tag`.
3. `--image` forces image-reference interpretation; useful when a local directory shadows a ref or when the user intentionally wants Docker's bare-name behavior.
4. Anything else is a usage error (exit 2).

A directory always wins over a ref of the same spelling unless `--image` is present. Bare words such as `research-cell` are valid Docker references, but Spawnfile must not silently treat them as images in implicit mode because they collide too easily with local project names. Public examples should use explicit tags or digests.

Image-mode `run` is explicitly deferred. `run <image-ref>` needs foreground/no-record semantics that are not required for distribution. Phase 2 implements image-mode `up` and `status` only; `run <image-ref>` exits 2 with a message pointing to `spawnfile up <image-ref> --detach`.

## Consumer Flow

`spawnfile up <image-ref> --detach` is a separate path from project `up`: it never compiles and never builds. It does, in order:

1. Resolve the Docker target using the same target rules as project run/up: explicit `--context`, else `DOCKER_HOST`, else the configured default Docker context. The current implementation names the literal `default` context rather than discovering Docker's active context; that pre-existing target-resolution quirk should be fixed separately before claiming active-context semantics.
2. Pull the image if not present. `--pull` forces a refresh.
3. Inspect image labels and verify `com.spawnfile.image_contract`.
4. Extract the distribution report without starting the real entrypoint. The first implementation should use `docker create --name spawnfile-inspect-<id> <image>`, `docker cp <container>:<report-path> -`, then `docker rm`, all against the resolved Docker target. Cleanup must run in a `finally` path.
5. Validate the distribution report schema, secret coverage by category, generated-secret markers, and per-instance model auth methods.
6. Start the real organization container with the standard entrypoint env wiring and standard container labels.
7. Write a deployment record and cache the extracted distribution report atomically beside it.

"Before any container exists" is not the right guarantee because metadata extraction may create a stopped helper container. The real guarantee is: missing secrets, unsupported auth methods, invalid labels, and invalid reports fail before the organization container starts.

Metadata extraction is a read of a public artifact, not an operator-plane action on a deployment. It always uses the local Docker daemon via the helper-container flow, regardless of which deployment manager the deployment will use. Consequence: consuming images requires a local Docker daemon even when deploying to Kubernetes or ECS. A registry-API read path that needs no local daemon is the deferred upgrade. Implementation note: `docker cp <container>:<path> -` emits a tar stream; the extractor untars it.

## Auth Scope for Sourceless Images

Phase 2 supports only model auth methods that can be injected from consumer-provided env/secrets without patching compiled files outside the image. In practice, that means `api_key` auth first.

Import-based runtime auth, such as Codex or Claude Code profile imports, is not mechanically available sourceless today. Current project `up` reads compiled runtime config from `.spawn/container/rootfs/`, writes patched copies to generated support files, and bind-mounts those patched files over the image copies. A consumer image deployment has no `.spawn/container/rootfs/`.

Phase 2 behavior:

- if every runtime uses supported env/secret-based auth, continue;
- if any runtime requires import-based auth, fail before metadata helper cleanup/start with a clear message naming the runtime, agent, and unsupported auth method;
- preflight validates per-instance `model_auth_methods`, the full `secrets` category map, and `generated` markers, not only consumer model credentials.

Long-term fix: move runtime auth patching into the generated entrypoint so the image can patch its own runtime config from mounted consumer secrets at start. That is intentionally outside Phase 2.

## Deployment Records

Image deployments require deployment record v2:

```json
{
  "version": "spawnfile.deployment.v2",
  "name": "research-cell",
  "created_at": "2026-06-12T00:00:00.000Z",
  "auth_profile": "me",
  "env_file": ".env",
  "target": {
    "kind": "context",
    "name": "default",
    "endpoint_fingerprint": "sha256:..."
  },
  "source": {
    "kind": "image",
    "ref": "you/research-cell:1.0.0",
    "digest": "sha256:..."
  },
  "compile_fingerprint": "sf1:...",
  "manager": "docker",
  "output_directory": null,
  "units": [
    {
      "id": "organization",
      "kind": "container",
      "container_name": "spawnfile-research-cell-organization",
      "container_id": "...",
      "image_tag": "you/research-cell:1.0.0",
      "image_id": "sha256:...",
      "contains": [
        { "kind": "agent", "id": "agent:analyst" },
        { "kind": "network", "id": "research-cell" }
      ],
      "runtime_instances": ["picoclaw-analyst"]
    }
  ]
}
```

Project deployments use the same source union:

```json
{
  "version": "spawnfile.deployment.v2",
  "name": "research-cell",
  "created_at": "2026-06-12T00:00:00.000Z",
  "auth_profile": "me",
  "env_file": ".env",
  "target": {
    "kind": "context",
    "name": "default",
    "endpoint_fingerprint": "sha256:..."
  },
  "source": {
    "kind": "project",
    "root": "/abs/path/to/project"
  },
  "compile_fingerprint": "sf1:...",
  "manager": "docker",
  "output_directory": "/abs/path/to/project/.spawn",
  "units": [
    {
      "id": "organization",
      "kind": "container",
      "container_name": "spawnfile-research-cell-organization",
      "container_id": "...",
      "image_tag": "research-cell:latest",
      "image_id": "sha256:...",
      "contains": [
        { "kind": "agent", "id": "agent:analyst" },
        { "kind": "network", "id": "research-cell" }
      ],
      "runtime_instances": ["picoclaw-analyst"]
    }
  ]
}
```

The strict v1 parser cannot accept this shape. Implement v2 with a v1 read-compat loader before writing any source-discriminated records. Existing v1 records remain readable; newly written records use v2.

Field disposition in v2:

- `version`, `name`, `created_at`, `target`, `compile_fingerprint`, `manager`, and `units` remain required.
- `units` must contain at least one started unit for a deployment record; static image inspection is not a deployment and writes no deployment record.
- `contains` and `runtime_instances` stay per-unit, as in v1 and `specs/STATUS.md`. Live status binds each runtime instance's probes to its hosting unit's gateway through this mapping, and spread deployments depend on it. Do not lift these fields to record level.
- v2 extends the `contains` kind enum from v1's `agent | team` to `agent | team | network`. Agent and team entries use compile `NodeReport.id` values (`agent:analyst`); network entries use the declared network id. Project records populate network entries from the compile plan's network declarations; image records populate them from the cached distribution report's `moltnet.networks[]`.
- Each unit keeps the existing live-status/redeploy fields: `id`, `kind`, `container_name`, `container_id`, `image_tag`, `image_id`, `contains`, `runtime_instances`.
- Units may additionally carry optional per-unit `manager`/`target` overrides. Record-level `manager`/`target` remain required and act as the default for units without overrides; a unit-level override wins for that unit. Docker and compose write only the record-level values, but v2 must allow the per-unit shape structurally so spread deployments (units of one organization on different substrates) do not require a v3 migration. See Deployment Managers.
- `auth_profile` remains nullable/optional and stores only the local profile name, never credential material.
- `env_file` remains nullable/optional and stores the user-provided path, not generated support files.
- `source` is required and replaces v1's implicit project-root assumption.
- `source.kind: "project"` requires `source.root`.
- `source.kind: "image"` requires `source.ref` and allows `source.digest: string | null`.
- `output_directory` stays on project records because `status <path> --deployment <name>` still needs to find the compile report for `--out` builds after the record store is decoupled from `--out`. Image records set `output_directory: null` and use the cached distribution report beside the home-store record.
- Image records populate each unit's `contains` and `runtime_instances` from the cached distribution report at write time so live status, probes, hosting observations, and redeploy do not need project source.

For image deployments, `source.digest` is the registry content digest when Spawnfile can know it:

- digest-pinned refs (`name@sha256:...`) record that digest directly;
- pulled registry tags record the matching `RepoDigests[]` value when Docker reports one;
- local-only images or imported images may have no registry digest, so `digest` is `null` and registry drift is unavailable.

`unit.image_id` remains the immutable local daemon image id captured after container start. `source.digest` answers "which registry artifact did we intend to run"; `unit.image_id` answers "which local image object did this container actually start from."

## Record Stores and Lookup

Project deployment records should be written under the resolved project argument's `.spawn` directory. Do not key this off the process cwd when the user passed an explicit project path. This is a behavior change for the current implementation and touches compile/build/run/up/status path handling, not only distribution.

When `--out <dir>` is supplied, generated artifacts go to `<dir>`, but the deployment record store still belongs to the resolved project path unless the command explicitly opts into a different record store. `--out` is a build artifact location, not an identity for the project deployment.

Sourceless image deployments live under the Spawnfile home store. The default is `~/.spawnfile`, overridable by `SPAWNFILE_HOME`:

```text
~/.spawnfile/deployments/<deployment>/record.json
~/.spawnfile/deployments/<deployment>/spawnfile-report.json
```

The store is selected by argument kind, not by bare flags:

- `status <path> --deployment <name>` reads the project store for `<path>`.
- `status --deployment <name>` reads the home store.
- `status <image-ref>` performs static image inspection from the image report.
- `status <image-ref> --deployment <name>` reads the named home-store deployment and can also compare it to the supplied image ref.

`--deployment` alone never retargets a project command to the home store when a project path was supplied.

This is a breaking semantic change for bare `status --deployment <name>`. Today the CLI defaults the path to cwd, so that command effectively means "deployment `<name>` in this project." Under this design it means "home-store deployment `<name>`." Users who want project-store status must pass the project path explicitly:

```bash
spawnfile status . --deployment research-cell --live
```

If a requested deployment is missing, the error names the store that was searched and shows candidates from that store only. It may add a hint when the same deployment name exists in the other store, but it must not silently retry there. Ambiguity errors follow the same rule: list only candidates from the selected store, plus an optional "also exists in ..." hint.

## Image Redeploy

Explicit deployment names reuse the existing redeploy contract. If `research-cell` already exists, then:

```bash
spawnfile up you/research-cell:1.1.0 --deployment research-cell --detach
```

means "replace this deployment with a container started from the new image" after validating the target, report, auth, and compatibility. The status output should show the previous `source.ref`/digest and the new one.

If the user omits `--deployment`, Spawnfile derives a safe name from the image repository. If that derived name already exists, Spawnfile errors and asks for an explicit `--deployment`; it must not silently redeploy a derived-name deployment.

## Status Without Source

The status layer model (`specs/STATUS.md`) mostly carries over:

- Declared layer: absent. There is no source. Status says so once, plainly.
- Compiled layer: available from the cached or extracted distribution report.
- Deployment/runtime layers: available from the deployment record and live probes.
- Network layer: available when credentials and endpoints allow metadata reads; otherwise render `unknown`. Open-mode operator tokens generated only inside the container may be unavailable to the local CLI, and that is expected.

Static `spawnfile status <image-ref>` renders the organization's interface from the distribution report: agents, team membership, runtimes, non-generated required secret names, ports, networks and rooms where present. It requires no deployment.

Implementation-wise, sourceless status needs an `OrganizationView` projection from the distribution report. The projection should reuse the existing status renderer instead of creating a second image-only output format.

## Drift for Distributed Images

Existing drift detection keeps working where it has data: container id, image id, compile fingerprint, and live probe state. Distribution adds one comparison:

- recorded `source.digest` vs the digest the tag currently points at in the registry: `warn`, "a newer build of this tag has been published."

This check runs only under an explicit networked flag such as `--live --pull-check`; status never contacts registries by default.

If `source.digest` is `null`, registry drift reports `unknown`, not `ok`. If the original ref was digest-pinned, registry drift is unnecessary: the ref itself is immutable, so status reports the digest pin and skips tag lookup unless the user explicitly asks for pull diagnostics.

## Workspace Resources in Distributed Images

The honest Phase 2 contract:

- The image contains generated runtime homes, docs, skills, configs, and entrypoints.
- Git resources can remain as declarations in the distribution report, but private git auth is not solved by this design yet. The current report does not name a git credential secret, and the generated entrypoint has no general credential-injection contract for git clone.
- Workspace volume resources are not durable today for project deployments either, except for explicit Moltnet stores. The distribution report may describe them, but consumer-side durable mounting is an open question.
- Moltnet stores and other already-supported persistent mounts keep their existing behavior and must appear in `persistent_mounts`.

Durable workspace volumes, private git resource auth, and snapshot-resource modes need a separate resource persistence design before distribution claims to support them fully.

## The Two Planes

Everything past single-container Docker distribution separates into two planes that must not be conflated:

- The coordination plane is agent to agent. It exists only when the organization declares networks, and its entire contract is the network binding above. No declared networks means nothing to design and nothing to deploy for this plane.
- The operator plane is spawnfile to deployment. It always exists: deploy, inspect, probe, logs, drift. It never requires agents to share any network, because every operator-plane action flows through a deployment manager, not through the organization's own communication.

Status connects to agents through managers and records, never through Moltnet. Moltnet observations remain the optional fifth status layer, present only when networks are declared.

Federation is the already-possible level of cross-organization connection on the coordination plane: separately deployed organizations meet by declaring the same shared or external Moltnet server and rooms. It requires no composition, no shared deployment, and no new machinery; it is a deployment pattern to document, not a feature to build. Composition (below) is the stronger level, where another organization's published image becomes a declared member of yours.

## Deployment Managers

The deployment manager is the operator-plane bridge between spawnfile and a substrate. The contract is six verbs:

```text
start     plan in, unit facts out (ids, native refs, started state)
stop      future `spawnfile down`
inspect   unit -> exists/running/exit code/ports/mounts/image id
exec      unit + argv -> stdout/exit code
http-get  unit + port + path -> status/body
logs      unit + tail -> raw lines
```

These glosses are the contract's intent, not its schemas. Phase 5 opens with a schema-freezing pass: full JSON sketches for every verb's input and output (the start plan, how a unit is encoded on stdin, the fact shapes out), reviewed with the same rigor as the distribution report, before any manager is refactored onto the contract. The conformance suite is that schema made executable.

Redeploy is `start` with `replace: true` in the plan: the manager replaces any existing unit with the same unit identity (docker: stop and remove, then run; declarative substrates: apply). The current docker implementation never removes a previous same-name container, which the refactor must fix. `stop` remains reserved for a future `spawnfile down`.

`exec`, `http-get`, and `inspect` correspond to the existing `DeploymentProbeGateway` surface from `specs/STATUS.md`, so runtime probes ride the same contract. The current gateway types are docker-shaped: `inspectUnit` returns a Docker-specific inspection that mixes in core-computed drift and severity judgments. The Phase 5 schema pass defines substrate-neutral fact shapes and moves judgment computation fully into core, so the adapter-visible gateway types do change, deliberately, in the facts-only direction.

Managers return facts; core enforces invariants. Record persistence, drift detection, severity mapping, log redaction, exit codes, and the no-secrets-in-records rule all stay in core. A manager never writes record files. At the external boundary this supersedes the current internal structuring where the docker implementation owns record writing (`src/deployment/dockerManager.ts`): built-in managers may keep internal layering, but the external contract receives facts and returns facts.

### Built-in Managers

`docker` (exists), `compose`, `k8s`, and `ecs` ship in the lib as in-process implementations of the same interface. One `k8s` manager covers EKS, GKE, AKS, k3s, and local clusters, because kubeconfig contexts already abstract cluster, cloud, and credentials. Targets remain manager-owned shapes, as established for deployment records: `{kind: "context"}` for docker, `{kubeconfigContext, namespace}` for k8s, `{cluster, region}` for ecs. The non-docker target shapes are illustrative; each manager's own schema pass freezes them. The `k8s` and `ecs` implementations land after Phase 6, when multi-image organizations give them real workloads; Phase 5 proves the contract with docker plus a fake conformance manager.

Image transport: non-docker managers consume registry refs only. A cluster pulls from a registry; it never sees the operator's local daemon. Deploying a project (not an image ref) through a non-docker manager therefore requires a pushed tag (`--tag <registry>/<name>:<version>` plus a push, or `spawnfile publish`) before `start`, and spawnfile fails with exit 2 when a non-docker manager receives an image with no registry ref. Registry push is a hard dependency of every non-docker manager.

### Custom Managers

A custom manager is one executable plus one manifest, modeled on Docker credential helpers and CNI plugins, not on Terraform's provider machinery:

- The executable takes the verb as argv, JSON on stdin, JSON on stdout, non-zero exit as error. Any language. It authenticates to its substrate with the operator's own local credentials; spawnfile never proxies or stores them.
- The manifest declares `name`, `contract: v1`, `command`, `capabilities`, and a `target_schema` (JSON Schema) for its target shape, so records referencing the manager still validate and malformed targets still fail with exit 2 before anything runs.

```yaml
name: corp-nomad
contract: v1
command: /usr/local/bin/spawnfile-manager-nomad
capabilities: [start, stop, inspect, exec, logs]
target_schema:
  type: object
  required: [cluster, namespace]
  properties:
    cluster: { type: string }
    namespace: { type: string }
```

Manifests are operator-machine configuration, the same category as auth profiles and docker contexts. They live in the Spawnfile home, are registered with `spawnfile manager add <file>`, listed with `spawnfile manager ls`, and verified with `spawnfile manager test <name>` against a conformance suite that ships with spawnfile. They are never referenced by a Spawnfile and never committed. The Spawnfile stays the only authored file that defines an organization.

Missing optional capabilities degrade, never crash: no `http-get` means core falls back through `exec` or renders `unknown`; no `logs` means logs render unavailable. A record naming an unregistered manager fails with exit 2 naming the manager and the registration command.

### Manager Selection and Placement

`up` selects the manager and target at first deploy; the record carries both; redeploy reuses them:

```bash
spawnfile up . --detach --deployment prod --manager k8s \
  --target '{"kubeconfigContext":"eks-prod","namespace":"agents"}'
```

`--context vm1` remains supported as sugar for `--manager docker --target {"kind":"context","name":"vm1"}`. The flags disappear after the first successful deploy.

Spread deployments place units of one organization on different substrates. Placement is a deploy-time input keyed by unit id (the unit ids the selected compile target produces; for compose, one per runtime instance plus the network service). This is the placement file format (`spread.json`), not the record shape:

```json
{
  "units": {
    "picoclaw-analyst": { "manager": "k8s", "target": { "kubeconfigContext": "eks-prod", "namespace": "agents" } },
    "moltnet": { "manager": "docker", "target": { "kind": "context", "name": "vm1" } }
  }
}
```

Spawnfile translates the placement file into per-unit `manager`/`target` fields on the record's `units` array; the record schema in Deployment Records stays the single normative shape for persisted state.

The user-facing `--placement ./spread.json` flag becomes usable in Phase 6, when the compose target first produces multiple units; Phase 5 only validates that per-unit `manager`/`target` round-trips through the record. Status iterates units and builds each unit's gateway from that unit's own manager and target, so one `status --deployment <name> --live` renders one organization view across all substrates.

### Substrate Coverage, Honestly

The contract requires a substrate that can run a long-lived container from a registry ref with env vars, report its state, and ideally exec inside it. That covers docker fleets, compose, any Kubernetes, ECS/Fargate, Nomad, Fly-class platforms, and fully custom setups such as a LAN of small machines reached over SSH. Scale-to-zero serverless conflicts with always-on agents, and exec-less platforms degrade probe fidelity to `unknown`. Pure FaaS is out of scope: agents are daemons, not request handlers. Non-container unit kinds are deferred.

## Compile Targets and Multi-Image Organizations

The compile target governs how the organization's own nodes are packaged. It changes operational granularity, never meaning:

- `--target container` (default, today): one image, all runtime instances, in-image Moltnet server, localhost wiring. The org as an appliance.
- `--target compose`: one image per runtime instance plus a Moltnet server service, wired by a generated `compose.yaml` over the network binding contract. The org as a small fleet. Per-instance images also enable per-container secret env subsetting, which is strictly better than the monolith.
- Future renderers (`k8s`, `ecs`) emit the same plan as manifests or task definitions for the corresponding manager. Renderer plus manager is the unit of substrate support; the contracts above do not change.

`compose.yaml` and its successors are compile outputs. Spawnfile stays a compiler; the manager runs the artifact.

### Sharing a Multi-Image Organization: the Org Index

The sharing unit stays one ref. A multi-image compile publishes N member images plus one tiny org index image that contains no runtime, only metadata:

```text
you/research-cell:1.0.0            the index, what you share
  /spawnfile/org.json              org-level report, network plan,
                                   digest-pinned member list
you/research-cell-orchestrator     member images, also individually
you/research-cell-researcher      importable
```

Rules:

- The index pins members by digest, so an org version is atomic: there is no partially updated fleet.
- The Moltnet server service is its own member image (`<namespace>/<org>-moltnet`), digest-pinned in the index like any other member.
- Member repos use `<namespace>/<org>-<instance>` naming; the index lives at the bare org name. One repo per image; no suffix-tag multiplexing inside a single repo.
- The generated `compose.yaml` ships inside the index image next to `org.json`, so the index alone is sufficient to deploy without recomputing the plan.
- Consumer `up <index-ref>` pulls the index, reads `org.json` with the same helper-container flow (local daemon, as in Consumer Flow), pulls members by digest, and deploys through the selected manager. The record's `source.digest` is the index digest; units carry member digests.
- At consumer deploy, core (never the manager) computes each unit's `SPAWNFILE_NETWORK_*` env values from the index's network plan plus the addresses the manager reports for started units, and core mints member admission tokens at deploy time. Tokens are deployment-scoped secrets injected through the start plan env, never baked into member images.
- `org.json` gets the same schema-freezing treatment as the distribution report at the start of Phase 6; the sketch above is intent, not schema.
- This is the same shape as multi-arch manifest lists, so multi-arch later nests beneath members without colliding.
- OCI artifacts (ORAS) are the cleaner future encoding for `org.json`; a plain metadata image is the v1 choice because it works on every registry today.

## Composition: Image Members (Future)

Composition means a Spawnfile declaring a member that is a published image:

```yaml
members:
  - id: research
    image: you/research-cell-researcher@sha256:...
```

Composition is a separate future design with its own document and review cycle, but the decisions worth freezing now:

- An imported image always runs as its own unit. It is never merged into another image: merging breaks digest identity, signing, entrypoint ownership, and update independence. A `--target container` org with one image member therefore becomes a hybrid multi-unit deployment, using the same network binding and manager contracts as everything else.
- The distribution report is the import interface. The importing compiler reads it at compile time through the helper-container flow and validates composition against declared facts, never against live state. The write-only rule survives composition.
- Imported node ids are namespaced by member id; imported required secrets surface into the parent's preflight under a member prefix.
- Image members must be digest-pinned. Room membership for imported agents is declared in the importing Spawnfile and admitted through Moltnet auth, with tokens minted by the importing compile.
- Composition depends on the network binding contract and the manager contract having shipped first.

## Creator Flow and `spawnfile publish`

Phase 0 needs no new commands: `spawnfile build --tag` + `docker push`. Once Phase 1 lands, pushed images are self-describing.

`spawnfile publish` is later sugar with one real job:

```bash
spawnfile publish . --tag you/research-cell:1.0.0
```

- Compile + build + push in one step.
- Pre-push verification: embedded distribution report present, schema-valid, path-free, secret-free, and carrying `required`/`generated` markers for every secret entry.
- Prints the pushed digest, which is what creators should put in release notes.

## Deferred

- Moving import-based Codex/Claude/OpenClaw auth patching into generated entrypoints for sourceless images.
- Durable workspace volume resources for consumers.
- Private git resource credential declaration and injection.
- Snapshot resource mode for packaging selected source/resource content into the image.
- Multi-arch (`docker buildx`, amd64+arm64 manifests).
- Image signing and provenance (cosign / OCI referrers).
- Registry discovery index.
- Major/minor compatibility ladder for future image contracts.
- Non-container unit kinds (`process`, `job`) in the deployment manager contract.
- OCI artifact (ORAS) encoding for the org index.
- Registry-API metadata extraction (reading reports and `org.json` without a local Docker daemon).
- Spread-deployment placement UX beyond the initial placement file.

## Testing Strategy

Per-phase bullets below list contract and unit tests. This section defines the tiers above them.

### Tiers and Coverage

- Unit/contract tests live next to their modules (`file.ts` / `file.test.ts`) and follow the repo's 90%+ coverage standard. New folders (`src/distribution/`, manager contract modules) are not exempt.
- Schema tests: the distribution report, `org.json`, the v2 record, and the manager verb schemas each get fixture-based round-trip tests plus the negative assertions (path-free, secret-free, collision rules) as soon as their schema exists. The JSON examples in this doc graduate to committed fixture files that both the doc and the tests reference, so doc and code cannot drift without a test failing.
- Adversarial input tier: sourceless consumption parses internet-controlled data, and is tested that way. The extractor is exercised against synthetic tar streams without Docker: tar entries that are symlinks or unexpected extras are rejected, the report has an enforced size cap, a `com.spawnfile.report` label pointing at a missing or non-file path fails cleanly, and a report with a wrong or lying schema version fails before anything starts.
- The manager conformance suite is itself a test artifact: generated from the frozen verb schemas, runnable against any manager via `spawnfile manager test`, and exercised in CI against the built-in docker manager and a fake external manager.
- Live E2E scripts follow `src/e2e/CLAUDE.md`: isolated fixtures, alternate ports, never a developer's active Moltnet, real runtime auth injected before judging agent behavior. They run via the existing `src/e2e/cli.ts` harness, not the default vitest suite.

### E2E Infrastructure

- A local `registry:2` container on an isolated port is the only registry any test touches. No test pushes to real registries.
- Phase 1 commits a dedicated `fixtures/distribution-org` fixture, because the existing fixtures cannot run the scenarios: `multi-runtime-team` declares `claude-code` auth on every agent (which sourceless `up` refuses by design) and no existing non-e2e fixture declares networks. `distribution-org` uses `api_key` auth across two runtimes, declares one managed network with rooms, and declares both a required and an optional project secret. `fixtures/single-agent` stays the minimal no-network case.
- A fake external manager (a small script speaking the verb protocol) is committed as a test fixture: it satisfies conformance, records its invocations, and can simulate missing capabilities, failures, secret-bearing facts, and record-write attempts.
- One throwaway consumer environment per run: a temp dir with no project, its own `SPAWNFILE_HOME`, so sourceless flows are tested genuinely sourceless. The test creates an auth profile inside that throwaway home, because the headline consumer flow is profile-based and an empty home has none.
- Second image versions are produced the way the existing e2e rules already model mutation: copy the fixture to a temp dir, change content, rebuild. Rebuilding unchanged content is not assumed to change the digest.

### Named E2E Scenarios

- E2E-1 (Phase 1, image contract): build the fixture org, inspect the real image: labels present and identifier-only, report extractable at the labeled path, path-free and secret-free assertions run against the actual embedded bytes, manual `docker build` from the output root yields the same contract.
- E2E-2 (Phase 2, sourceless roundtrip): push `distribution-org` `:1.0` to the local registry, switch to the throwaway consumer env, create an auth profile there, `up <ref> --detach --auth-profile <p>`, `status --deployment <name> --live` shows deployment/runtime layers ok and declared absent. Drift leg (joins the scenario at the Phase 3 gate, since `--pull-check` ships in Phase 3), in this order: push mutated bytes to the same `:1.0` tag, `--pull-check` warns "newer build published", then redeploy with a `:1.1` push and status shows the old and new ref/digest. Negative legs: missing required secret fails preflight with no organization container started; no `spawnfile-inspect-*` helper containers survive success or failure; two `up`s of the same image under different deployment names create distinct derived volumes that are never shared.
- E2E-3 (Phase 3, publish): publish refuses a report seeded with a path leak; the printed digest matches the registry manifest.
- E2E-4 (Phase 4, rebinding): stand up an external Moltnet server container from the staged Moltnet binaries on an isolated port, provision it with the member admission tokens via the same core minting path consumers use, then run the org image with `SPAWNFILE_NETWORK_*_URL`/token vars pointed at it: in-image server suppressed, bridges attach to the external server. The attach/suppression legs run in CI without model credentials; the "wakes deliver" leg requires real runtime auth and is developer-opt-in per the e2e rules. Control leg: same image with no overrides behaves exactly as before the contract (regression guard for every already-published image).
- E2E-5 (Phase 5, managers): register the fake manager, conformance passes, `up --manager fake` records manager facts, `status --live` reads through it, a capability-stripped variant renders `unknown` without crashing.
- E2E-6 (Phase 6, fleet): compose-target the fixture org, publish index plus members, consumer `up <index-ref>`, one status view across the fleet, stop one member container and status shows exactly that unit degraded, placement file round-trips into per-unit record fields.

### CI Model

The repo currently has no PR test workflow at all (only tag-triggered publish and website deploy), so this strategy presupposes one and Phase 1 adds it:

- PR workflow (every PR): typecheck, the vitest suite with the 90% coverage gate, the adversarial extractor suite (synthetic tar bytes, no Docker), and the manager conformance suite against the fake manager. The runner has Docker, so docker-manager conformance and E2E-1 run on PRs that touch distribution code.
- Phase gates: each phase merges only with its E2E scenario green (E2E-1 through E2E-6 as the phases land).
- Pre-release: E2E-1 through E2E-3 always; E2E-4 through E2E-6 once their phases exist; the k8s job and any credential-requiring legs are manual/opt-in.

### Honest Limits

- `k8s` e2e runs against a throwaway local cluster (kind or k3d) in an optional CI job, not the default suite. `ecs` has no local e2e; it ships behind the conformance suite plus a documented manual validation checklist. This is stated here so nobody mistakes conformance-green for cloud-verified.
- Network binding e2e covers docker substrates only until Phase 6; cross-substrate reachability (cluster to VM) is an operator networking concern and is not simulated in CI.

## Implementation Phases

### Phase 0: Document It

- README/website section: push the built image, run it with the documented env vars. Works today for project-auth flows only; sourceless image `up` is not claimed yet.

### Phase 1: Self-Describing Images

- Add a distribution-report builder that derives a path-free, secret-free report from compile/status data.
- Add minimal organization summary fields needed for sourceless status: manifest-derived project name, agent ids/names, team membership, runtime names, `model`/`project`/`runtime`/`surface` secrets with `required` and `generated` markers, ports, resources, persistent mounts, Moltnet summaries, runtime instances, node ids, and provider-keyed per-instance model auth methods.
- Include `moltnet.networks[]` entries (`id`, `server_mode`, `binding`) in the v1 report schema, so the network binding contract adds behavior in Phase 4 without a schema or fingerprint change.
- Emit `/spawnfile/spawnfile-report.json` from the compiler-generated container artifacts.
- Emit image labels from the generated Dockerfile/rootfs path, not only from `spawnfile build`.
- Tests: report present in built image, labels present and identifier-only, report project comes from the root manifest name and not the checkout directory, image/container project labels use the same normalized manifest-name slug, compile fingerprint is computed from the path-free distribution report, report is secret-free, report is host-path-free, actual compiler secret categories are preserved, required/generated markers are present, optional secrets are represented but not demanded, persistent mounts are present, runtime instances include node ids and provider-keyed model auth methods, manual Docker build from generated artifacts keeps the labels/report.

### Phase 2: Sourceless Run and Status

- Image-reference detection in `up`/`status` with the rules above; `run <image-ref>` remains unsupported with a clear exit 2.
- Pull/inspect image, read embedded report via `docker create`/`docker cp` with guaranteed cleanup, validate contract and auth support.
- Support only env/secret-based model auth (`api_key`) for sourceless image deployments; fail clearly for import-based auth.
- Add deployment record v2 with source union and v1 read compatibility.
- Cache the extracted distribution report beside the home-store deployment record atomically.
- Status renders compiled/deployment/runtime/network layers from the cached report + record; declared layer reported absent.
- Static `status <image-ref>` interface view.
- Tests: ref detection matrix (dir/file path wins, `--image` forces, bare implicit name exits 2, image-mode `run` exits 2, garbage exits 2), selected-store missing-deployment errors name only that store's candidates, project record store follows the resolved project path and not cwd/`--out`, embedded report read does not start the real entrypoint, helper container is cleaned up on success and failure, missing required non-generated consumer secrets fail before organization start, optional secrets and generated runtime secrets are not demanded from the user, unsupported provider-keyed per-instance auth methods fail before organization start, v1 records still read, a v1 record under the new CLI yields exactly one fingerprint-discontinuity drift warning and no crash, v2 records require target/created_at/manager/units-min-1/source and preserve output_directory disposition, v2 units preserve container_name/container_id/kind and per-unit contains/runtime_instances, v2 image record carries source origin and digest/null digest correctly, unknown or missing `com.spawnfile.image_contract` label exits 2 before any start, schema-invalid or wrong-version embedded report fails before organization start, adversarial extractor cases (symlinked/extra tar entries, oversized report, lying report label path) fail cleanly, required model secret satisfied from an auth profile in the consumer home, bare `status --deployment <name>` resolves the home store even when the cwd contains a project with a same-named deployment (and `status . --deployment <name>` resolves the project one; neither silently retries the other store), `up <ref>` without `--deployment` whose derived name collides with an existing deployment exits non-zero and replaces nothing, `--pull` refreshes a stale local tag, two deployments of one image bind distinct derived volumes, sourceless status works from cached report, static image status works against a local fixture image.

### Phase 3: Publish

- `spawnfile publish` with pre-push verification and digest output.
- Registry drift check behind an explicit flag.
- Tests: publish refuses missing/path-leaking/secret-leaking reports, digest printed matches pushed manifest, drift check never fires without the flag.

### Phase 4: Network Binding Contract

- Entrypoint env resolution for declared networks, with compiled-in defaults as fallback (the report schema entries shipped in Phase 1; this phase implements the behavior).
- Env-name normalization, per-member token vars with single-member fallback, enumerated config patch points, and in-image server suppression, per the contract section.
- Ship as close to Phase 1 as possible: images published without this contract can never be rebound, split, or composed, and that is irreversible per image.
- Tests: env override wins over compiled default, absent env falls back unchanged, normalization and collision detection including the cross-kind case (a member id colliding with another network's URL/token var fails compile), per-member token resolution and single-member fallback, in-image server suppressed when its network URL is overridden, admission still requires a minted token, single-container deployments unaffected.

### Phase 5: Deployment Manager Contract

- Opens with the verb schema-freezing pass: full JSON I/O sketches for all six verbs, unit encoding, the start plan, and `replace` semantics, reviewed before code.
- Refactor the built-in docker manager onto the frozen contract, including redeploy `replace` (stop and remove the previous same-name container, which the current implementation never does).
- Manager manifests, `spawnfile manager add/ls/test`, conformance suite generated from the frozen schemas.
- `--manager`/`--target` flags with `--context` as docker sugar; record carries both; redeploy reuses.
- Per-unit `manager`/`target` round-trip validation only; the user-facing `--placement` flag ships with Phase 6, and `k8s`/`ecs` managers follow after Phase 6.
- Tests: fake external manager passes conformance, capability degradation renders `unknown` and never crashes, unregistered manager exits 2 naming it and the registration command, target validated against the manifest schema before any verb runs, replace removes the previous unit before starting, non-docker manager without a registry-ref image exits 2, per-unit manager/target round-trips through the record, status renders one org view across mixed per-unit managers (fake multi-unit records), manager boundary: a fake manager returning secret-bearing facts and attempting record writes results in a persisted record with no secret material and no manager-written files.

### Phase 6: Compose Target and Org Index

- Opens with the `org.json` schema-freezing pass, same treatment as the distribution report.
- `--target compose`: per-instance images, the Moltnet server as its own member image, generated `compose.yaml` (shipped in the index) over the network binding contract, per-container secret subsetting.
- Org index image emission; `up <index-ref>` consumption with digest-pinned members; core computes binding env values and mints deploy-time member admission tokens.
- `--placement` becomes user-facing here, when multiple units first exist.
- `publish` handles multi-image pushes and prints the index digest.
- `k8s` and `ecs` built-in managers follow this phase, once multi-image orgs give them real workloads.
- Tests: same org behaves identically under container and compose targets, index pins resolve, an index with an unavailable or digest-mismatched member deploys nothing, member images individually pullable, tokens never appear in member images or the index, placement maps unit ids to per-unit manager/target in the record.

### Phase 7: Composition

- Separate design document (`COMPOSITION.md`) and review cycle. Blocked on Phases 4 and 5.

Each phase's listed tests are its contract/unit tier; the corresponding E2E scenario (E2E-1 through E2E-6 in Testing Strategy) gates the phase's completion.

## Recommendation

Do not start with sourceless `up`. Ship Phase 1 first only after the distribution report is path-free. It is still cheap, but it is not just "copy the current report into the image."

Phase 2 is the real feature and should be scoped deliberately: API-key auth first, source-discriminated v2 records, cached reports, and explicit failure for runtime auth modes the image cannot configure by itself.

Sequencing for the later phases follows immutability: the network binding contract (Phase 4) is the only later phase that changes what published images can ever do, so it ships first among them, ideally alongside Phase 1. Managers (Phase 5) are pure operator-side code and can land any time. Compose (Phase 6) is a renderer over both. Composition (Phase 7) consumes all of it and earns its own document.

The principle underneath, consistent with the rest of spawnfile: source is for authors, images are for operators, and the distribution report is the contract that lets the second group exist without the first. The three frozen contracts (image contract, manager contract, record schema) are the whole load-bearing structure; everything substrate-specific is a manager, everything org-specific is source, and everything operational is a record.
