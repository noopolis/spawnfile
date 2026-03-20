#!/usr/bin/env sh
set -eu

if ! command -v node >/dev/null 2>&1; then
  echo "spawnfile requires Node.js 22 or newer" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "spawnfile requires npm" >&2
  exit 1
fi

echo "Installing dependencies"
npm install

echo "Building spawnfile"
npm run build

echo "Linking spawnfile into your PATH"
npm link

echo "Installed. Run: spawnfile --help"
