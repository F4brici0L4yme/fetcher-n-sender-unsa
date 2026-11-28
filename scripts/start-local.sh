#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Error: Node.js is required to start the local Docker stack.' >&2
  exit 1
fi

exec node scripts/start-local.mjs "$@"
