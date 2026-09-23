import { readdirSync, existsSync, rmSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { paths, claudeProjectsDir } from './paths.mjs'
import { ensureDir, readJson, writeJsonAtomic, nowSeconds } from './util.mjs'

// Claude Code stores transcripts under ~/.claude/projects/<encoded-cwd>/<id>.jsonl
// where the encoding replaces every non-alphanumeric run with a dash.
export const encodeCwd = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-')

export const transcriptPath = (cwd, sessionId) =>
  join(claudeProjectsDir, encodeCwd(cwd), `${sessionId}.jsonl`)

export const processIsClaude = (pid) => {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
    return /(^|\/)claude(\s|$)/.test(command)
  } catch {
    return false
  }
}

export const listSessionIds = () => {
  try {
    return readdirSync(paths.sessionsDir).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}

export const readMeta = (sessionId) => readJson(paths.sessionMeta(sessionId), null)

export const writeMeta = (meta) => {
  ensureDir(paths.sessionPending(meta.session_id))
  ensureDir(paths.sessionConsumed(meta.session_id))
  writeJsonAtomic(paths.sessionMeta(meta.session_id), meta)
  return meta
}

// live: the claude process is still running
// dormant: process gone but the transcript can still be resumed
// gone: nothing left to resume
export const sessionState = (meta) => {
  if (!meta) return 'gone'
  if (processIsClaude(meta.claude_pid)) return 'live'
  const transcript = meta.transcript || transcriptPath(meta.cwd, meta.session_id)
  return existsSync(transcript) ? 'dormant' : 'gone'
}

export const describeSession = (sessionId) => {
  const meta = readMeta(sessionId)
  if (!meta) return null
  return { ...meta, state: sessionState(meta), pending: countPending(sessionId) }
}

export const allSessions = () =>
  listSessionIds()
    .map(describeSession)
    .filter(Boolean)
    .sort((a, b) => (b.last_seen || 0) - (a.last_seen || 0))

export const countPending = (sessionId) => {
  try {
    return readdirSync(paths.sessionPending(sessionId)).filter((n) => n.endsWith('.json')).length
  } catch {
    return 0
  }
}

export const readPending = (sessionId) => {
  const dir = paths.sessionPending(sessionId)
  let names
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort()
  } catch {
    return []
  }
  return names
    .map((name) => {
      try {
        return { name, path: join(dir, name), event: JSON.parse(readFileSync(join(dir, name), 'utf8')) }
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

// Only a hook-spawned process can wake an idle session, so "is anyone
// listening" is a live question about that process, not a config flag. Without
// this the router logs a green `queued` into a spool nobody is polling and the
// message surfaces whenever the human next happens to type.
export const watcherArmed = (sessionId) => {
  let pid
  try {
    pid = Number.parseInt(readFileSync(join(paths.locksDir, `watch-${sessionId}`, 'pid'), 'utf8'), 10)
  } catch {
    return false
  }
  if (!(pid > 0)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const registerSession = ({ sessionId, cwd, claudePid, terminal, label }) => {
  const existing = readMeta(sessionId) || {}
  return writeMeta({
    ...existing,
    session_id: sessionId,
    cwd: cwd || existing.cwd || process.cwd(),
    transcript: transcriptPath(cwd || existing.cwd || process.cwd(), sessionId),
    label: label || existing.label || null,
    claude_pid: claudePid || existing.claude_pid || null,
    terminal: terminal || existing.terminal || null,
    registered_at: existing.registered_at || nowSeconds(),
    last_seen: nowSeconds(),
    last_auto_resume: existing.last_auto_resume || 0,
  })
}

export const touchSession = (sessionId) => {
  const meta = readMeta(sessionId)
  if (!meta) return null
  return writeMeta({ ...meta, last_seen: nowSeconds() })
}

export const forgetSession = (sessionId) => {
  rmSync(paths.sessionDir(sessionId), { recursive: true, force: true })
}
