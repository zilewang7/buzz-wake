#!/bin/bash
# PostToolUse, synchronous. Hands over anything Buzz queued while this turn was
# already running, so a mention lands next to the tool result instead of waiting
# for the turn to end.
#
# This runs on EVERY tool call, so the empty case must cost almost nothing:
# parse the payload with bash parameter expansion (no jq, no subprocess) and
# bail before paying node's ~62ms startup. Measured: 11.5ms empty vs 62.4ms if
# node were spawned unconditionally — 0.35s vs 1.9s over a 30-call turn.
set -uo pipefail

WAKE_HOME="${BUZZWAKE_HOME:-$HOME/.buzz-wake}"

payload="$(cat)"
sid="${payload#*\"session_id\":\"}"
sid="${sid%%\"*}"
# No match leaves the expansion equal to the whole payload.
[ -n "$sid" ] && [ "$sid" != "$payload" ] || exit 0

# Subagents run this same hook, and their payload carries the MAIN session's
# session_id — so draining here hands the message to a subagent whose context is
# discarded when it returns. The main thread never sees it, and by the time it
# looks, pending is already empty. Measured: one real message lost this way
# (2026-09-08). What tells the two apart is agent_id, present only
# inside a subagent.
#
# Leaving it queued costs at most a short delay: the main thread's next tool
# call drains it, and the Stop watcher covers the case where there isn't one.
#
# Matching the raw payload is safe despite the message-body hazard that has bit
# this parser twice (README pit 30): inside a JSON string every quote is
# escaped, so an unescaped `"agent_id"` can only be a real key. Verified with a
# main-thread tool call whose command text spelled out `"agent_id":"fake"` — no
# match. Deliberately not anchored to the field's position in the header: a
# missed subagent silently restores the bug, an over-eager match only delays.
case "$payload" in *'"agent_id"'*) exit 0 ;; esac

for f in "$WAKE_HOME/sessions/$sid/pending/"*.json; do
  [ -e "$f" ] || exit 0
  break
done

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/bin/buzzwake" internal-drain "$sid"
