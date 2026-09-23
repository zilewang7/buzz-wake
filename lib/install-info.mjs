import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { paths, WAKE_HOME } from './paths.mjs'
import { readJson, readText } from './util.mjs'

// A profile IS a WAKE_HOME directory — there is no registry. Its basename derives
// the slug, and the slug derives the launchd label, so two homes can never share
// a plist path (which is how installing a second identity used to evict the first).
// ~/.buzz-wake maps to "default" on purpose: existing machines keep the byte-for-byte
// label xyz.buzz.wake, so no job needs rebuilding.
export const profileSlug = (home = WAKE_HOME) => {
  const base = basename(home).replace(/^\./, '').replace(/^buzz-wake-?/, '')
  const slug = base.replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return slug || 'default'
}

export const launchdLabel = (home = WAKE_HOME) => {
  const slug = profileSlug(home)
  return slug === 'default' ? 'xyz.buzz.wake' : `xyz.buzz.wake.${slug}`
}

export const LAUNCHD_LABEL = launchdLabel()

export const BUZZ_APP_BIN = '/Applications/Buzz.app/Contents/MacOS'

export const loadInstall = () => readJson(paths.install, {}) || {}

export const findBinary = (name, extraCandidates = []) => {
  const candidates = [
    ...extraCandidates,
    `${BUZZ_APP_BIN}/${name}`,
    `${process.env.HOME}/.local/bin/${name}`,
    `/opt/homebrew/bin/${name}`,
    `/usr/local/bin/${name}`,
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null
}

// buzz-acp speaks WebSocket only; the CLI happily takes https.
export const toWebsocketUrl = (url) => {
  if (!url) return url
  if (url.startsWith('https://')) return `wss://${url.slice('https://'.length)}`
  if (url.startsWith('http://')) return `ws://${url.slice('http://'.length)}`
  return url
}

// Mirror of the shell's own unquoting rules for the two forms we ever write.
const unquote = (raw) => {
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
    return raw.slice(1, -1).replaceAll(`'\\''`, "'")
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1)
  return raw
}

export const readEnvFile = () => {
  const text = readText(paths.env, '')
  const values = {}
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/)
    if (!match) continue
    values[match[1]] = unquote(match[2].trim())
  }
  return values
}
