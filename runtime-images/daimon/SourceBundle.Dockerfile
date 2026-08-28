# syntax=docker/dockerfile:1
ARG NODE_BASE_IMAGE=node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
FROM ${NODE_BASE_IMAGE} AS bundle_build
ARG TARGETARCH
ARG SOURCE_ARCHIVE_SHA256
ARG DEPENDENCY_ARCHIVE_SHA256
ARG SOURCE_MANIFEST_SHA256
ARG DEPENDENCY_MANIFEST_SHA256
COPY --from=source_bundle /source.tar /tmp/source.tar
COPY --from=dependency_bundle /dependencies.tar /tmp/dependencies.tar
RUN test "$(sha256sum /tmp/source.tar | awk '{print "sha256:" $1}')" = "${SOURCE_ARCHIVE_SHA256}" \
  && test "$(sha256sum /tmp/dependencies.tar | awk '{print "sha256:" $1}')" = "${DEPENDENCY_ARCHIVE_SHA256}" \
  && test -n "${SOURCE_MANIFEST_SHA256}" \
  && test -n "${DEPENDENCY_MANIFEST_SHA256}" \
  && mkdir -p /src /closure /out \
  && tar -xf /tmp/source.tar -C /src \
  && tar -xf /tmp/dependencies.tar -C /closure \
  && rm /src/.spawnfile-source-manifest.json \
  && rm /closure/.spawnfile-source-manifest.json \
  && cd /closure \
  && npm ci --offline --ignore-scripts --cache /closure/npm-cache \
  && npm ls --all \
  && cp -a /closure/node_modules /src/node_modules \
  && cd /src \
  && rm -rf dist \
  && node node_modules/typescript/bin/tsc --project tsconfig.build.json \
  && node --input-type=module -e 'import fs from "node:fs"; import crypto from "node:crypto"; import { RUNTIME_CONTRACT_MANIFEST as m } from "./dist/contracts/runtimeContractManifest.js"; const c=v=>Array.isArray(v)?"["+v.map(c).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+c(v[k])).join(",")+"}":JSON.stringify(v); const bytes=Buffer.from(c(m)+"\n"); fs.writeFileSync("dist/runtime/contract-manifest.json",bytes); fs.writeFileSync("dist/runtime/contract-manifest.sha256","sha256:"+crypto.createHash("sha256").update(bytes).digest("hex")+"\n")' \
  && node -e 'const expected={amd64:"x64",arm64:"arm64"}[process.argv[1]]; if (!expected || process.platform!=="linux" || process.arch!==expected) process.exit(1)' "${TARGETARCH}" \
  && DAIMON_REQUIRE_ENGINE_BROKER=1 node src/runtime/native/copyArtifact.mjs \
  && test -x dist/runtime/native/daimon-engine-broker \
  && node src/runtime/native/verifyArtifacts.mjs \
  && npm pack --ignore-scripts --offline --pack-destination /out \
  && package="$(find /out -maxdepth 1 -type f -name '*.tgz' -print)" \
  && test -n "${package}" \
  && test "$(find /out -maxdepth 1 -type f -name '*.tgz' | wc -l)" -eq 1 \
  && mv "${package}" /out/daimon.tgz \
  && cd /closure \
  && npm prune --omit=dev --offline --ignore-scripts --cache /closure/npm-cache \
  && npm ls --omit=dev --all \
  && tar --sort=name --mtime='UTC 1970-01-01' --owner=0 --group=0 --numeric-owner -cf /out/runtime-dependencies.tar -C /closure/node_modules . \
  && printf '{"dependencies":{"archive_sha256":"%s","manifest_sha256":"%s"},"source":{"archive_sha256":"%s","manifest_sha256":"%s"},"target":"linux/%s","version":"spawnfile.daimon-bundle-build.v1"}\n' "${DEPENDENCY_ARCHIVE_SHA256}" "${DEPENDENCY_MANIFEST_SHA256}" "${SOURCE_ARCHIVE_SHA256}" "${SOURCE_MANIFEST_SHA256}" "${TARGETARCH}" > /out/source-inputs.json

FROM scratch
COPY --from=bundle_build /out/daimon.tgz /daimon.tgz
COPY --from=bundle_build /out/source-inputs.json /source-inputs.json
COPY --from=bundle_build /out/runtime-dependencies.tar /runtime-dependencies.tar
