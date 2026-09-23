#!/usr/bin/env bash
# SessionStart, synchronous. Two jobs:
#   1. make BUZZ_* visible to every later Bash tool call in this session
#   2. register the session and hand over anything queued while it was closed
#
# Never fails the session start.
set -uo pipefail

WAKE_HOME="${BUZZWAKE_HOME:-$HOME/.buzz-wake}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# CLAUDE_ENV_FILE contents apply to the whole session — the only reliable cure
# for "BUZZ_* only lives in ~/.zshrc, non-interactive shells can't see it".
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -f "$WAKE_HOME/env" ]; then
  cat "$WAKE_HOME/env" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true
fi

exec "$ROOT/bin/buzzwake" internal-register
