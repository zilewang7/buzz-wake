#!/bin/bash
# UserPromptSubmit, synchronous. Marks the turn as in flight so the watcher
# stops short of exit 2 — during a turn, delivery is PostToolUse's job, and
# waking a busy session would cut off whatever it is doing.
#
# Pure bash on purpose: this is on the path of every prompt, and the marker's
# mtime is the entire payload, so there is nothing worth starting node for.
set -uo pipefail

WAKE_HOME="${BUZZWAKE_HOME:-$HOME/.buzz-wake}"

payload="$(cat)"
sid="${payload#*\"session_id\":\"}"
sid="${sid%%\"*}"
[ -n "$sid" ] && [ "$sid" != "$payload" ] || exit 0

dir="$WAKE_HOME/sessions/$sid"
# Only mark sessions buzz-wake already knows about — creating the directory here
# would invent a session record that never gets a meta.json.
[ -d "$dir" ] || exit 0
: > "$dir/turn-active"
