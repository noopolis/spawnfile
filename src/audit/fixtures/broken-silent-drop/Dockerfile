FROM node:22-slim

WORKDIR /opt/spawnfile

COPY runtime/ /opt/spawnfile/runtime/
COPY entrypoint.sh /opt/spawnfile/entrypoint.sh
RUN chmod +x /opt/spawnfile/entrypoint.sh

ENTRYPOINT ["/opt/spawnfile/entrypoint.sh"]
