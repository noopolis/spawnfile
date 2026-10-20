# Runtime Images

This folder owns Dockerfiles for the runtimes Spawnfile packages itself:
`openclaw/`, `picoclaw/`, and `daimon/`. Their `noopolis/spawnfile-runtime-*`
images are built and pushed by `.github/workflows/runtime-images.yml` and pinned
in this repo's `runtimes.yaml`. `src/runtime/container.ts` `COPY --from`s these
images into generated organization Dockerfiles.

The `daimon/` image is a separately versioned generic engine runtime. It
contains published Daimon plus exact Codex, Grok, and AGY CLI installations,
and carries a capability receipt recording those executable identities. It
also packages Daimon's architecture-specific native engine broker at its exact
source and executable digests; generated images copy it to the fixed root
launcher path before creating any organization registrations.
contains no organization config, workspace, credentials, Moltnet state, or
browser. Spawnfile selects the immutable image digest and receipt from
`runtimes.yaml`; it never constructs engine argv, installs CLIs, or stages
engine auth.

The image pipeline supplies pinned Grok version/URL/executable SHA-256 and AGY
version/URL/archive SHA-512/extracted-executable SHA-256 values plus a canonical
capability-receipt document. AGY's official tar.gz is verified before extraction
and only its `antigravity` executable is installed as `agy`. The resulting image
is accepted only when its immutable image manifest digest and embedded receipt
SHA-256 match either `runtimes.yaml` or the explicit local-development identity.
Readiness/version probing happens inside Daimon, never in Spawnfile.

Runtime artifact images are copy sources for generated organization Dockerfiles.
They must contain pinned runtime dependencies only, under
`/opt/spawnfile/runtime-installs/<runtime>`. Do not include org source,
workspace files, auth, secrets, Moltnet credentials, or deployment state.

Each runtime image should be usable with Docker multi-stage `COPY --from=...`.
Prefer a `scratch` final stage when the artifact only needs to be copied into a
generated Spawnfile organization image.

`training-native/` owns the runnable training parent template. Its publisher
reads the Daimon image digest and architecture receipts from `runtimes.yaml`
and Moltnet release assets/checksums from `moltnet-releases.json`. The Node 24
Bookworm base is digest-pinned. CI builds amd64+arm64 on PRs; only version tags
or explicit dispatch push publish `noopolis/spawnfile-training-native` under
`<daimon-tag>-moltnet-<release>-r<recipe sha>`; an existing tag means identical bytes, so republishing reports it and never moves it. Pin the printed/uploaded
`image_reference` digest in a training declaration's `image.build.nativeImage`.
