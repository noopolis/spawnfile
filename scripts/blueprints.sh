#!/usr/bin/env bash
set -u

# Generates blueprints by running each runtime's actual init/setup or
# extracting config from shipped examples and source code.
#
# Usage:
#   ./scripts/blueprints.sh              # regenerate all
#   ./scripts/blueprints.sh openclaw     # regenerate one
#
# Requires: node, npm

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BLUEPRINTS="$ROOT/blueprints"
RUNTIMES="$ROOT/runtimes"
TMPBASE="$(mktemp -d)"

cleanup() { rm -rf "$TMPBASE"; }
trap cleanup EXIT

ensure_runtime() {
  local name="$1"
  if [ ! -d "$RUNTIMES/$name" ]; then
    echo "  WARNING: $RUNTIMES/$name not found. Run ./scripts/runtimes.sh $name first."
    return 1
  fi
  return 0
}

# --- OPENCLAW (npm — run onboard) ---
blueprint_openclaw() {
  echo "Generating openclaw blueprint..."
  ensure_runtime openclaw || return

  local tmp="$TMPBASE/openclaw"
  local state="$tmp/state"
  local workspace="$tmp/workspace"
  local dest="$BLUEPRINTS/openclaw"

  mkdir -p "$tmp"
  cd "$tmp"
  npm init -y --silent >/dev/null 2>&1
  echo "  installing openclaw..."
  npm install openclaw 2>&1 | tail -1 || true

  echo "  running onboard..."
  OPENCLAW_STATE_DIR="$state" HOME="$tmp" \
    npx openclaw onboard \
      --non-interactive --accept-risk \
      --skip-channels --skip-skills --skip-health --skip-ui \
      --workspace "$workspace" \
      >/dev/null 2>&1

  if [ ! -f "$state/openclaw.json" ]; then
    echo "  ERROR: openclaw onboard did not produce config. Check node version (needs >=22.16)."
    return
  fi

  rm -rf "$dest"
  mkdir -p "$dest/workspace"

  node -e "
var fs = require('fs');
var cfg = JSON.parse(fs.readFileSync('$state/openclaw.json', 'utf8'));
if (cfg.gateway && cfg.gateway.auth) cfg.gateway.auth.token = '<generated-at-setup>';
if (cfg.agents && cfg.agents.defaults) cfg.agents.defaults.workspace = '<workspace-path>';
delete cfg.wizard;
delete cfg.meta;
fs.writeFileSync('$dest/openclaw.json', JSON.stringify(cfg, null, 2) + '\n');
"

  find "$workspace" -maxdepth 1 -type f -name '*.md' -exec cp {} "$dest/workspace/" \;
  (cd "$dest" && find . -type f | sort) > "$dest/TREE.txt"
  echo "  done"
}

# --- PICOCLAW (Go — use shipped example config + source for doc layout) ---
blueprint_picoclaw() {
  echo "Generating picoclaw blueprint..."
  ensure_runtime picoclaw || return

  local dest="$BLUEPRINTS/picoclaw"
  rm -rf "$dest"
  mkdir -p "$dest/workspace/memory" "$dest/workspace/skills"

  if [ -f "$RUNTIMES/picoclaw/config/config.example.json" ]; then
    cp "$RUNTIMES/picoclaw/config/config.example.json" "$dest/config.json"
  else
    echo "  WARNING: config.example.json not found"
    return
  fi

  # Docs that PicoClaw reads from workspace (from pkg/agent/context.go)
  for doc in AGENTS.md SOUL.md USER.md IDENTITY.md HEARTBEAT.md; do
    printf '# %s\n\nPicoClaw reads this from the workspace.\n' "$doc" > "$dest/workspace/$doc"
  done
  printf '# MEMORY.md\n\nLong-term memory file.\n' > "$dest/workspace/memory/MEMORY.md"

  (cd "$dest" && find . -type f | sort) > "$dest/TREE.txt"
  echo "  done"
}

# --- TINYCLAW (npm — extract defaults from source) ---
blueprint_tinyclaw() {
  echo "Generating tinyclaw blueprint..."
  ensure_runtime tinyclaw || return

  local dest="$BLUEPRINTS/tinyclaw"
  rm -rf "$dest"
  mkdir -p "$dest/workspace/default/.agents/skills" "$dest/workspace/default/.claude/skills"

  node --input-type=module -e "
import { DEFAULT_SETTINGS } from '$RUNTIMES/tinyclaw/packages/cli/lib/defaults.mjs';
var s = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
s.workspace.path = '<workspace-path>';
s.workspace.name = 'workspace';
if (s.agents && s.agents.default) s.agents.default.working_directory = '<workspace-path>/default';
s.teams = { 'example-team': { name: 'Example Team', agents: ['default'], leader_agent: 'default' } };
process.stdout.write(JSON.stringify(s, null, 2) + '\n');
" > "$dest/settings.json" 2>/dev/null || {
    echo "  WARNING: Could not extract defaults, using fallback"
    node -e "
var s={workspace:{path:'<workspace-path>',name:'workspace'},channels:{enabled:[]},agents:{default:{name:'Agent',provider:'anthropic',model:'opus',working_directory:'<workspace-path>/default'}},teams:{'example-team':{name:'Example Team',agents:['default'],leader_agent:'default'}},models:{provider:'anthropic'},monitoring:{heartbeat_interval:3600}};
process.stdout.write(JSON.stringify(s, null, 2) + '\n');
" > "$dest/settings.json"
  }

  for doc in AGENTS.md SOUL.md heartbeat.md; do
    printf '# %s\n\nTinyClaw reads this from the agent working directory.\n' "$doc" > "$dest/workspace/default/$doc"
  done

  (cd "$dest" && find . -type f | sort) > "$dest/TREE.txt"
  echo "  done"
}

# --- NULLCLAW (Zig — use shipped example config) ---
blueprint_nullclaw() {
  echo "Generating nullclaw blueprint..."
  ensure_runtime nullclaw || return

  local dest="$BLUEPRINTS/nullclaw"
  rm -rf "$dest"
  mkdir -p "$dest/workspace/skills"

  if [ -f "$RUNTIMES/nullclaw/config.example.json" ]; then
    cp "$RUNTIMES/nullclaw/config.example.json" "$dest/config.json"
  else
    echo "  WARNING: config.example.json not found"
    return
  fi

  # NullClaw workspace docs from source (identity.zig, context building)
  for doc in AGENTS.md SOUL.md IDENTITY.md; do
    printf '# %s\n\nNullClaw reads this from the workspace.\n' "$doc" > "$dest/workspace/$doc"
  done

  (cd "$dest" && find . -type f | sort) > "$dest/TREE.txt"
  echo "  done"
}

# --- ZEROCLAW (Rust — use config reference doc, example config is empty) ---
blueprint_zeroclaw() {
  echo "Generating zeroclaw blueprint..."
  ensure_runtime zeroclaw || return

  local dest="$BLUEPRINTS/zeroclaw"
  rm -rf "$dest"
  mkdir -p "$dest/workspace/skills"

  # The example toml is empty, but config-reference.md has the full schema.
  # Extract a minimal config from the reference or default generation in source.
  if [ -f "$RUNTIMES/zeroclaw/examples/config.example.toml" ]; then
    cp "$RUNTIMES/zeroclaw/examples/config.example.toml" "$dest/config.toml"
  fi

  # Copy the config reference doc as the schema source
  if [ -f "$RUNTIMES/zeroclaw/docs/reference/api/config-reference.md" ]; then
    cp "$RUNTIMES/zeroclaw/docs/reference/api/config-reference.md" "$dest/CONFIG-REFERENCE.md"
  fi

  for doc in AGENTS.md SOUL.md IDENTITY.md; do
    printf '# %s\n\nZeroClaw reads this from the workspace.\n' "$doc" > "$dest/workspace/$doc"
  done

  (cd "$dest" && find . -type f | sort) > "$dest/TREE.txt"
  echo "  done"
}

# --- MAIN ---

FILTER="${1:-}"
ALL_RUNTIMES="openclaw picoclaw tinyclaw nullclaw zeroclaw"

for rt in $ALL_RUNTIMES; do
  if [ -z "$FILTER" ] || [ "$FILTER" = "$rt" ]; then
    "blueprint_$rt"
  fi
done

echo "All blueprints at $BLUEPRINTS"
