---
title: Distribution
description: Publish a compiled Spawnfile organization as an OCI image and run it anywhere without the source.
---

`spawnfile` compiles an organization into a self-describing Docker image. You can push that image to any registry, and someone else can run it with nothing but Docker, the image reference, and their own secrets — no source, no compile step.

## Publish an Organization

`spawnfile publish` compiles, builds, verifies, and pushes in one step:

```bash
spawnfile publish ./research-cell --tag you/research-cell:1.0.0
```

It prints the pushed digest, which is what you put in release notes:

```text
published you/research-cell:1.0.0
digest: sha256:3d5d9fbbc45d...
```

Pre-push verification refuses to publish an image whose embedded report leaks a creator path or omits secret markers. If you prefer the explicit path, `spawnfile build --tag <ref>` followed by `docker push <ref>` produces the same self-describing image.

## What Is in a Published Image

Every compiled image carries:

- an embedded report at `/spawnfile/spawnfile-report.json` — secret-free and free of creator host paths;
- labels (`com.spawnfile.image_contract`, `project`, `compile_fingerprint`, `report`);
- the network binding contract for organizations that declare Moltnet networks.

You can inspect any published image without running it:

```bash
spawnfile status you/research-cell:1.0.0
```

```text
Image: you/research-cell:1.0.0
Project: research-cell
Agents
  agent:coordinator  openclaw teams=team:research-cell
  agent:researcher   picoclaw teams=team:research-cell
Required secrets
  ANTHROPIC_API_KEY
  SEARCH_API_KEY
```

Generated runtime tokens and optional secrets are never listed as required — you only see what you must provide.

## Run an Organization Without Source

A consumer deploys straight from the registry:

```bash
spawnfile up you/research-cell:1.0.0 --deployment research --detach --auth-profile me
```

`up` pulls the image, reads the embedded report, checks that every required secret is available before starting anything, runs the container, and records the deployment under your Spawnfile home (`~/.spawnfile/deployments/research/`). If a required secret is missing, it fails before any container starts and tells you which.

## Running on Your Own Subscription

Agents can authenticate with an API key (`api_key`) or by reusing your logged-in Claude Code / Codex session (`claude-code`, `codex`). Both work sourceless. If a published image's agents use subscription auth, deploy it with an auth profile that has the matching import:

```bash
spawnfile auth import claude-code --profile me   # one-time, from your local Claude Code login

spawnfile up you/research-cell:1.0.0 --deployment research --detach --auth-profile me
```

The image already carries the OAuth-mode config; spawnfile injects your credential at start, so the agents run on your subscription rather than a pay-per-token key. If you provide neither an API key nor the matching import, preflight fails before anything starts and tells you exactly which runtime and method it needs.

## Check a Sourceless Deployment

```bash
spawnfile status --deployment research --live
```

This reads the home-store record and cached report and reports the compiled, deployment, and runtime layers. The declared layer is absent — there is no source — and status says so plainly.

To check whether a newer image was published to the same tag since you deployed:

```bash
spawnfile status --deployment research --live --pull-check
```

`--pull-check` is the only status path that contacts a registry, and only when you ask.

## Redeploy

Deploy a new version over the same deployment name:

```bash
spawnfile up you/research-cell:1.1.0 --deployment research --detach
```

The new reference replaces the deployment after validation, and status shows the previous and new digest. Without `--deployment`, a derived name that already exists is an error rather than a silent redeploy.

## Connecting to an External Network

When an organization declares a Moltnet network, its image honors the network binding contract. Suppose `research-cell` declares a network `research_floor` with a member `coordinator`. The env var names are derived from those declared ids by uppercasing and replacing non-alphanumeric characters with `_`. Point the declared network at an external server with environment variables:

```bash
spawnfile up you/research-cell:1.0.0 --deployment research \
  --env-file ./network.env
```

```text
# network.env — derived from network id "research_floor", member "coordinator"
SPAWNFILE_NETWORK_RESEARCH_FLOOR_URL=https://moltnet.example.com
SPAWNFILE_NETWORK_RESEARCH_FLOOR_TOKEN_COORDINATOR=...
```

When the URL is set, the image rebinds its bridges to that endpoint and does not start its own in-image server for that network. Absent the variable, the image runs as a self-contained single-container deployment. (Image-mode `up` always deploys detached, so `--detach` is optional.)

## What Distribution Does Not Cover

Out of scope for v0.1:

- Multi-arch images (amd64 + arm64 manifests)
- Image signing and provenance
- A Spawnfile registry or discovery index
- Entrypoint-driven import auth (so an image can patch its own runtime config from mounted credentials without the consumer's CLI doing it)
- Durable consumer workspace volumes and private git resource auth
- Compose, Kubernetes, and ECS targets, and importing an image as a member of another organization
