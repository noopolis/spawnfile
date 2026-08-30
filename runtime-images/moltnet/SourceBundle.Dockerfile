# syntax=docker/dockerfile:1
ARG GO_IMAGE=golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac
FROM ${GO_IMAGE} AS build
ARG SOURCE_ARCHIVE_SHA256
ARG DEPENDENCY_ARCHIVE_SHA256
COPY --from=source_bundle /source.tar /tmp/source.tar
COPY --from=dependency_bundle /dependencies.tar /tmp/dependencies.tar
RUN test "$(sha256sum /tmp/source.tar | awk '{print "sha256:" $1}')" = "${SOURCE_ARCHIVE_SHA256}" \
 && test "$(sha256sum /tmp/dependencies.tar | awk '{print "sha256:" $1}')" = "${DEPENDENCY_ARCHIVE_SHA256}" \
 && mkdir /src /closure /out && tar -xf /tmp/source.tar -C /src && tar -xf /tmp/dependencies.tar -C /closure \
 && rm /src/.spawnfile-source-manifest.json /closure/.spawnfile-source-manifest.json \
 && cd /src && test "$(sha256sum go.mod | awk '{print "sha256:" $1}')" = "$(sha256sum /closure/go.mod | awk '{print "sha256:" $1}')" \
 && test "$(sha256sum go.sum | awk '{print "sha256:" $1}')" = "$(sha256sum /closure/go.sum | awk '{print "sha256:" $1}')" \
 && GOMODCACHE=/closure/gomodcache GOPROXY=off GOSUMDB=off go mod verify \
 && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 GOMAXPROCS=1 GOMODCACHE=/closure/gomodcache GOPROXY=off GOSUMDB=off go build -p=1 -trimpath -ldflags '-s -w' -o /out/moltnet ./cmd/moltnet \
 && test -x /out/moltnet
FROM scratch
COPY --from=build /out/moltnet /moltnet
