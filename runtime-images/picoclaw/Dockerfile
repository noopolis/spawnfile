# syntax=docker/dockerfile:1

FROM debian:bookworm-slim AS build

ARG PICOCLAW_VERSION=v0.2.9
ARG TARGETARCH
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/picoclaw

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl tar \
  && rm -rf /var/lib/apt/lists/*

RUN case "${TARGETARCH}" in \
    amd64) asset="picoclaw_Linux_x86_64.tar.gz" ;; \
    arm64) asset="picoclaw_Linux_arm64.tar.gz" ;; \
    *) echo "Unsupported PicoClaw release architecture: ${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -fsSL -o /tmp/picoclaw.tar.gz \
    "https://github.com/sipeed/picoclaw/releases/download/${PICOCLAW_VERSION}/${asset}" \
  && mkdir -p /tmp/picoclaw-extract ${RUNTIME_ROOT}/bin \
  && tar -xzf /tmp/picoclaw.tar.gz -C /tmp/picoclaw-extract \
  && binary_path="$(find /tmp/picoclaw-extract -type f -name picoclaw | head -n 1)" \
  && test -n "${binary_path}" \
  && install -m 0755 "${binary_path}" ${RUNTIME_ROOT}/bin/picoclaw

FROM scratch
COPY --from=build /opt/spawnfile/runtime-installs/picoclaw /opt/spawnfile/runtime-installs/picoclaw
