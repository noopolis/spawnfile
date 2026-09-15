ARG NATIVE_IMAGE
ARG PYTHON_IMAGE
FROM ${PYTHON_IMAGE} AS python
FROM ${NATIVE_IMAGE} AS training

# Both parents must use the same architecture and Debian release.
COPY --from=python /usr/local /opt/python
COPY --from=python /usr/lib/*-linux-gnu/libsqlite3.so.0* /opt/python/lib/
# The bridge intentionally clears ambient environment variables. Register native
# libraries in the image so Python extensions also load in that clean process.
RUN echo /opt/python/lib > /etc/ld.so.conf.d/training-python.conf && ldconfig

WORKDIR /opt/training/paideia
COPY paideia/package.json paideia/package-lock.json ./
RUN npm ci --omit=dev --omit=peer --ignore-scripts \
 && mkdir -p node_modules/@noopolis \
 && ln -s /opt/spawnfile/runtime-installs/daimon/node_modules/@noopolis/daimon node_modules/@noopolis/daimon

WORKDIR /opt/training/spawnfile
COPY spawnfile/package.json spawnfile/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

WORKDIR /opt/training/compiler
COPY compiler/package.json compiler/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY bridge /opt/training/paideia/bridges/dspy
RUN /opt/python/bin/python3 -m venv /opt/training/paideia/bridges/dspy/.venv \
 && /opt/training/paideia/bridges/dspy/.venv/bin/pip install --no-cache-dir -r /opt/training/paideia/bridges/dspy/requirements.lock \
 && /opt/training/paideia/bridges/dspy/.venv/bin/pip install --no-cache-dir setuptools==80.9.0 \
 && /opt/training/paideia/bridges/dspy/.venv/bin/pip install --no-deps --no-build-isolation -e /opt/training/paideia/bridges/dspy

COPY claude/package.json claude/package-lock.json /opt/training/claude/
RUN cd /opt/training/claude && npm ci --omit=dev
COPY grok /opt/training/bin/grok

COPY paideia/dist /opt/training/paideia/dist
COPY spawnfile/dist /opt/training/spawnfile/dist
COPY compiler/dist /opt/training/compiler/dist
COPY compiler/runtimes.yaml compiler/moltnet-releases.json /opt/training/compiler/
COPY spawnfile/runtimes.yaml spawnfile/moltnet-releases.json /opt/training/spawnfile/
COPY integration /opt/training/integration
COPY bootstrap /opt/training/bootstrap
COPY train /opt/training/bin/train
RUN chmod 0555 /opt/training/bin/train /opt/training/bin/grok \
 && chmod -R a+rX /opt/training \
 && ln -s /opt/training/claude/node_modules/.bin/claude /opt/training/bin/claude \
 && ln -s /opt/training/paideia/dist/src/cli/main.js /opt/training/bin/paideia \
 && ln -s /opt/training/spawnfile/dist/cli/index.js /opt/training/bin/spawnfile \
 && mkdir -p /opt/training/integration/node_modules/@noopolis \
 && ln -s /opt/training/paideia /opt/training/integration/node_modules/@noopolis/paideia \
 && ln -s /opt/training/spawnfile /opt/training/integration/node_modules/spawnfile \
 && ln -s /opt/spawnfile/runtime-installs/daimon/node_modules/@noopolis/daimon /opt/training/integration/node_modules/@noopolis/daimon
ENV PATH=/opt/training/bin:/opt/training/paideia/bridges/dspy/.venv/bin:/opt/spawnfile/runtime-installs/daimon/bin:/usr/local/bin:/usr/bin:/bin
ENV HOME=/home/training
WORKDIR /work
ENTRYPOINT ["/opt/training/bin/train"]
