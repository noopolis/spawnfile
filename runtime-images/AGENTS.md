# Runtime Images

This folder owns Dockerfiles for the runtimes Spawnfile packages itself:
`openclaw/`, `picoclaw/`, and `daimon/`. Their `noopolis/spawnfile-runtime-*`
images are built and pushed by `.github/workflows/runtime-images.yml` and pinned
in this repo's `runtimes.yaml`. `src/runtime/container.ts` `COPY --from`s these
images into generated organization Dockerfiles.

The `daimon/` image is built here from the **published** `@noopolis/daimon`,
`@noopolis/mneme`, and `@earendil-works/pi-*` packages (build-args
`DAIMON_VERSION`/`MNEME_VERSION`/`PI_VERSION`); it needs no Daimon source
checkout. For development against unreleased sibling checkouts, its Dockerfile
also carries `local` (tarball) and `verify` targets, driven by
`scripts/build-local-daimon.mjs`. The daimon repo no longer builds this image.

Runtime artifact images are copy sources for generated organization Dockerfiles.
They must contain pinned runtime dependencies only, under
`/opt/spawnfile/runtime-installs/<runtime>`. Do not include org source,
workspace files, auth, secrets, Moltnet credentials, or deployment state.

Each runtime image should be usable with Docker multi-stage `COPY --from=...`.
Prefer a `scratch` final stage when the artifact only needs to be copied into a
generated Spawnfile organization image.
