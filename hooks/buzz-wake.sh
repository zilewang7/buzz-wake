#!/usr/bin/env bash
# Stop / SessionStart hook with asyncRewake: true.
#
# All the logic lives in node (no jq dependency); this is just the launcher.
# The watcher polls local disk only — it never touches the relay.
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/buzzwake" internal-watch
