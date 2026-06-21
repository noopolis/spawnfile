#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG="${1:-noopolis/spawnfile-pi-runtime:0.79.9-node24}"
DOCKER_CONTEXT="${SPAWNFILE_DOCKER_CONTEXT:-}"

DOCKER_ARGS=()
if [[ -n "$DOCKER_CONTEXT" ]]; then
  DOCKER_ARGS+=(--context "$DOCKER_CONTEXT")
fi

docker "${DOCKER_ARGS[@]}" build \
  -f "$ROOT_DIR/docker/pi-runtime-base.Dockerfile" \
  -t "$TAG" \
  "$ROOT_DIR"

cat <<EOF
built $TAG

Use it for generated Pi org builds with:
  SPAWNFILE_PI_RUNTIME_BASE_IMAGE=$TAG spawnfile up <org> --detach
EOF
