# syntax=docker/dockerfile:1

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS build

ARG OPENCLAW_VERSION=2026.6.8
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/openclaw

RUN mkdir -p /tmp/openclaw-install \
  && cd /tmp/openclaw-install \
  && npm init -y >/dev/null \
  && npm install --omit=dev --no-fund --no-audit openclaw@${OPENCLAW_VERSION}

RUN mkdir -p ${RUNTIME_ROOT}/node_modules \
  && cp -a /tmp/openclaw-install/node_modules/openclaw/. ${RUNTIME_ROOT}/ \
  && find /tmp/openclaw-install/node_modules -mindepth 1 -maxdepth 1 ! -name openclaw \
    -exec cp -a {} ${RUNTIME_ROOT}/node_modules/ \; \
  && test -f ${RUNTIME_ROOT}/openclaw.mjs

FROM scratch
COPY --from=build /opt/spawnfile/runtime-installs/openclaw /opt/spawnfile/runtime-installs/openclaw
