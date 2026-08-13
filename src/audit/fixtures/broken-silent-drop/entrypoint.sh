#!/usr/bin/env bash
set -euo pipefail

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "Missing required env: $name" >&2
    exit 1
  fi
}

require_file() {
  local target="$1"
  if [ ! -f "$target" ]; then
    echo "Missing required file: $target" >&2
    exit 1
  fi
}

write_env_file() {
  local name="$1"
  local target="$2"
  if [ -z "${!name:-}" ]; then
    return
  fi
  mkdir -p "$(dirname "$target")"
  printf %s "${!name:-}" > "$target"
}

require_env 'OPENAI_API_KEY'

mkdir -p '/opt/spawnfile/workspace/agents/office-agent'
require_file '/opt/spawnfile/runtime/config.json'
HOME='/opt/spawnfile/home' NOOPOLIS_RUN_ID="${NOOPOLIS_RUN_ID}" exec node /opt/spawnfile/runtime/app.mjs
