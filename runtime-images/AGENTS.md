# Runtime Images

This folder owns Dockerfiles for the **third-party** runtimes Spawnfile
packages itself: `openclaw/` and `picoclaw/`. Their `noopolis/spawnfile-runtime-*`
images are built and pushed by `.github/workflows/runtime-images.yml`.

**Daimon is intentionally not here.** Daimon is a first-party Noopolis runtime,
so its runtime image (`noopolis/spawnfile-runtime-daimon`) is built and
published from the daimon repo itself (`Dockerfile.runtime` +
`.github/workflows/runtime-image.yml` there), pinned in this repo's
`runtimes.yaml`. `src/runtime/container.ts`'s daimon recipe `COPY --from`s that
image, with an `@noopolis/daimon` + `@noopolis/mneme` npm-install fallback.

Runtime artifact images are copy sources for generated organization Dockerfiles.
They must contain pinned runtime dependencies only, under
`/opt/spawnfile/runtime-installs/<runtime>`. Do not include org source,
workspace files, auth, secrets, Moltnet credentials, or deployment state.

Each runtime image should be usable with Docker multi-stage `COPY --from=...`.
Prefer a `scratch` final stage when the artifact only needs to be copied into a
generated Spawnfile organization image.
