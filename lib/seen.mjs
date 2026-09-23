import { paths } from './paths.mjs'
import { readJson, writeJsonAtomic } from './util.mjs'

const MAX_REMEMBERED = 500

// buzz-acp re-sends events after reconnects and batches overlapping windows,
// so the same event id can arrive several times. A bounded ring of seen ids is
// enough to make delivery idempotent without a database.
export const filterUnseen = (events) => {
  const state = readJson(paths.state, {}) || {}
  const seen = Array.isArray(state.seen_events) ? state.seen_events : []
  const known = new Set(seen)

  const fresh = events.filter((event) => !known.has(event.id))
  if (fresh.length === 0) return []

  const merged = [...seen, ...fresh.map((event) => event.id)].slice(-MAX_REMEMBERED)
  writeJsonAtomic(paths.state, { ...state, seen_events: merged })
  return fresh
}
