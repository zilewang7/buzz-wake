import { execFileSync } from 'node:child_process'
import { renameSync, mkdirSync, writeFileSync, rmSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { paths } from '../paths.mjs'
import { ensureDir, truncate, logLine, nowSeconds, readJson } from '../util.mjs'
import { registerSession, touchSession, readPending, readMeta, writeMeta } from '../sessions.mjs'
import { formatEvent, notifyDesktop, REPLY_CONVENTION } from '../resume.mjs'
import { communicationRulesHint } from '../communication-rules.mjs'

const MAX_HOOK_OUTPUT = 9000
// The watcher can only be armed by a hook, and a hook lives at most as long as
// its configured timeout — so this is the longest a session can stay reachable
// while nobody talks to it. Nothing re-arms it until the next Stop, so whatever
// this misses sits in the spool while the log cheerfully says "queued".
//
// 6h was sized for a working day and measured too short: after it expired this
// session went 17.1h unwatched overnight, and a real message landed in another
// session's 10.8h gap, delivered only
// because PostToolUse happened to catch it mid-turn. 24h covers overnight and a
// weekend day. Cost is one resident node per session — measured 45MB RSS and
// ~0.2% of a core, so memory is the only thing that scales with this number.
// setup.mjs sets the hook timeout above this.
const WATCH_SECONDS = Number.parseInt(process.env.BUZZWAKE_WATCH_SECONDS || '86400', 10)
const POLL_MS = 1000

export const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

// CLAUDE_PID is normally inherited by hooks; walking the ancestry is the
// fallback so a session is never registered without a liveness handle.
const findClaudePid = (startPid) => {
  let pid = startPid
  for (let depth = 0; depth < 8 && pid && pid !== 1; depth += 1) {
    try {
      const line = execFileSync('ps', ['-o', 'ppid=,command=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim()
      const match = line.match(/^\s*(\d+)\s+(.*)$/)
      if (!match) return null
      if (/(^|\/)claude(\s|$)/.test(match[2])) return pid
      pid = Number.parseInt(match[1], 10)
    } catch {
      return null
    }
  }
  return null
}

export const resolveClaudePid = () => {
  const fromEnv = Number.parseInt(process.env.CLAUDE_PID || '', 10)
  if (fromEnv > 0) return fromEnv
  return findClaudePid(process.ppid)
}

// Move pending -> consumed and return the text to hand back to Claude.
//
// Two consumers race here now: the watcher between turns and the PostToolUse
// hook during one. Per-file rename is atomic so nothing can be delivered twice,
// but an unlocked race splits one batch across two deliveries — the reader gets
// half a conversation next to a tool result and the other half a turn later.
// Losing the race means returning null: the other consumer is about to report
// these messages, so there is nothing to say.
const drain = (sessionId) => {
  const lock = acquireLock(`drain-${sessionId}`)
  if (!lock) return null
  try {
    const items = readPending(sessionId)
    if (items.length === 0) return null
    ensureDir(paths.sessionConsumed(sessionId))
    const moved = items.filter((item) => {
      try {
        renameSync(item.path, join(paths.sessionConsumed(sessionId), item.name))
        return true
      } catch {
        return false // vanished under us; whoever took it will report it
      }
    })
    if (moved.length === 0) return null
    const body = moved.map(({ event }) => formatEvent(event)).join('\n')
    // The convention goes above the body on purpose: truncate() cuts from the
    // end, and a long batch would otherwise drop the very rule it needs.
    const head = `Buzz 有 ${moved.length} 条新消息：\n${REPLY_CONVENTION}\n${communicationRulesHint()}`
    return { items: moved, text: truncate(`${head}${body}`, MAX_HOOK_OUTPUT) }
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

// A turn is in flight from UserPromptSubmit until the watcher re-arms at Stop.
// The ceiling is what keeps an abandoned marker — an aborted turn whose Stop
// never fired — from muting the session forever: a stuck marker costs at most
// an hour of the old deafness instead of being permanent, and no real turn runs
// that long.
const TURN_MARKER_MAX_MS = 3600 * 1000

const turnActive = (sessionId) => {
  try {
    return Date.now() - statSync(paths.sessionTurnActive(sessionId)).mtimeMs < TURN_MARKER_MAX_MS
  } catch {
    return false
  }
}

const clearTurnMarker = (sessionId) => {
  rmSync(paths.sessionTurnActive(sessionId), { force: true })
}

const notifyForItems = (items) => {
  const first = items[0].event
  const where = first.channel_label || 'Buzz'
  const who = first.author_label || (first.author_pubkey || '').slice(0, 8) || '有人'
  const more = items.length > 1 ? `（共 ${items.length} 条）` : ''
  notifyDesktop('Buzz 新消息', `${where} · ${who}${more}: ${truncate((first.content || '').replace(/\s+/g, ' '), 100)}`)
}

export const cmdInternalRegister = async () => {
  const hook = await readStdin()
  const sessionId = hook.session_id
  if (!sessionId) return 0

  registerSession({
    sessionId,
    cwd: hook.cwd || process.cwd(),
    claudePid: resolveClaudePid(),
  })

  // Anything queued while this session was closed gets handed over on start.
  const drained = drain(sessionId)
  if (drained) {
    process.stdout.write(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `[buzz-wake 补投]\n${drained.text}`,
        },
      })}\n`,
    )
  }
  return 0
}

// mkdir is the portable atomic lock (macOS has no flock(1)).
const acquireLock = (name) => {
  const lock = join(paths.locksDir, name)
  ensureDir(paths.locksDir)
  const claim = () => {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), String(process.pid))
      return true
    } catch {
      return false
    }
  }
  if (claim()) return lock

  const holder = Number.parseInt((() => {
    try {
      return readFileSync(join(lock, 'pid'), 'utf8')
    } catch {
      return ''
    }
  })(), 10)
  if (holder > 0) {
    try {
      process.kill(holder, 0)
      return null // a watcher for this session is already armed
    } catch {
      // holder is dead, take over
    }
  }
  rmSync(lock, { recursive: true, force: true })
  return claim() ? lock : null
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const claudeAlive = (pid) => {
  if (!pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Wakes are already self-limiting: drain() consumes before exit 2, so no
// message can ever wake twice. This breaker exists only to contain a bug
// upstream that would re-queue events in a loop. It is checked BEFORE draining
// so a tripped breaker leaves the messages in pending instead of eating them.
const WAKE_WINDOW_SECONDS = 60
const MAX_WAKES_PER_WINDOW = 10

const recentWakes = (sessionId) => {
  const cutoff = nowSeconds() - WAKE_WINDOW_SECONDS
  return (readMeta(sessionId)?.wake_times || []).filter((ts) => ts >= cutoff)
}

const recordWake = (sessionId) => {
  const meta = readMeta(sessionId)
  if (!meta) return
  writeMeta({ ...meta, wake_times: [...recentWakes(sessionId), nowSeconds()] })
}

// asyncRewake watcher: polls this session's own pending/ on local disk and
// wakes Claude with exit 2.
//
// Deliberately does NOT bail on hook.stop_hook_active. That flag is true for
// exactly the turn a previous wake started, so bailing on it left the session
// deaf from the first delivery until the next human-typed message — the
// mechanism appeared to work, then silently stopped.
export const cmdInternalWatch = async () => {
  const hook = await readStdin()
  const sessionId = hook.session_id
  if (!sessionId) return 0

  // Stop means the turn is over, so it is the one event allowed to clear the
  // marker — SessionStart also fires on compact, which can land mid-turn, and
  // clearing there would hand the watcher permission to interrupt.
  //
  // Before the lock check, not after: when a watcher from an earlier Stop is
  // still armed, the early return below is all that runs, and a marker left
  // standing would mute the session for the whole idle stretch that follows.
  if (hook.hook_event_name === 'Stop') clearTurnMarker(sessionId)

  const lock = acquireLock(`watch-${sessionId}`)
  if (!lock) {
    logLine(paths.routerLog, `[watcher] ${sessionId.slice(0, 8)} 已有 watcher 在监听，跳过`)
    return 0
  }

  const cleanup = () => rmSync(lock, { recursive: true, force: true })
  process.on('exit', cleanup)
  process.on('SIGTERM', () => process.exit(0))

  touchSession(sessionId)
  const meta = readMeta(sessionId)

  // claude_pid is written once, at registration — but `claude -c` / --resume
  // reuses the session id in a NEW process and SessionStart does not fire for
  // it, so the stored pid points at a corpse. That made every Stop bail on the
  // liveness check below (session silently deaf) while the router simultaneously
  // saw the session as dormant and would resume it into a second window. This
  // hook is a child of the live claude, so re-derive and heal the record.
  const claudePid = resolveClaudePid() || meta?.claude_pid || null
  if (meta && claudePid !== meta.claude_pid) {
    logLine(
      paths.routerLog,
      `[watcher] ${sessionId.slice(0, 8)} claude pid ${meta.claude_pid || '?'} → ${claudePid}，已修正（session 被 -c/--resume 接管）`,
    )
    writeMeta({ ...meta, claude_pid: claudePid })
  }

  // Healing once at arm time is not enough: this watcher stays armed for
  // WATCH_SECONDS, and another process can rewrite the record mid-flight — a
  // duplicate `claude -r` window's SessionStart registers its own pid, then
  // exits, leaving a corpse. The router would then treat this live session as
  // dormant and resume it into yet another window. Costs nothing: the loop
  // already reads meta every poll for the wake breaker.
  let reasserted = false
  const reassertPid = () => {
    const current = readMeta(sessionId)
    if (!current || !claudePid || current.claude_pid === claudePid) return
    if (!reasserted) {
      reasserted = true
      logLine(
        paths.routerLog,
        `[watcher] ${sessionId.slice(0, 8)} 的 claude_pid 被改成 ${current.claude_pid}，夺回 ${claudePid}`,
      )
    }
    writeMeta({ ...current, claude_pid: claudePid })
  }

  const deadline = nowSeconds() + WATCH_SECONDS
  logLine(paths.routerLog, `[watcher] armed ${sessionId.slice(0, 8)} ${WATCH_SECONDS}s`)

  while (nowSeconds() < deadline) {
    if (!claudeAlive(claudePid)) {
      logLine(paths.routerLog, `[watcher] ${sessionId.slice(0, 8)} 的 claude 已退出，停止监听`)
      return 0
    }
    reassertPid()
    if (recentWakes(sessionId).length >= MAX_WAKES_PER_WINDOW) {
      logLine(
        paths.routerLog,
        `[watcher] 熔断 ${sessionId.slice(0, 8)}：${WAKE_WINDOW_SECONDS}s 内唤醒 ${MAX_WAKES_PER_WINDOW} 次，消息留在 pending`,
      )
      return 0
    }
    // This watcher outlives the Stop that armed it, so without this check it
    // polls straight through the next turn and exit 2 lands mid-work — an
    // interruption, not a delivery. During a turn PostToolUse is the courier;
    // the watcher's job is only the idle stretch between turns.
    if (turnActive(sessionId)) {
      await sleep(POLL_MS)
      continue
    }
    const drained = drain(sessionId)
    if (drained) {
      recordWake(sessionId)
      notifyForItems(drained.items)
      logLine(paths.routerLog, `[watcher] delivered ${drained.items.length} to ${sessionId}`)
      process.stderr.write(`${drained.text}\n`)
      cleanup()
      process.exit(2) // exit 2 is what wakes Claude
    }
    await sleep(POLL_MS)
  }
  logLine(paths.routerLog, `[watcher] ${sessionId.slice(0, 8)} 监听到期（${WATCH_SECONDS}s 无消息）`)
  return 0
}

// PostToolUse. The session id arrives as an argument because hooks/buzz-drain.sh
// already read stdin to decide whether starting node was worth it at all.
//
// additionalContext puts the message next to the tool result — Claude reads it
// on its way to the next step instead of being woken out of the current one, so
// mid-turn delivery costs at most one tool call and never cuts anything short.
export const cmdInternalDrain = async (args) => {
  const sessionId = args._[1]
  if (!sessionId) return 0
  const drained = drain(sessionId)
  if (!drained) return 0
  logLine(paths.routerLog, `[drain] delivered ${drained.items.length} to ${sessionId} (turn 中)`)
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext: `[buzz-wake]\n${drained.text}`,
      },
    })}\n`,
  )
  return 0
}

export const cmdInternalTouch = async () => {
  const hook = await readStdin()
  if (hook.session_id) touchSession(hook.session_id)
  return 0
}

// Read by run-sidecar.sh so `peer add` takes effect on restart without
// regenerating the launchd plist.
export const cmdInternalPeers = async () => {
  const install = readJson(paths.install, {}) || {}
  const peers = Array.isArray(install.peers) ? install.peers : []
  process.stdout.write(peers.map((peer) => peer.pubkey).join(','))
  return 0
}

// Same reason as internal-peers: the author gate is read at run time, so editing
// install.json and restarting is enough — no reinstall needed.
export const cmdInternalRespondTo = async () => {
  const install = readJson(paths.install, {}) || {}
  process.stdout.write(install.respond_to || 'owner-only')
  return 0
}
