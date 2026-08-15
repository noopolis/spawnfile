# syntax=docker/dockerfile:1

ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim AS build

ARG DAIMON_VERSION=0.1.2
ARG MNEME_VERSION=0.1.1
ARG PI_VERSION=0.79.10
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon

RUN mkdir -p ${RUNTIME_ROOT} \
  && cd ${RUNTIME_ROOT} \
  && npm install --omit=dev --no-fund --no-audit \
    @noopolis/daimon@${DAIMON_VERSION} \
    @noopolis/mneme@${MNEME_VERSION} \
    @earendil-works/pi-coding-agent@${PI_VERSION} \
    @earendil-works/pi-ai@${PI_VERSION} \
  && npm cache clean --force \
  && test -f ${RUNTIME_ROOT}/node_modules/@noopolis/daimon/package.json

FROM scratch
COPY --from=build /opt/spawnfile/runtime-installs/daimon /opt/spawnfile/runtime-installs/daimon
