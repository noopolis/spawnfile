ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}

WORKDIR /opt/spawnfile

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git procps \
  && rm -rf /var/lib/apt/lists/*

ARG PI_PACKAGE=@earendil-works/pi-coding-agent
ARG PI_AI_PACKAGE=@earendil-works/pi-ai
ARG PI_VERSION=0.79.9

RUN mkdir -p /opt/spawnfile/runtime-installs/pi \
  && cd /opt/spawnfile/runtime-installs/pi \
  && npm install --omit=dev --no-fund --no-audit "${PI_PACKAGE}@${PI_VERSION}" "${PI_AI_PACKAGE}@${PI_VERSION}"
