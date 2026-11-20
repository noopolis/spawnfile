# Daimon runtime image

This directory owns the Docker recipes and native build scripts for the generic Daimon runtime image.

- `Dockerfile` consumes the named `daimon_package` context and verifies the capability receipt, exact executable pins, and broker.
- `SourceBundle.Dockerfile` builds an offline Daimon package from attested source and dependency archives.
- `build.json` registers the adapter's source-only local builder and publisher with the repository image catalog.
- `buildLocalRuntime.ts` creates the loopback-only development identity from a packaged checkout or offline bundle.
- `publishRuntime.ts` and `publishInputs.ts` pin the release package, tool bytes, per-platform immutable image digests, and final index identity.

- `generateEngineDescriptors.ts` reads static Git objects at the exact Daimon pin. Its `--check` mode verifies the JSON, digest, and TypeScript mirror. It never runs the checkout's descriptor code.
- `vendorGrokContract.ts` calls Daimon's checked-out contract and renderer functions to vendor exact manifest and worker bytes. Run the wrapper with `node --import tsx`; `--check` reports drift without rewriting. Update the compiler manifest pin with these artifacts. Preserve the published image and receipt pins until publication provides a matching identity.
- `grokLeanWorkerLiveCheck.ts` is the dedicated opt-in Docker and provider probe. The regular script suite tests its admission checks without running the probe.

Keep immutable publication checks and the clean-git and offline source authorities intact. The GitHub workflow owns publish policy and credentials. These repository tools are typechecked by the scripts project and are never imported by the compiler.
