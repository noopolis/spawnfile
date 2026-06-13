---
title: DISTRIBUTION.md
description: Image distribution contract for Spawnfile — self-describing images, sourceless run and status, deployment record v2, publish, registry drift, and the network binding contract.
---

# Spawnfile Distribution v0.1

This page mirrors the normative distribution contract. The repository source of truth is `specs/DISTRIBUTION.md`.

## Purpose

A creator compiles an organization once and publishes it as a standard OCI image. A consumer runs it with Docker, an image reference, and their own secrets — no source checkout, no consumer-side compile, no creator infrastructure. Distribution is a registry problem: any OCI registry works, registry auth is `docker login`, and access control is the registry's private-repository mechanism.

It is not DRM, not source distribution, and adds no Spawnfile registry service.

## Image Contract

A published image is a normal runnable image plus three additions, emitted by the compiler-generated Dockerfile so a manual `docker build` from the output root yields the same image.

1. **Embedded distribution report** at `/spawnfile/spawnfile-report.json` — a projection of the compile report that is secret-free, host-path-free, sourceless-runnable, and renderer-compatible. Version `spawnfile.distribution-report.v1`. It carries the organization summary, secrets bucketed into `model`/`project`/`runtime`/`surface` with `required` and `generated` booleans, provider-keyed `model_auth_methods`, ports, persistent mounts (no creator volume names), runtime instances with node ids, and a Moltnet summary with `binding: "env"`.
2. **Image labels** — `com.spawnfile.image_contract` (exact-match `spawnfile.image.v1`), `com.spawnfile.project` (manifest-name slug), `com.spawnfile.compile_fingerprint`, `com.spawnfile.report`. Identifier-only, never host paths or secrets.
3. **Network binding contract** — `SPAWNFILE_NETWORK_<ID>_URL` and `SPAWNFILE_NETWORK_<ID>_TOKEN[_<MEMBER>]`. Ids normalize to `[A-Z0-9_]`; all generated names must be globally unique or compile fails. Setting the URL rebinds endpoints and suppresses the in-image managed server; absent it, the image behaves as a single-container deployment.

## Image References

```bash
spawnfile up <image-ref> --detach --deployment <name> --auth-profile <p>
spawnfile status <image-ref>
spawnfile status --deployment <name> --live
```

An existing directory or file is a project path; an implicit image reference needs a tag, digest, or registry component; `--image` forces image mode. Image-mode `run` is unsupported (exit 2).

## Consumer Flow

`up <image-ref> --detach` pulls the image, verifies the contract label, extracts the report through a stopped helper container without starting the entrypoint, validates secret coverage and auth methods, starts the container, and writes a home-store deployment record with a cached report. Missing required non-generated secrets, unsupported auth, invalid labels, or invalid reports fail before the organization container starts. Sourceless deployment supports `api_key` auth; import-based auth fails with a clear message.

The cp tar stream is parsed defensively (single regular file, size cap, no symlinks or traversal). Persistent mounts get per-deployment volume names so two deployments never share a store.

## Deployment Record v2

Image and project deployments share `spawnfile.deployment.v2` with a v1 read-compatibility loader. `source` is `{kind: "project", root}` or `{kind: "image", ref, digest}`. `contains` extends to `agent | team | network`, stays per-unit with `runtime_instances`, and units may carry per-unit `manager`/`target` overrides. `source.digest` is the registry content digest when known, else `null`.

Image deployment records live under the Spawnfile home (`SPAWNFILE_HOME`, default `~/.spawnfile`). Store selection follows the argument: a project path reads the project store; an image ref or bare `--deployment` reads the home store.

## Status, Redeploy, Drift

`status <image-ref>` renders the static interface from the embedded report with no deployment. Home-store `--live` status projects an `OrganizationView` from the cached report and renders compiled, deployment, and runtime layers; the declared layer is absent.

Redeploy with explicit `--deployment` replaces a deployment after validation, showing old and new ref/digest. Behind `--pull-check` (networked, never default), status compares the recorded digest against the registry tag: `warn` on a newer build, `ok` on a match, `unknown` on a null digest, and digest-pinned refs skip the lookup.

## Creator Flow

`spawnfile build --tag` plus `docker push` ship a self-describing image. `spawnfile publish <project> --tag <ref>` composes compile, build, pre-push verification (refusing to publish a report that leaks creator paths or omits secret markers), and push, printing the digest.

## Deferred

Multi-arch builds, signing, the registry discovery index, entrypoint-driven import auth, durable volumes, private git auth, registry-API extraction, compose/k8s/ecs targets with the org index, and composition (image members).
