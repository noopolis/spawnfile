# Spawnfile Distribution v0.1

This document defines how a compiled Spawnfile organization is published as a standard OCI image and consumed without source.

Related specs: `SPEC.md` (CLI surface), `COMPILER.md` (compile report), `CONTAINERS.md` (image layout and entrypoint), `STATUS.md` (deployment records and live status), and `SURFACES.md` (Moltnet networks).

---

## Goal

A creator compiles an organization once and publishes it as an OCI image. A consumer runs that organization with Docker, an image reference, and their own secrets — no Spawnfile source checkout, no consumer-side compile, no creator-operated infrastructure.

The default compile target produces one container, so the image already is the deployable organization. Distribution is therefore a registry problem: any OCI registry works, registry auth is delegated to `docker login`, and access control is the registry's private-repository mechanism.

## Non-Goals

- Not DRM. Image contents are extractable; publishing hides the source checkout and build layout, not the generated runtime material.
- No source distribution or remixing. Consumers run organizations; they do not edit them.
- No Spawnfile registry service. A future registry would be a discovery index over images in ordinary registries.

## Image Contract

A published image is a normal runnable image plus three additions, emitted by the compiler-generated Dockerfile and rootfs so a manual `docker build` from the output root produces the same self-describing image.

### 1. Embedded distribution report

The image contains a distribution-safe report at `/spawnfile/spawnfile-report.json`. It is a projection of the compile report, guaranteed:

- secret-free: secret names only, never values;
- host-path-free: no creator project roots, output directories, or node source paths;
- sourceless-runnable: enough data for consumer-side `up` and `status`;
- renderer-compatible: enough data to project an `OrganizationView`.

The report carries: schema version `spawnfile.distribution-report.v1`, a compile fingerprint computed over the path-free report body (excluding `generated_at`), the organization summary (project name from the root manifest, agents, teams), secrets bucketed into the compiler's actual categories (`model`, `project`, `runtime`, `surface`) each with `required` and `generated` booleans, provider-keyed `model_auth_methods` at report and per-instance level, ports, persistent mounts (without creator volume names), runtime instances with node ids, and a Moltnet network summary with `binding: "env"`.

### 2. Image labels

```text
com.spawnfile.image_contract=spawnfile.image.v1
com.spawnfile.project=<manifest-name-slug>
com.spawnfile.compile_fingerprint=sf1:...
com.spawnfile.report=/spawnfile/spawnfile-report.json
```

Labels are identifier-only — no host paths, no secrets. `image_contract` is exact-match; an unsupported value fails before container start. The project label is a normalized slug of the root manifest name, and managed container labels use the same source so image and container values agree.

### 3. Network binding contract

For organizations that declare networks, bridges and clients resolve their endpoint and credential from the environment at start:

```text
SPAWNFILE_NETWORK_<ID>_URL=<reachable Moltnet endpoint>
SPAWNFILE_NETWORK_<ID>_TOKEN[_<MEMBER>]=<admission credential>
```

- Ids are uppercased and every non-`[A-Z0-9]` character becomes `_`. Every generated binding env name (URL and token vars, across all networks and members) must be globally unique after normalization, or compile fails.
- Tokens are per member; when a container hosts exactly one member of a network the unsuffixed token var is accepted.
- When `SPAWNFILE_NETWORK_<ID>_URL` is set, the entrypoint rebinds generated config endpoints to it and does not start the in-image managed server for that network. Absent the var, the image behaves exactly as a single-container deployment.
- The report's `moltnet.networks[]` entries declare `binding: "env"` so consumers and importing compilers can tell rebindable images from pre-contract images.

## Image References in the CLI

`up` and `status` accept an image reference where they accept a project path:

1. An existing directory or file is a project path.
2. An implicit image reference needs a tag, digest, or registry component.
3. `--image` forces image interpretation (including bare names).
4. Anything else is a usage error (exit 2).

A directory wins over a same-spelled ref unless `--image` is set. Image-mode `run` is unsupported and exits 2 pointing to `up <image-ref> --auth-profile <profile>` (image deployments always detach; `--env-file` adds extra secrets).

## Consumer Flow

Image-mode `up` is always detached (it records a deployment and returns), so `--detach` is optional for an image reference. `spawnfile up <image-ref>` never compiles or builds. It:

1. Pulls the image if needed (`--pull` forces a refresh).
2. Inspects labels and verifies `com.spawnfile.image_contract`.
3. Extracts the report without starting the entrypoint: a stopped helper container (`spawnfile-inspect-<id>`), `docker cp` of the report path, then `docker rm`, with cleanup guaranteed. The cp tar stream is parsed defensively (single regular file, size cap, no symlinks or traversal). Metadata extraction always uses the local Docker daemon regardless of the deployment manager.
4. Validates the report schema, secret coverage by category, generated markers, and per-instance auth methods. Missing required non-generated secrets, unsupported auth, invalid labels, or invalid reports fail before the organization container starts.
5. Starts the container with standard env wiring and labels; persistent mounts get per-deployment volume names (`spawnfile_<deployment>_<mount-id>`).
6. Writes a deployment record and caches the report atomically beside it.

Auth scope: sourceless deployment supports `api_key` model auth and import-based auth (Claude Code, Codex) when the consumer supplies the matching local credential import in their auth profile. The OAuth-mode runtime config is baked into the image at compile time, so the consumer only provides their logged-in credential — the same one a project deployment uses. An instance whose auth method the consumer cannot satisfy (no api_key secret and no matching import) fails preflight with a clear message naming the runtime, agent, and method.

## Deployment Record v2

Image and project deployments share `spawnfile.deployment.v2`. A v1 read-compatibility loader upgrades old records on read; new records are written as v2.

- `source` is a discriminated union: `{kind: "project", root}` or `{kind: "image", ref, digest}`.
- `output_directory` stays on project records; image records set it `null` and use the cached report.
- `contains` extends to `agent | team | network`; agent/team entries use compile node ids, network entries the declared network id. They stay per-unit alongside `runtime_instances`.
- Units may carry optional per-unit `manager`/`target` overrides; record-level values are the default.
- `source.digest` is the registry content digest when known: digest-pinned refs record it directly, pulled tags record the matching `RepoDigests` value, local-only images record `null`.

## Record Stores

- Project deployments live under the project's `.spawn/deployments/`. The default output directory resolves under the resolved project argument, not the process working directory, so `spawnfile compile ./org` and `spawnfile status ./org` agree on `./org/.spawn`. An explicit `--out` overrides this.
- Image deployments live under the Spawnfile home (`SPAWNFILE_HOME`, default `~/.spawnfile`) at `deployments/<name>/record.json` plus the cached `spawnfile-report.json`.
- Store selection follows the argument: a project path reads the project store; an image ref or a bare `--deployment` reads the home store. Bare `status --deployment <name>` reads the home store; project-store status requires an explicit path. Errors name only the searched store.

## Status Without Source

`status <image-ref>` renders the static interface from the embedded report — agents, team membership, runtimes, non-generated required secrets, ports, networks — no deployment required.

`status --deployment <name> --live` for a home-store image deployment reads the cached report, projects an `OrganizationView`, and renders the compiled, deployment, and runtime layers. The declared layer is reported absent. The network layer renders `unknown` where the cached report lacks server plans.

## Image Redeploy

Explicit `up <new-ref> --detach --deployment <name>` replaces an existing deployment after validating target, report, and auth, showing the previous and new ref/digest. Without `--deployment`, a derived name that already exists is an error rather than a silent redeploy.

## Registry Drift

Behind `--pull-check` (networked, never default), status compares the recorded `source.digest` against the digest the tag currently resolves to: `warn` on a newer published build, `ok` on a match, `unknown` on a null recorded digest, and a digest-pinned ref skips the lookup as `ok`. A multi-arch tag (manifest list) also resolves to `unknown`: the recorded digest is the index digest, which cannot be derived from the per-platform manifests the lookup returns, so drift is reported as undeterminable rather than as a false positive.

## Creator Flow

`spawnfile build --tag` plus `docker push` ship a self-describing image. `spawnfile publish <project> --tag <ref>` composes compile, build, pre-push verification, and push in one step: it refuses to publish a report that leaks creator paths or omits secret markers, and prints the pushed digest.

## Deferred

Multi-arch builds, image signing, the registry discovery index, durable workspace volumes, private git resource auth, registry-API metadata extraction, compose/k8s/ecs compile targets and the org index, and composition (image members). The network binding report entries ship now so these can layer on without a schema or fingerprint change.
