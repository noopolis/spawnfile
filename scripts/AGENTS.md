# Scripts Guide

Maintained repository tooling lives here. [README.md](README.md) records each
entrypoint, its callers, and prerequisites. Historical worktree and burnlist
tools live in `../archive/legacy-worktree-tools/` and are not active helpers.

## Rules

- Write TypeScript with named exports, strict types, and erasable syntax. Keep
  each source file below 400 lines. Do not bypass checking with broad `any` or
  `@ts-nocheck`.
- Run source scripts with Node 22.19+ and `--experimental-strip-types`.
  `npm run typecheck` checks `scripts/tsconfig.json` and product source.
- Use Node builtins and local modules. Runtime JavaScript generated for a
  container remains an output artifact, not another script implementation.
- Keep tests next to their source. Add ordinary tests to `test:scripts`;
  real Docker or provider operations must remain explicit opt-in commands.
- Every entrypoint needs a documented caller and purpose. One-off audit dumps
  and task-specific automation do not belong here.
- Scripts must not read, print, or embed provider credential contents.

## Local runtime builds

- Daimon builds accept only explicit versions, credential-free HTTPS URLs, and
  executable/archive digest pins. Reject URLs with credentials, queries, or
  fragments before Docker runs.
- Daimon builds also accept only the Grok CLI build the vendored Daimon
  contract manifest pins for the target architecture (`readPinnedGrokCli`).
- `vendor-daimon-grok-contract.ts` (run with `node --import tsx`) reads a
  Daimon checkout as data and
  writes `src/runtime/daimon/contract-manifest.{json,sha256}` plus
  `grokWorkerConfigBytes.ts` (Daimon's unclocked and clocked worker `config.toml` renderer bytes
  and sandbox-profile samples). `--check` fails on drift. It never builds or
  writes inside Daimon.
  Update `DAIMON_CONTRACT_MANIFEST_SHA256` and the manifest version to match.
  Preserve published registry digests/receipts until a real publication exists;
  install and production-compile tests must express any required re-pin, never
  relabel an old image as attesting the new manifest.
- `generate-daimon-engine-descriptors.ts` reads static Git objects at the exact
  Daimon commit in the registry. It generates the v5 descriptor fallback's JSON,
  digest and typed data; `--check` verifies all three against the pinned checkout
  in CI. Never edit generated engine or broker facts by hand.
- The local builder pushes only to the fixed loopback development repository.
  Its generated immutable manifest/receipt identity is ignored and never
  edits `runtimes.yaml`. Clean-source builds select the native Docker
  architecture unless an explicit supported architecture is supplied.
- `publish-daimon-runtime.ts` is the CI publication path. It reads only the
  checked-in `runtime-images/daimon/publish-inputs.json` (full Daimon commit,
  per-architecture AGY pins, Codex pin; Grok comes from the vendored manifest),
  refuses a packed manifest that differs from the vendored contract, and never
  moves an existing tag. Its receipts carry `mode: "ci-published"` provenance.
  Re-vendoring the contract manifest must bump `daimon.commit` to the vendored
  Daimon commit in the same change; the `runtime-images` PR dry run fails
  otherwise.
  The published identity is pinned into `runtimes.yaml` by a reviewed PR, never
  written by the script.
- Clean Git remains the default source mode. Explicit Daimon archive mode
  requires `SPAWNFILE_DAIMON_SOURCE_BUNDLE` and
  `SPAWNFILE_DAIMON_DEPENDENCY_BUNDLE`. Strict deterministic USTAR archives bind
  source, lockfile, package archives, and npm cache. Dependency preparation is
  pinned to `linux/amd64`; Docker verifies those bytes and installs offline.
- Moltnet archive mode requires source and Go dependency provenance archives.
  Its pinned Go build verifies the graph and runs with `GOPROXY=off` and
  Docker `--network=none`.
- Run the relevant network-disabled Docker provenance gate when changing
  archive content, Docker staging, dependency installation, or builder behavior.

- `publish-training-native.ts` renders `runtime-images/training-native/Dockerfile`
  via `training-native-image.ts`, reusing `src/runtime/daimonInstall.ts`. Run
  with `node --import tsx` after installing dependencies. Only root registry
  pins are accepted; both architectures are required, publication is serialized
  across refs, and existing tags always refuse (no force/latest).
