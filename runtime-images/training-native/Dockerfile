# Rendered by scripts/publish-training-native.ts from checked-in authorities.
FROM @@DAIMON_IMAGE@@ AS daimon
FROM node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
RUN apt-get update && apt-get install -y --no-install-recommends bash bubblewrap ca-certificates curl git tar util-linux && rm -rf /var/lib/apt/lists/*
COPY --from=daimon /opt/spawnfile/runtime-installs/daimon /opt/spawnfile/runtime-installs/daimon
RUN @@DAIMON_INSTALL@@
RUN @@MOLTNET_INSTALL@@
# Spawnfile native adapter contract: /opt/training/native/worker imports @noopolis/daimon/runtime.
RUN mkdir -p /opt/training && ln -s /opt/spawnfile/runtime-installs/daimon/node_modules /opt/training/node_modules
ENV PATH="/opt/spawnfile/runtime-installs/daimon/bin:${PATH}"
WORKDIR /opt/training
