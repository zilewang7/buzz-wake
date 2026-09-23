#!/usr/bin/env bash
# buzz-wake installer. Idempotent — safe to re-run.
#
# All it does in bash is find a *stable* node; everything else lives in
# lib/setup.mjs so the interactive parts can be pleasant.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "buzz-wake 目前只支持 macOS（依赖 launchd 和 Warp/Terminal.app）。" >&2
  exit 1
fi

# fnm/nvm put node under a per-shell path that dies with the terminal. launchd
# would never find it again, so prefer a version-dir path we can pin.
resolve_node() {
  local candidate
  for candidate in \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node
  do
    [ -x "$candidate" ] && echo "$candidate"
  done | sort -V | tail -1
}

NODE="$(resolve_node || true)"

if [ -z "$NODE" ]; then
  # Last resort: whatever is on PATH, even if it is a multishell path.
  NODE="$(command -v node || true)"
fi

if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  cat >&2 <<'EOF'
找不到 node。装一个再来：
  brew install node
或者用 fnm/nvm 装完后重开终端。
EOF
  exit 1
fi

chmod +x "$ROOT/bin/buzzwake" "$ROOT/hooks/"*.sh 2>/dev/null || true

exec "$NODE" "$ROOT/lib/setup.mjs" --node "$NODE" --root "$ROOT" "$@"
