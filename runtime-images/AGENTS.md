# Runtime Images

This folder owns Dockerfiles for the runtimes Spawnfile packages itself:
`openclaw/`, `picoclaw/`, and `daimon/`. Their `noopolis/spawnfile-runtime-*`
images are built and pushed by `.github/workflows/runtime-images.yml` and pinned
in this repo's `runtimes.yaml`. `src/runtime/container.ts` `COPY --from`s these
images into generated organization Dockerfiles.

The `daimon/` image is a separately versioned generic engine runtime. It
contains published Daimon plus exact Codex, Grok, and AGY CLI installations,
and carries a capability receipt recording those executable identities. It
contains no organization config, workspace, credentials, Moltnet state, or
browser. Spawnfile selects the immutable image digest and receipt from
`runtimes.yaml`; it never constructs engine argv, installs CLIs, or stages
engine auth.

The image pipeline supplies pinned Grok/AGY release URLs plus SHA-256 values
and a canonical capability-receipt document. The resulting image is accepted
by Spawnfile only when its immutable image digest and the embedded receipt's
SHA-256 match `runtimes.yaml`; readiness/version probing happens inside
Daimon, never in Spawnfile.

Runtime artifact images are copy sources for generated organization Dockerfiles.
They must contain pinned runtime dependencies only, under
`/opt/spawnfile/runtime-installs/<runtime>`. Do not include org source,
workspace files, auth, secrets, Moltnet credentials, or deployment state.

Each runtime image should be usable with Docker multi-stage `COPY --from=...`.
Prefer a `scratch` final stage when the artifact only needs to be copied into a
generated Spawnfile organization image.
