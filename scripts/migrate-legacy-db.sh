#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
NODE_BINARY="${NODE_BINARY:-node}"

if ! command -v "$NODE_BINARY" >/dev/null 2>&1; then
  printf '%s\n' 'Node.js >= 22.12.0 is required. Install dependencies with pnpm install first.' >&2
  exit 1
fi
if ! "$NODE_BINARY" --experimental-sqlite -e 'require("node:sqlite")' >/dev/null 2>&1; then
  printf '%s\n' 'This Node.js installation does not support node:sqlite; use Node.js >= 22.12.0.' >&2
  exit 1
fi

exec "$NODE_BINARY" --experimental-sqlite "$SCRIPT_DIR/legacy-migration/cli.mjs" "$@"
