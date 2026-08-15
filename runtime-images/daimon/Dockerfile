# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_ROOT=/opt/spawnfile/runtime-installs/daimon

# Registry build: install the published Daimon + Mneme + Pi packages straight
# from npm. This needs no Daimon source checkout and is the Dockerfile default.
FROM ${NODE_IMAGE} AS build

ARG DAIMON_VERSION=0.1.2
ARG MNEME_VERSION=0.1.1
ARG PI_VERSION=0.79.10
ARG RUNTIME_ROOT

RUN mkdir -p "${RUNTIME_ROOT}" \
  && cd "${RUNTIME_ROOT}" \
  && npm install --omit=dev --no-fund --no-audit \
    "@noopolis/daimon@${DAIMON_VERSION}" \
    "@noopolis/mneme@${MNEME_VERSION}" \
    "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    "@earendil-works/pi-ai@${PI_VERSION}" \
  && npm cache clean --force \
  && find node_modules -type d \( \
      -name docs -o \
      -name examples -o \
      -name test -o \
      -name tests -o \
      -name __tests__ \
    \) -prune -exec rm -rf {} + \
  && find node_modules -type f \( \
      -name "*.map" -o \
      -name "*.md" -o \
      -name "*.mdx" \
    \) -delete

# The local target keeps the default registry install unchanged while replacing
# only Daimon and Mneme with tarballs supplied in a minimal build context.
FROM ${NODE_IMAGE} AS local-build

ARG RUNTIME_ROOT
ARG PI_VERSION=0.79.10

COPY daimon.tgz mneme.tgz /tmp/local-packages/

RUN mkdir -p "${RUNTIME_ROOT}" \
  && cd "${RUNTIME_ROOT}" \
  && npm install --omit=dev --no-fund --no-audit \
    /tmp/local-packages/daimon.tgz \
    /tmp/local-packages/mneme.tgz \
    "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    "@earendil-works/pi-ai@${PI_VERSION}" \
  && npm cache clean --force \
  && find node_modules -type d \( \
      -name docs -o \
      -name examples -o \
      -name test -o \
      -name tests -o \
      -name __tests__ \
    \) -prune -exec rm -rf {} + \
  && find node_modules -type f \( \
      -name "*.map" -o \
      -name "*.md" -o \
      -name "*.mdx" \
    \) -delete

FROM scratch AS local

ARG RUNTIME_ROOT

COPY --from=local-build ${RUNTIME_ROOT} ${RUNTIME_ROOT}

# scratch has no shell or Node executable, so the verifier is a temporary
# Node image containing exactly the local runtime filesystem.
FROM ${NODE_IMAGE} AS verify

ARG RUNTIME_ROOT

COPY --from=local ${RUNTIME_ROOT} ${RUNTIME_ROOT}
COPY verifyRuntimeImage.mjs /usr/local/lib/daimon/verifyRuntimeImage.mjs

CMD ["node", "--no-warnings", "/usr/local/lib/daimon/verifyRuntimeImage.mjs"]

# Keep the registry install as the Dockerfile's default (final) target so an
# unqualified `docker build` produces the published, copy-only artifact image.
FROM scratch AS registry

ARG RUNTIME_ROOT

COPY --from=build ${RUNTIME_ROOT} ${RUNTIME_ROOT}
