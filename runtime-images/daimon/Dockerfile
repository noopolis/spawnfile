# syntax=docker/dockerfile:1

ARG DAIMON_DEPENDENCY_MODE=registry
ARG NODE_BASE_IMAGE=node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
FROM daimon_package AS daimon_package

FROM ${NODE_BASE_IMAGE} AS offline_dependency_probe
ARG DAIMON_DEPENDENCY_ARCHIVE_SHA256
ARG DAIMON_PACKAGE_SHA256
COPY --from=daimon_package /daimon.tgz /tmp/daimon.tgz
COPY --from=daimon_package /dependencies.tar /tmp/dependencies.tar
COPY --from=daimon_package /source-inputs.json /tmp/source-inputs.json
RUN test "$(sha256sum /tmp/daimon.tgz | awk '{print "sha256:" $1}')" = "${DAIMON_PACKAGE_SHA256}" \
  && test "$(sha256sum /tmp/dependencies.tar | awk '{print "sha256:" $1}')" = "${DAIMON_DEPENDENCY_ARCHIVE_SHA256}" \
  && mkdir -p /probe/node_modules/@noopolis/daimon \
  && tar -xf /tmp/dependencies.tar -C /probe/node_modules \
  && tar -xzf /tmp/daimon.tgz -C /probe/node_modules/@noopolis/daimon --strip-components=1 \
  && test -x /probe/node_modules/@openai/codex/bin/codex.js \
  && test -f /probe/node_modules/@noopolis/daimon/dist/runtime/contract-manifest.json \
  && cp /tmp/source-inputs.json /probe/source-inputs.json

FROM ${NODE_BASE_IMAGE} AS base_offline-bundle

FROM ${NODE_BASE_IMAGE} AS base_registry
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

FROM base_${DAIMON_DEPENDENCY_MODE} AS base

FROM base AS grok_source_registry
ARG GROK_CLI_URL
RUN curl -fsSL "${GROK_CLI_URL}" -o /tmp/grok

FROM base AS grok_source_offline-bundle
COPY --from=daimon_package /grok /tmp/grok

FROM grok_source_${DAIMON_DEPENDENCY_MODE} AS grok_cli
ARG GROK_CLI_SHA256
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon
RUN echo "${GROK_CLI_SHA256}  /tmp/grok" | sha256sum -c - \
  && mkdir -p ${RUNTIME_ROOT}/bin \
  && install -m 0755 /tmp/grok ${RUNTIME_ROOT}/bin/grok \
  && test "$(sha256sum ${RUNTIME_ROOT}/bin/grok | awk '{print "sha256:" $1}')" = "sha256:${GROK_CLI_SHA256#sha256:}" \
  && rm -f /tmp/grok

FROM grok_cli AS agy_source_registry
ARG AGY_CLI_URL
RUN curl -fsSL "${AGY_CLI_URL}" -o /tmp/agy.tar.gz

FROM grok_cli AS agy_source_offline-bundle
COPY --from=daimon_package /agy.tar.gz /tmp/agy.tar.gz

FROM agy_source_${DAIMON_DEPENDENCY_MODE} AS agy_cli
ARG AGY_CLI_SHA512
ARG AGY_CLI_SHA256
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon
RUN echo "${AGY_CLI_SHA512}  /tmp/agy.tar.gz" | sha512sum -c - \
  && rm -rf /tmp/agy-extract \
  && mkdir -p /tmp/agy-extract \
  && tar -xzf /tmp/agy.tar.gz -C /tmp/agy-extract \
  && agy_path="$(find /tmp/agy-extract -type f -name antigravity -print -quit)" \
  && test -n "${agy_path}" \
  && install -m 0755 "${agy_path}" ${RUNTIME_ROOT}/bin/agy \
  && test "$(sha256sum ${RUNTIME_ROOT}/bin/agy | awk '{print "sha256:" $1}')" = "sha256:${AGY_CLI_SHA256#sha256:}" \
  && rm -rf /tmp/agy.tar.gz /tmp/agy-extract

FROM agy_cli AS codex_registry
ARG CODEX_CLI_VERSION=0.162.1
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  cd ${RUNTIME_ROOT} \
  && npm install --omit=dev --no-fund --no-audit @openai/codex@${CODEX_CLI_VERSION}

FROM agy_cli AS codex_offline-bundle
ARG DAIMON_DEPENDENCY_ARCHIVE_SHA256=none
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon
COPY --from=daimon_package /dependencies.tar /tmp/dependencies.tar
RUN test "$(sha256sum /tmp/dependencies.tar | awk '{print "sha256:" $1}')" = "${DAIMON_DEPENDENCY_ARCHIVE_SHA256}" \
  && mkdir -p ${RUNTIME_ROOT}/node_modules \
  && tar -xf /tmp/dependencies.tar -C ${RUNTIME_ROOT}/node_modules \
  && test -x ${RUNTIME_ROOT}/node_modules/@openai/codex/bin/codex.js \
  && rm -f /tmp/dependencies.tar

FROM codex_registry AS daimon_registry
ARG DAIMON_PACKAGE_SHA256
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon
COPY --from=daimon_package /daimon.tgz /tmp/daimon.tgz
COPY --from=daimon_package /source-inputs.json /tmp/source-inputs.json
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
  test "$(sha256sum /tmp/daimon.tgz | awk '{print "sha256:" $1}')" = "${DAIMON_PACKAGE_SHA256}" \
  && cd ${RUNTIME_ROOT} \
  && npm install --omit=dev --no-fund --no-audit /tmp/daimon.tgz \
  && rm -f /tmp/daimon.tgz

FROM codex_offline-bundle AS daimon_offline-bundle
ARG DAIMON_PACKAGE_SHA256
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon
COPY --from=daimon_package /daimon.tgz /tmp/daimon.tgz
COPY --from=daimon_package /source-inputs.json /tmp/source-inputs.json
RUN test "$(sha256sum /tmp/daimon.tgz | awk '{print "sha256:" $1}')" = "${DAIMON_PACKAGE_SHA256}" \
  && mkdir -p ${RUNTIME_ROOT}/node_modules/@noopolis/daimon \
  && tar -xzf /tmp/daimon.tgz -C ${RUNTIME_ROOT}/node_modules/@noopolis/daimon --strip-components=1 \
  && rm -f /tmp/daimon.tgz

FROM daimon_${DAIMON_DEPENDENCY_MODE} AS build

ARG GROK_CLI_VERSION
ARG GROK_CLI_URL
ARG GROK_CLI_SHA256
ARG AGY_CLI_VERSION
ARG AGY_CLI_URL
ARG AGY_CLI_SHA512
ARG AGY_CLI_SHA256
ARG DAIMON_CAPABILITY_RECEIPT_BASE64
ARG DAIMON_MANIFEST_SHA256
ARG DAIMON_PACKAGE_SHA256
ARG DAIMON_SOURCE_SHA256
ARG DAIMON_DEPENDENCY_MODE=registry
ARG DAIMON_DEPENDENCY_ARCHIVE_SHA256=none
ARG CODEX_CLI_SHA256
ARG TARGETARCH
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon

RUN echo "Verifying: required input GROK_CLI_VERSION" \
  && test -n "${GROK_CLI_VERSION}" \
  && echo "Verifying: required input GROK_CLI_URL" \
  && test -n "${GROK_CLI_URL}" \
  && echo "Verifying: required input GROK_CLI_SHA256" \
  && test -n "${GROK_CLI_SHA256}" \
  && echo "Verifying: required input AGY_CLI_VERSION" \
  && test -n "${AGY_CLI_VERSION}" \
  && echo "Verifying: required input AGY_CLI_URL" \
  && test -n "${AGY_CLI_URL}" \
  && echo "Verifying: required input AGY_CLI_SHA512" \
  && test -n "${AGY_CLI_SHA512}" \
  && echo "Verifying: required input AGY_CLI_SHA256" \
  && test -n "${AGY_CLI_SHA256}" \
  && echo "Verifying: required input DAIMON_CAPABILITY_RECEIPT_BASE64" \
  && test -n "${DAIMON_CAPABILITY_RECEIPT_BASE64}" \
  && echo "Verifying: required input DAIMON_MANIFEST_SHA256" \
  && test -n "${DAIMON_MANIFEST_SHA256}" \
  && echo "Verifying: required input DAIMON_PACKAGE_SHA256" \
  && test -n "${DAIMON_PACKAGE_SHA256}" \
  && echo "Verifying: required input DAIMON_SOURCE_SHA256" \
  && test -n "${DAIMON_SOURCE_SHA256}" \
  && echo "Verifying: supported dependency mode" \
  && { test "${DAIMON_DEPENDENCY_MODE}" = registry || test "${DAIMON_DEPENDENCY_MODE}" = offline-bundle; } \
  && echo "Verifying: required input CODEX_CLI_SHA256" \
  && test -n "${CODEX_CLI_SHA256}" \
  && echo "Verifying: required input TARGETARCH" \
  && test -n "${TARGETARCH}" \
  && echo "Verifying: Codex launcher exists and is executable" \
  && test -x ${RUNTIME_ROOT}/node_modules/@openai/codex/bin/codex.js \
  && echo "Verifying: Daimon runtime entrypoint exists" \
  && test -f ${RUNTIME_ROOT}/node_modules/@noopolis/daimon/dist/runtime/cli.js \
  && echo "Verifying: engine-broker target architecture" \
  && case "${TARGETARCH}" in \
       amd64) broker_arch=x64 ;; \
       arm64) broker_arch=arm64 ;; \
       *) echo "Unsupported Daimon engine-broker architecture: ${TARGETARCH}" >&2; exit 1 ;; \
     esac \
  && package_manifest=${RUNTIME_ROOT}/node_modules/@noopolis/daimon/dist/runtime/contract-manifest.json \
  && echo "Verifying: package contract manifest SHA-256" \
  && test "$(sha256sum "${package_manifest}" | awk '{print "sha256:" $1}')" = "${DAIMON_MANIFEST_SHA256}" \
  && echo "Verifying: engine-broker manifest SHA-256 pin" \
  && broker_sha="$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).grokEngineBroker; const v=m?.artifacts?.[process.argv[2]+"Sha256"]; if(typeof v!=="string"||!/^[a-f0-9]{64}$/.test(v))process.exit(1); process.stdout.write(v)' "${package_manifest}" "${broker_arch}")" \
  && echo "Verifying: Grok CLI pins match the contract manifest" \
  && node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).grokEngineBroker, a=m?.grokCliArtifacts?.[process.argv[2]]; if(!a||m.grokCliVersion!==process.argv[3]||a.url!==process.argv[4]||a.sha256!==process.argv[5].replace(/^sha256:/,"")){console.error("Grok CLI pin does not match the Daimon contract manifest ("+(m?.grokCliVersion)+")");process.exit(1)}' "${package_manifest}" "${broker_arch}" "${GROK_CLI_VERSION}" "${GROK_CLI_URL}" "${GROK_CLI_SHA256}" \
  && broker_source=${RUNTIME_ROOT}/node_modules/@noopolis/daimon/dist/runtime/native/daimon-engine-broker \
  && echo "Verifying: packaged engine broker exists and is executable" \
  && test -x "${broker_source}" \
  && echo "Verifying: packaged engine-broker SHA-256" \
  && test "$(sha256sum "${broker_source}" | awk '{print $1}')" = "${broker_sha}" \
  && install -m 0555 "${broker_source}" ${RUNTIME_ROOT}/bin/daimon-engine-broker \
  && printf '%s\n' '#!/usr/bin/env node' 'import "../node_modules/@openai/codex/bin/codex.js";' > ${RUNTIME_ROOT}/bin/codex \
  && printf '%s\n' '#!/usr/bin/env node' 'import { runOrganizationRuntimeCli } from "../node_modules/@noopolis/daimon/dist/runtime/cli.js";' 'try { await runOrganizationRuntimeCli(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "daimon-runtime failed"}\\n`); process.exitCode = 1; }' > ${RUNTIME_ROOT}/bin/daimon-runtime \
  && chmod 0755 ${RUNTIME_ROOT}/bin/codex ${RUNTIME_ROOT}/bin/daimon-runtime \
  && cp ${RUNTIME_ROOT}/node_modules/@noopolis/daimon/dist/runtime/contract-manifest.json ${RUNTIME_ROOT}/contract-manifest.json \
  && cp ${RUNTIME_ROOT}/node_modules/@noopolis/daimon/dist/runtime/contract-manifest.sha256 ${RUNTIME_ROOT}/contract-manifest.sha256 \
  && cp /tmp/source-inputs.json ${RUNTIME_ROOT}/source-inputs.json \
  && printf '%s' "${DAIMON_CAPABILITY_RECEIPT_BASE64}" | base64 -d > ${RUNTIME_ROOT}/capability-receipt.json \
  && expected_manifest="$(cat ${RUNTIME_ROOT}/contract-manifest.sha256)" \
  && echo "Verifying: contract digest file matches the manifest pin" \
  && test "${expected_manifest}" = "${DAIMON_MANIFEST_SHA256}" \
  && echo "Verifying: installed contract manifest SHA-256" \
  && test "$(sha256sum ${RUNTIME_ROOT}/contract-manifest.json | awk '{print "sha256:" $1}')" = "${expected_manifest}" \
  && echo "Verifying: canonical contract manifest v5/v6 and supported semantics" \
  && node -e 'const fs=require("fs"); const raw=fs.readFileSync(process.argv[1],"utf8"); const c=v=>Array.isArray(v)?"["+v.map(c).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+c(v[k])).join(",")+"}":JSON.stringify(v); const m=JSON.parse(raw),v7=m.version==="noopolis.daimon.runtime-contract-manifest.v7",v6=v7||m.version==="noopolis.daimon.runtime-contract-manifest.v6",s=v6?Object.keys(m.engines||{}).sort():["agy","codex","grok"],w=["manual","message","schedule","external"],e=v6?Object.fromEntries(Object.values(m.engines||{}).filter(e=>e.auth?.staging==="portable-file"||e.auth?.staging==="portable-realm").map(e=>[e.id,e.credentialMaterial])):{codex:{sourceSlot:"codex-auth",sourceRelativePath:".daimon-inbound/codex-auth",destinationRelativePath:".codex/auth.json",directoryMode:448,fileMode:384}},a=m.agySubscriptionRealm,g=m.grokSubscriptionRealm,d=m.deliverySemantics; if(raw!==c(m)+"\n"||(!v6&&m.version!=="noopolis.daimon.runtime-contract-manifest.v5")||!s.length||(v6&&(s.some(k=>m.engines[k]?.id!==k)||!Object.values(m.engines).some(e=>c(e.broker)===c(m.grokEngineBroker))))||m.organizationRuntimeConfigV2Schema?.$id!=="noopolis.daimon.organization-runtime.v2"||JSON.stringify(m.supportedEngineKinds)!==JSON.stringify(s)||JSON.stringify(m.wakeAcceptanceTypes)!==JSON.stringify(w)||d?.terminalReceiptHorizon!==2048||d?.recovery!=="at-least-once-with-stable-wake-id"||d?.externalEffectsExactlyOnce!==false||!m.engineCredentialMaterial||Object.keys(m.engineCredentialMaterial).length!==Object.keys(e).length||Object.entries(e).some(([k,v])=>!v||v.directoryMode!==448||v.fileMode!==384||c(m.engineCredentialMaterial[k])!==c(v))||(v7&&(!m.codexSubscriptionRealm||m.codexSubscriptionRealm.durableMountPath!=="/var/lib/spawnfile/daimon/codex-subscription-realm"||m.codexSubscriptionRealm.bootstrapMountPath!=="/var/lib/spawnfile/daimon/codex-bootstrap-auth"||m.codexSubscriptionRealm.bootstrapSourceSlot!=="codex-auth"||m.codexSubscriptionRealm.agentCredentialRelativePath!==".codex/auth.json"||m.codexSubscriptionRealm.directoryMode!==448||m.codexSubscriptionRealm.fileMode!==384||m.codexSubscriptionRealm.maxCredentialBytes!==65536||c(m.engines.codex?.auth.realm)!==c(m.codexSubscriptionRealm)))||!a||a.durableMountPath!=="/var/lib/spawnfile/daimon/agy-subscription-realm"||a.unlockMountPath!=="/var/lib/spawnfile/daimon/agy-unlock-secret"||a.unlockSourceSlot!=="agy-unlock-secret"||a.directoryMode!==448||a.fileMode!==384||a.maxUnlockBytes!==4096||!g||g.durableMountPath!=="/var/lib/spawnfile/daimon/grok-subscription-realm"||g.bootstrapMountPath!=="/var/lib/spawnfile/daimon/grok-bootstrap-auth"||g.bootstrapSourceSlot!=="grok-auth"||g.agentCredentialRelativePath!==".grok/auth.json"||g.directoryMode!==448||g.fileMode!==384||g.maxCredentialBytes!==65536)process.exit(1)' ${RUNTIME_ROOT}/contract-manifest.json \
  && echo "Verifying: capability receipt matches build inputs" \
  && node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1])); const x={codex:process.argv[5],grok:process.argv[6],agy:process.argv[7]},a=r.provenance?.agy?.archive,g=r.provenance?.grok?.executable,z=process.argv[14],i=JSON.parse(fs.readFileSync(process.argv[15],"utf8")); if(r.version!=="spawnfile.daimon-runtime-capability-receipt.v1"||r.architecture!==process.argv[2]||r.manifest_sha256!==process.argv[3]||r.daimon?.package_sha256!==process.argv[4]||r.daimon?.source_sha256!==process.argv[8]||Object.entries(x).some(([k,v])=>r.engines?.[k]?.executable_sha256!==v)||a?.format!=="tar.gz"||a?.version!==process.argv[9]||a?.url!==process.argv[10]||a?.sha512!==process.argv[11]||g?.version!==process.argv[12]||g?.url!==process.argv[13]||g?.sha256!==x.grok||(z!=="none"&&(r.daimon?.source_inputs?.dependencies?.runtime_archive_sha256!==z||JSON.stringify(i)!==JSON.stringify(r.daimon.source_inputs))))process.exit(1)' ${RUNTIME_ROOT}/capability-receipt.json "${TARGETARCH}" "${expected_manifest}" "${DAIMON_PACKAGE_SHA256}" "${CODEX_CLI_SHA256}" "sha256:${GROK_CLI_SHA256#sha256:}" "sha256:${AGY_CLI_SHA256#sha256:}" "${DAIMON_SOURCE_SHA256}" "${AGY_CLI_VERSION}" "${AGY_CLI_URL}" "sha512:${AGY_CLI_SHA512#sha512:}" "${GROK_CLI_VERSION}" "${GROK_CLI_URL}" "${DAIMON_DEPENDENCY_ARCHIVE_SHA256}" /tmp/source-inputs.json \
  && echo "Verifying: installed Codex CLI SHA-256" \
  && test "$(sha256sum ${RUNTIME_ROOT}/node_modules/@openai/codex/bin/codex.js | awk '{print "sha256:" $1}')" = "${CODEX_CLI_SHA256}" \
  && echo "Verifying: installed Grok CLI SHA-256" \
  && test "$(sha256sum ${RUNTIME_ROOT}/bin/grok | awk '{print "sha256:" $1}')" = "sha256:${GROK_CLI_SHA256#sha256:}" \
  && echo "Verifying: installed engine-broker SHA-256" \
  && test "$(sha256sum ${RUNTIME_ROOT}/bin/daimon-engine-broker | awk '{print $1}')" = "${broker_sha}" \
  && echo "Verifying: installed AGY CLI SHA-256" \
  && test "$(sha256sum ${RUNTIME_ROOT}/bin/agy | awk '{print "sha256:" $1}')" = "sha256:${AGY_CLI_SHA256#sha256:}" \
  && echo "Verifying: runtime symlink containment" \
  && node -e 'const fs=require("fs"),path=require("path"),root=path.resolve(process.argv[1]);let count=0;const walk=d=>{for(const n of fs.readdirSync(d)){const p=path.join(d,n),s=fs.lstatSync(p);if(s.isDirectory())walk(p);else if(s.isSymbolicLink()){if(++count>4096)throw Error("too many runtime links");const l=fs.readlinkSync(p);if(path.isAbsolute(l))throw Error("absolute runtime link");const r=fs.realpathSync(p);if(!r.startsWith(root+path.sep))throw Error("runtime link escape");const t=fs.statSync(p);if(!t.isFile()||t.dev!==fs.statSync(root).dev)throw Error("unsafe runtime link target");}}};walk(root)' ${RUNTIME_ROOT} \
  && echo "Verifying: installed Daimon package manifest exists" \
  && test -f ${RUNTIME_ROOT}/node_modules/@noopolis/daimon/package.json

FROM scratch
COPY --from=build /opt/spawnfile/runtime-installs/daimon /opt/spawnfile/runtime-installs/daimon
