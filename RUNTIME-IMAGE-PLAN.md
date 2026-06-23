# Spawnfile Runtime Image Plan

This note describes the runtime image plan for faster Spawnfile builds and
deployments. Daimon, OpenClaw, and PicoClaw use this model.

## Goal

Spawnfile should build and deploy organizations quickly without recompiling or
reinstalling heavy runtime dependencies on every org change.

The image strategy must support mixed-runtime organizations without publishing
one image for every possible runtime combination.

## Image Layers

There are three separate artifact types:

1. Spawnfile CLI/compiler package
   - Published to npm as `spawnfile`.
   - Changes whenever the compiler, CLI, docs, validation, or generated output
     changes.
   - Does not require runtime image rebuilds unless the runtime install layout
     or generated container contract changes.

2. Runtime artifact images
   - One image per runtime and pinned runtime version.
   - Contain preinstalled runtime dependencies only.
   - Do not contain any org source, agent prompts, secrets, auth, Moltnet
     credentials, generated configs, workspaces, or deployment state.

3. Compiled organization images
   - Built from a specific Spawnfile organization.
   - Contain generated agent files, entrypoint, Moltnet wiring, workspaces, and
     static org config.
   - Rebuilt whenever the organization changes.

## Runtime Image Model

Do not publish combination images such as:

- `daimon-openclaw`
- `daimon-picoclaw`
- `openclaw-picoclaw`
- `daimon-openclaw-picoclaw`

That model does not scale as more runtimes are added.

Instead, publish one copyable runtime image per runtime:

```text
noopolis/spawnfile-runtime-daimon:0.1.0
noopolis/spawnfile-runtime-openclaw:2026.6.8
noopolis/spawnfile-runtime-picoclaw:<picoclaw-version>
```

Generated org Dockerfiles compose the exact runtimes they need with
multi-stage copies:

```dockerfile
FROM noopolis/spawnfile-runner:node22 AS final

COPY --from=noopolis/spawnfile-runtime-daimon:0.1.0 \
  /opt/spawnfile/runtime-installs/daimon \
  /opt/spawnfile/runtime-installs/daimon

COPY --from=noopolis/spawnfile-runtime-openclaw:2026.6.8 \
  /opt/spawnfile/runtime-installs/openclaw \
  /opt/spawnfile/runtime-installs/openclaw

COPY container/rootfs/ /
```

This allows a Daimon-only org, an OpenClaw-only org, and a mixed
Daimon/OpenClaw/PicoClaw org to reuse the same runtime artifacts.

## Common Runner Image

A small common runner image may be useful:

```text
noopolis/spawnfile-runner:node22
```

It should contain only common OS and runtime prerequisites:

- Node 22
- bash
- ca-certificates
- curl
- git
- tar
- a `spawnfile` user and compatible filesystem layout

The runner image should not contain runtime-specific packages unless they are
truly shared by every runtime.

## Daimon Runtime Image

The Daimon runtime artifact image should install:

- `@noopolis/daimon@0.1.0`
- `@earendil-works/pi-coding-agent@0.79.9`
- `@earendil-works/pi-ai@0.79.9`

Expected install location:

```text
/opt/spawnfile/runtime-installs/daimon
```

It should be usable only as a copied runtime artifact, not as a full deployed
organization.

## Rebuild Rules

Rebuild and publish a runtime image when:

- The pinned runtime version changes.
- The runtime package dependency set changes.
- The runtime install path or container contract changes.
- The required Node/system dependency baseline changes.

Do not rebuild runtime images for ordinary Spawnfile releases that only change:

- CLI rendering
- validation
- status output
- docs
- non-runtime compiler logic

Rebuild a compiled organization image when that organization changes.

## Local Tags

The local tag names to use while testing are:

```text
noopolis/spawnfile-runner:node22-local
noopolis/spawnfile-runtime-daimon:0.1.0-local
noopolis/spawnfile-runtime-openclaw:2026.6.8-local
noopolis/spawnfile-runtime-picoclaw:<picoclaw-version>-local
```

Do not push these local tags.

Spawnfile provides local build scripts for the runtime artifacts it owns:

```bash
npm run runtime:openclaw-image
npm run runtime:picoclaw-image
npm run runtime:images
```

Public tags should not include `-local`:

```text
noopolis/spawnfile-runtime-daimon:0.1.0
noopolis/spawnfile-runtime-daimon:latest
```

## GitHub Workflow

Runtime repositories should provide release workflows that:

1. Build runtime images only when the corresponding runtime version changes.
2. Build multi-arch images for `linux/amd64` and `linux/arm64`.
3. Log in with Docker Hub secrets.
4. Push exact version tags and, where appropriate, `latest`.

Required secrets:

```text
DOCKERHUB_USERNAME=noopolis
DOCKERHUB_TOKEN=<docker-access-token>
```

## Current Implementation

Spawnfile uses the Daimon, OpenClaw, and PicoClaw runtime artifact images
declared in `runtimes.yaml` by default. Generated Dockerfiles copy
`/opt/spawnfile/runtime-installs/<runtime>` from each image and skip runtime
npm/archive installs during organization builds.

Local builds can override those artifacts with:

```text
SPAWNFILE_DAIMON_RUNTIME_IMAGE
SPAWNFILE_OPENCLAW_RUNTIME_IMAGE
SPAWNFILE_PICOCLAW_RUNTIME_IMAGE
```

The legacy `SPAWNFILE_DAIMON_RUNTIME_BASE_IMAGE` environment variable is treated
as a compatibility alias for the same copyable artifact path. New usage should
prefer `SPAWNFILE_DAIMON_RUNTIME_IMAGE`.

The runtime-image workflow in this repository builds and publishes the OpenClaw
and PicoClaw artifact images. The Daimon artifact image is built by the Daimon
repository because Daimon is a separate Noopolis package.
