# syntax=docker/dockerfile:1

FROM daimon_package AS daimon_package

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS build

ARG CODEX_CLI_VERSION=0.142.3
ARG GROK_CLI_URL
ARG GROK_CLI_SHA256
ARG AGY_CLI_URL
ARG AGY_CLI_SHA256
ARG DAIMON_CAPABILITY_RECEIPT_BASE64
ARG DAIMON_MANIFEST_SHA256
ARG DAIMON_PACKAGE_SHA256
ARG DAIMON_SOURCE_SHA256
ARG CODEX_CLI_SHA256
ARG TARGETARCH
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon

COPY --from=daimon_package /daimon.tgz /tmp/daimon.tgz

RUN test -n "${GROK_CLI_URL}" \
  && test -n "${GROK_CLI_SHA256}" \
  && test -n "${AGY_CLI_URL}" \
  && test -n "${AGY_CLI_SHA256}" \
  && test -n "${DAIMON_CAPABILITY_RECEIPT_BASE64}" \
  && test -n "${DAIMON_MANIFEST_SHA256}" \
  && test -n "${DAIMON_PACKAGE_SHA256}" \
  && test -n "${DAIMON_SOURCE_SHA256}" \
  && test -n "${CODEX_CLI_SHA256}" \
  && test -n "${TARGETARCH}" \
  && test "$(sha256sum /tmp/daimon.tgz | awk '{print "sha256:" $1}')" = "${DAIMON_PACKAGE_SHA256}" \
  && apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p ${RUNTIME_ROOT}/bin \
  && cd ${RUNTIME_ROOT} \
  && npm install --omit=dev --no-fund --no-audit /tmp/daimon.tgz @openai/codex@${CODEX_CLI_VERSION} \
  && curl -fsSL "${GROK_CLI_URL}" -o /tmp/grok \
  && echo "${GROK_CLI_SHA256}  /tmp/grok" | sha256sum -c - \
  && install -m 0755 /tmp/grok ${RUNTIME_ROOT}/bin/grok \
  && curl -fsSL "${AGY_CLI_URL}" -o /tmp/agy \
  && echo "${AGY_CLI_SHA256}  /tmp/agy" | sha256sum -c - \
  && install -m 0755 /tmp/agy ${RUNTIME_ROOT}/bin/agy \
  && ln -s ../node_modules/.bin/codex ${RUNTIME_ROOT}/bin/codex \
  && ln -s ../node_modules/.bin/daimon-runtime ${RUNTIME_ROOT}/bin/daimon-runtime \
  && cp ${RUNTIME_ROOT}/node_modules/@noopolis/daimon/dist/runtime/contract-manifest.json ${RUNTIME_ROOT}/contract-manifest.json \
  && cp ${RUNTIME_ROOT}/node_modules/@noopolis/daimon/dist/runtime/contract-manifest.sha256 ${RUNTIME_ROOT}/contract-manifest.sha256 \
  && printf '%s' "${DAIMON_CAPABILITY_RECEIPT_BASE64}" | base64 -d > ${RUNTIME_ROOT}/capability-receipt.json \
  && expected_manifest="$(cat ${RUNTIME_ROOT}/contract-manifest.sha256)" \
  && test "${expected_manifest}" = "${DAIMON_MANIFEST_SHA256}" \
  && test "$(sha256sum ${RUNTIME_ROOT}/contract-manifest.json | awk '{print "sha256:" $1}')" = "${expected_manifest}" \
  && node -e 'const fs=require("fs"); const raw=fs.readFileSync(process.argv[1],"utf8"); const c=v=>Array.isArray(v)?"["+v.map(c).join(",")+"]":v&&typeof v==="object"?"{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+c(v[k])).join(",")+"}":JSON.stringify(v); const m=JSON.parse(raw),e={agy:["agy-auth",".daimon-inbound/agy-auth",".antigravity-cli/antigravity-oauth-token"],codex:["codex-auth",".daimon-inbound/codex-auth",".codex/auth.json"],grok:["grok-auth",".daimon-inbound/grok-auth",".grok/auth.json"]}; if(raw!==c(m)+"\n"||m.version!=="noopolis.daimon.runtime-contract-manifest.v1"||JSON.stringify(m.supportedEngineKinds)!==JSON.stringify(Object.keys(e))||!m.engineCredentialMaterial||Object.entries(e).some(([k,[s,i,d]])=>{const x=m.engineCredentialMaterial[k];return !x||x.sourceSlot!==s||x.sourceRelativePath!==i||x.destinationRelativePath!==d||x.directoryMode!==448||x.fileMode!==384;}))process.exit(1)' ${RUNTIME_ROOT}/contract-manifest.json \
  && node -e 'const fs=require("fs"); const r=JSON.parse(fs.readFileSync(process.argv[1])); const x={codex:process.argv[5],grok:process.argv[6],agy:process.argv[7]}; if(r.version!=="spawnfile.daimon-runtime-capability-receipt.v1"||r.architecture!==process.argv[2]||r.manifest_sha256!==process.argv[3]||r.daimon?.package_sha256!==process.argv[4]||r.daimon?.source_sha256!==process.argv[8]||Object.entries(x).some(([k,v])=>r.engines?.[k]?.executable_sha256!==v))process.exit(1)' ${RUNTIME_ROOT}/capability-receipt.json "${TARGETARCH}" "${expected_manifest}" "${DAIMON_PACKAGE_SHA256}" "${CODEX_CLI_SHA256}" "sha256:${GROK_CLI_SHA256#sha256:}" "sha256:${AGY_CLI_SHA256#sha256:}" "${DAIMON_SOURCE_SHA256}" \
  && test "$(sha256sum ${RUNTIME_ROOT}/bin/codex | awk '{print "sha256:" $1}')" = "${CODEX_CLI_SHA256}" \
  && test "$(sha256sum ${RUNTIME_ROOT}/bin/grok | awk '{print "sha256:" $1}')" = "sha256:${GROK_CLI_SHA256#sha256:}" \
  && test "$(sha256sum ${RUNTIME_ROOT}/bin/agy | awk '{print "sha256:" $1}')" = "sha256:${AGY_CLI_SHA256#sha256:}" \
  && npm cache clean --force \
  && test -f ${RUNTIME_ROOT}/node_modules/@noopolis/daimon/package.json

FROM scratch
COPY --from=build /opt/spawnfile/runtime-installs/daimon /opt/spawnfile/runtime-installs/daimon
