#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WAKE_HOME="${BUZZWAKE_HOME:-$HOME/.buzz-wake}"

NODE=""
if [ -f "$WAKE_HOME/install.json" ]; then
  NODE="$(sed -n 's/.*"node"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$WAKE_HOME/install.json" | head -1)"
fi
[ -x "$NODE" ] || NODE="$(command -v node || true)"
[ -x "$NODE" ] || { echo "找不到 node" >&2; exit 1; }

exec "$NODE" "$ROOT/lib/uninstall.mjs" "$@"
