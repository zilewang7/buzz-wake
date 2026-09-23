import { allSessions, sessionState, readMeta } from './sessions.mjs'
import { resumePolicyFor } from './config.mjs'

const matchesChannel = (rule, event) => {
  const want = (rule.channel || '*').trim()
  if (want === '*') return true
  const lower = want.toLowerCase()
  if (event.channel_id && event.channel_id === lower) return true
  // Channel names are the human-friendly way to write a rule.
  return Boolean(event.channel_label && event.channel_label.toLowerCase().includes(lower))
}

const matchesAuthor = (rule, event) => {
  if (!rule.from) return true
  const want = rule.from.trim().toLowerCase()
  if (!event.author_pubkey) return false
  return event.author_pubkey === want || event.author_pubkey.startsWith(want)
}

export const matchRule = (config, event) =>
  config.rules.find((rule) => matchesChannel(rule, event) && matchesAuthor(rule, event)) || null

export const resolveSelector = (selector, sessions) => {
  if (selector === 'none') return []
  if (selector === 'all') return sessions.filter((s) => s.state === 'live')
  if (selector === 'newest') {
    const live = sessions.filter((s) => s.state === 'live')
    if (live.length > 0) return [live[0]]
    const dormant = sessions.filter((s) => s.state === 'dormant')
    return dormant.length > 0 ? [dormant[0]] : []
  }

  const [kind, ...rest] = selector.split(':')
  const value = rest.join(':')

  if (kind === 'session') {
    const meta = readMeta(value)
    if (!meta) return []
    const state = sessionState(meta)
    // Match the label:/cwd: selectors — a gone session has no transcript left to
    // resume, so routing to it only burns one event on deliver's forget-and-skip.
    return state === 'gone' ? [] : [{ ...meta, state }]
  }
  if (kind === 'label') {
    return sessions.filter((s) => s.label === value && s.state !== 'gone')
  }
  if (kind === 'cwd') {
    return sessions.filter((s) => s.cwd === value && s.state !== 'gone')
  }
  return []
}

// Returns { rule, targets: [{ session, policy, viaFallback }], staleSelectors }.
// viaFallback marks targets reached through the global default rather than a
// rule the user wrote — those never trigger an automatic terminal window. It is
// decided by which branch we left through, not by what the selector is called.
// staleSelectors names explicit selectors that resolved to nothing, so the log
// can say why an event went nowhere instead of just printing targets=0.
export const route = (config, event) => {
  const sessions = allSessions()
  const rule = matchRule(config, event)
  const policy = resumePolicyFor(config, rule)

  if (rule) {
    const selectors = Array.isArray(rule.to) ? rule.to : []
    const explicit = selectors.filter((s) => s !== 'newest' && s !== 'all')
    // viaFallback means "we guessed this target", not "the selector is named
    // newest". Everything in this branch came from a rule the user wrote, so a
    // rule that explicitly says to:["newest"] earns auto-resume just like
    // session:/label:/cwd: do. Keying off the selector name silently downgraded
    // those to notify — and, once the downgrade was logged, printed a line blaming a
    // fallback route the user never took.
    const targets = selectors.flatMap((selector) =>
      resolveSelector(selector, sessions).map((session) => ({
        session,
        policy,
        viaFallback: false,
      })),
    )
    if (targets.length > 0 || explicit.length > 0 || selectors.includes('none')) {
      // to:["none"] resolving to nothing is the point, not a stale binding.
      const stale = targets.length === 0 ? explicit.filter((s) => s !== 'none') : []
      return { rule, targets: dedupe(targets), staleSelectors: stale }
    }
  }

  const fallback = config.default || 'newest'
  const targets = resolveSelector(fallback, sessions).map((session) => ({
    session,
    policy,
    viaFallback: true,
  }))
  return { rule: null, targets: dedupe(targets) }
}

const dedupe = (targets) => {
  const seen = new Set()
  return targets.filter(({ session }) => {
    if (seen.has(session.session_id)) return false
    seen.add(session.session_id)
    return true
  })
}
