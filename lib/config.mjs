import { paths } from './paths.mjs'
import { readJson, writeJsonAtomic } from './util.mjs'

export const RESUME_MODES = ['off', 'notify', 'ask', 'auto']
export const DEFAULT_TARGETS = ['newest', 'none']

export const DEFAULT_RESUME = {
  // auto is safe as a default because a session reached through the global
  // fallback never opens a window (see deliver.mjs) — only channels you
  // explicitly bound can, and binding is a deliberate act. notify would be
  // strictly weaker than ask: neither opens a window, but notify doesn't even
  // tell you which session to resume.
  mode: 'auto',
  terminal: 'warp',
  cooldown_seconds: 600,
  max_windows_per_hour: 3,
  quiet_hours: null,
  skip_when_locked: true,
  command_template: 'claude -r {{session_id}} "$(cat {{prompt_file}})"',
  continue_template: 'claude -c "$(cat {{prompt_file}})"',
}

// kind 9 = channel message, 45001/45003 = forum post/comment.
// kind 7 (reactions) is deliberately absent: a 👀 should never wake a session.
export const DEFAULT_KINDS = [9, 45001, 45003]

export const DEFAULT_CONFIG = {
  version: 1,
  default: 'newest',
  notify_desktop: true,
  kinds: [...DEFAULT_KINDS],
  resume_defaults: { ...DEFAULT_RESUME },
  rules: [],
}

export const loadConfig = () => {
  const stored = readJson(paths.routes, null)
  if (!stored) return { ...DEFAULT_CONFIG, resume_defaults: { ...DEFAULT_RESUME } }
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    kinds: Array.isArray(stored.kinds) ? stored.kinds : [...DEFAULT_KINDS],
    resume_defaults: { ...DEFAULT_RESUME, ...(stored.resume_defaults || {}) },
    rules: Array.isArray(stored.rules) ? stored.rules : [],
  }
}

export const saveConfig = (config) => writeJsonAtomic(paths.routes, config)

export const resumePolicyFor = (config, rule) => ({
  ...config.resume_defaults,
  ...(rule?.resume || {}),
})

// A rule is identified by channel+from so `bind` can update in place instead
// of stacking duplicates every time it runs.
export const ruleKey = (rule) => `${rule.channel || '*'}|${rule.from || '*'}`

export const upsertRule = (config, rule) => {
  const key = ruleKey(rule)
  const index = config.rules.findIndex((existing) => ruleKey(existing) === key)
  if (index === -1) config.rules.push(rule)
  else config.rules[index] = rule
  return config
}

export const removeTargetFromRules = (config, target) => {
  config.rules = config.rules
    .map((rule) => ({ ...rule, to: (rule.to || []).filter((entry) => entry !== target) }))
    .filter((rule) => rule.to.length > 0)
  return config
}
