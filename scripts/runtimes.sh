#!/usr/bin/env sh
set -eu

# Clones or updates all runtimes to their pinned stable refs.
# Reads from runtimes.yaml at the repo root.
#
# Usage:
#   ./scripts/runtimes.sh            # sync all runtimes
#   ./scripts/runtimes.sh openclaw   # sync one runtime

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MANIFEST="$ROOT/runtimes.yaml"
DIR="$ROOT/runtimes"

if [ ! -f "$MANIFEST" ]; then
  echo "Missing $MANIFEST" >&2
  exit 1
fi

# Parse runtimes.yaml with a small node one-liner.
# Outputs lines like: name|remote|ref|default_branch
parse_manifest() {
  node -e "
    const fs = require('fs');
    const lines = fs.readFileSync('$MANIFEST', 'utf8').split('\n');
    let current = null;
    const entries = {};
    for (const line of lines) {
      const nameMatch = line.match(/^  (\w+):$/);
      if (nameMatch) { current = nameMatch[1]; entries[current] = {}; continue; }
      if (!current) continue;
      const kvMatch = line.match(/^\s{4}(\w+):\s*(.+)$/);
      if (kvMatch) entries[current][kvMatch[1]] = kvMatch[2];
    }
    for (const [name, e] of Object.entries(entries)) {
      console.log([name, e.remote, e.ref, e.default_branch].join('|'));
    }
  "
}

sync_runtime() {
  name="$1"; remote="$2"; ref="$3"; branch="$4"
  target="$DIR/$name"

  if [ -d "$target/.git" ]; then
    echo "Fetching $name"
    git -C "$target" fetch origin --tags --quiet
  else
    echo "Cloning $name"
    mkdir -p "$DIR"
    git clone --quiet "$remote" "$target"
  fi

  current=$(git -C "$target" describe --tags --exact-match 2>/dev/null || git -C "$target" rev-parse --short HEAD)
  if [ "$current" = "$ref" ]; then
    echo "  $name already at $ref"
  else
    echo "  $name: $current -> $ref"
    git -C "$target" checkout --quiet "$ref"
  fi
}

FILTER="${1:-}"

parse_manifest | while IFS='|' read -r name remote ref branch; do
  if [ -n "$FILTER" ] && [ "$name" != "$FILTER" ]; then
    continue
  fi
  sync_runtime "$name" "$remote" "$ref" "$branch"
done

echo "Done."
