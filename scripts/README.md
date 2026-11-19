# Repository scripts

These are maintained build, verification, and explicit development tools.
The compiler and installed CLI live in `src/`; this directory is not shipped
in the npm package. Scripts run as native TypeScript on Node 22.19+.

| Entrypoint | Caller | Purpose / prerequisites |
| --- | --- | --- |
| `build-local-daimon-runtime.ts` | `npm run build:local-daimon` | Build a locally sourced runtime; explicit artifact pins, Docker, and loopback registry required |
| `publish-daimon-runtime.ts` | Local CLI wrapper for the same publisher used by CI | Build the published multi-arch Daimon image from the pinned commit and CLI digests in `src/runtime/daimon/image/publish-inputs.json`; dry-run without `--push`, otherwise push by digest, tag `<version>-<short commit>` (never moved), and print the identity and `runtimes.yaml` pin. Docker Buildx (docker-container driver) required |
| `build-runtime-images.ts` | `npm run runtime:images` | Build repository images from each adapter's `image/build.json`. Pass an adapter name to select one image |
| `vendor-daimon-grok-contract.ts` | `npm run vendor:daimon-contract [-- --check]` | Vendor Daimon's contract manifest and Grok worker renderer bytes from a Daimon checkout (`SPAWNFILE_DAIMON_SOURCE_DIR`) |
| `generate-daimon-engine-descriptors.ts` | `npm run vendor:daimon-engine-descriptors [-- --check]`, CI | Read the exact `runtimes.yaml` Daimon Git commit via `SPAWNFILE_DAIMON_SOURCE_DIR`; interpret only static descriptor data, generate JSON + SHA-256 + typed data mirror, and reject drift with `--check`. Does not execute upstream modules or read working-tree bytes |
| `grok-lean-worker-live-check.ts` | `SPAWNFILE_GROK_LIVE_CHECK=1 npm run test:live:grok-lean-worker` | Opt-in live check: one brokered Grok 1.0.34 agent, worker-home/deny/service attestation dump, one cheap wake, one deduped broker usage row; Docker, a local Daimon identity, and a dedicated Grok login required |
| `build-local-moltnet.ts` | `npm run build:local-moltnet` | Build and stamp release binaries from an explicit source checkout |
| `create-source-provenance-bundle.ts` | `npm run bundle:source-provenance` | Create deterministic archives with manifests and credential exclusions |
| `create-linux-amd64-dependency-closure.ts` | `npm run prepare:linux-amd64-closure` | Prepare reviewed npm dependencies/cache in the pinned build container |
| `create-linux-amd64-go-closure.ts` | `npm run prepare:linux-amd64-go-closure` | Prepare the pinned Go module-cache closure |
| `compile-explicit-test-mcp.ts` | `npm run compile:explicit-test-mcp` | Lower bounded test MCP declarations against a compiled report; build the CLI first |
| `verify-package-closure.ts` | `npm run verify:package-closure` | Verify the packed CLI and runtime closure. Set `SPAWNFILE_VERIFY_ACP_RELEASE_DIR` to also exercise the external ACP adapter in local Docker |
| `verify-external-adapter.ts` | Packed CLI closure check | Install an out-of-tree adapter and compile an agent through the public CLI |
| `training-public-exports.test.ts` | `npm run test:scripts`, CI | Pack and install the production package; verify integration values, declarations and a missing-export mutation |
| `test-training-python.ts` | `npm run test:training-python`, CI | Run the real DSPy bridge pytest suite and enforce 90% lines and branches for every module and the total; install `src/training/dspy/requirements.lock` and the editable bridge in `src/training/dspy/.venv` first |
| `product-state-volume-integration.test.ts` | `npm run test:product-state-volume`, CI | Test real volume preseed; Docker and host volume access required |
| `source-provenance-bundle.integration.test.ts` | `npm run test:source-provenance-docker` | PR/main and publish workflows: real offline Daimon archive build and tamper rejection; Docker, Daimon checkout (`SPAWNFILE_TEST_DAIMON_SOURCE`), pinned Linux Grok CLI (`SPAWNFILE_GROK_CLI_FILE`) |
| `moltnet-source-provenance.integration.test.ts` | `npm run test:moltnet-source-provenance-docker` | Test the real offline Moltnet archive build |

Daimon-native tooling and its script tests live in `src/runtime/daimon/image/`.
The command names above remain available through wrappers in this directory.
`source-provenance-bundle.ts` and `native-helper-artifacts.ts` are shared modules. Daimon publish-input validation and identity shaping live beside the publisher in `src/runtime/daimon/image/publishInputs.ts`.
Adjacent unit tests run through `npm run test:scripts`; native artifact and
syscall integration tests also run explicitly in CI.

`npm run typecheck` checks every maintained script with strict TypeScript.
`npm test` includes script unit tests. Docker integration tests have separate
commands so unit runs never launch deployments or consume provider tokens.

The root registries are production package inputs:
[`runtimes.yaml`](../runtimes.yaml) pins runtime versions/images and
[`moltnet-releases.json`](../moltnet-releases.json) pins architecture-specific
Moltnet release assets and checksums. Their loaders and npm packaging expect
them at the package root.

Retired worktree/burnlist tooling is preserved in the [archive](../archive/).
