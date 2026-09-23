import { paths } from './paths.mjs'
import { dropFile, logLine, nowSeconds, truncate } from './util.mjs'
import { loadConfig } from './config.mjs'
import { route } from './router.mjs'
import { forgetSession, watcherArmed } from './sessions.mjs'
import { autoResumeGate, performResume, notifyDesktop, recordSkip, GATE_REASONS } from './resume.mjs'

const log = (message) => logLine(paths.routerLog, `[router] ${message}`)

const spoolName = (event) => `${String(event.received_at).padStart(12, '0')}-${event.id}.json`

const enqueue = (sessionId, event) => {
  dropFile(paths.sessionPending(sessionId), spoolName(event), JSON.stringify(event, null, 2))
}

const summary = (event) => {
  const where = event.channel_label || event.channel_id || 'Buzz'
  const who = event.author_label || (event.author_pubkey || '').slice(0, 8) || '有人'
  return `${where} · ${who}: ${truncate((event.text || '').replace(/\s+/g, ' '), 120)}`
}

const handleDormant = ({ session, policy, viaFallback }, event) => {
  enqueue(session.session_id, event)

  // A message reaching a session through the global fallback must never open a
  // window on its own — only an explicit binding earns that.
  const mode = viaFallback && policy.mode === 'auto' ? 'notify' : policy.mode

  if (mode === 'off') {
    log(`dormant ${session.session_id} mode=off, queued for next start`)
    return
  }

  if (mode === 'notify' || mode === 'ask') {
    const hint = mode === 'ask' ? `\n运行: buzzwake resume ${session.session_id.slice(0, 8)}` : ''
    notifyDesktop('Buzz 新消息（session 未运行）', summary(event) + hint)
    // Name the downgrade — otherwise the log reads mode=notify while the policy
    // says auto, and you go looking for a config bug that isn't there.
    const why = policy.mode !== mode ? `（${policy.mode} 因兜底路由降级）` : ''
    log(`dormant ${session.session_id} mode=${mode}${why}, notified`)
    return
  }

  const gate = autoResumeGate(session, policy)
  if (!gate.ok) {
    recordSkip(session.session_id, gate.reason)
    notifyDesktop('Buzz 新消息（未自动恢复）', `${GATE_REASONS[gate.reason] || gate.reason}\n${summary(event)}`)
    log(`dormant ${session.session_id} auto blocked by ${gate.reason}`)
    return
  }

  try {
    const result = performResume(session, policy, { title: `buzz: ${event.channel_label || 'mention'}` })
    notifyDesktop('Buzz 唤起了一个 session', summary(event))
    log(`dormant ${session.session_id} auto resumed (${result.messages} 条)`)
  } catch (error) {
    recordSkip(session.session_id, 'launch_failed')
    notifyDesktop('Buzz 自动恢复失败', String(error?.message || error))
    log(`resume failed for ${session.session_id}: ${error?.stack || error}`)
  }
}

export const deliver = (event) => {
  const config = loadConfig()
  const { rule, targets, staleSelectors } = route(config, event)
  // relay→spool latency, so the log answers "how long did the push take" alone.
  const lag = event.created_at ? ` lag=${event.received_at - event.created_at}s` : ''
  // A bare targets=0 sent someone digging for half an hour, so name the cause.
  const why = staleSelectors?.length > 0 ? ` stale=${staleSelectors.join(',')}` : ''
  log(`event ${event.id} channel=${event.channel_id || event.channel_label || '?'}${lag} rule=${rule ? JSON.stringify(rule.to) : 'default'} targets=${targets.length}${why}`)

  if (targets.length === 0) {
    if (config.notify_desktop) {
      const hint = staleSelectors?.length > 0 ? `\n绑定已失效: ${staleSelectors.join(', ')}` : ''
      notifyDesktop('Buzz 新消息（无匹配 session）', summary(event) + hint)
    }
    return { delivered: 0 }
  }

  let delivered = 0
  for (const target of targets) {
    const { session } = target
    if (session.state === 'gone') {
      log(`target ${session.session_id} is gone, forgetting`)
      forgetSession(session.session_id)
      continue
    }
    if (session.state === 'live') {
      enqueue(session.session_id, event)
      // A live session with no armed watcher still gets the message queued, and
      // the log still says queued — that pairing cost three hours of digging
      // once. It is only reachable through PostToolUse now, so it hears nothing
      // until it happens to run a tool. Say so, and fall back to the desktop.
      const armed = watcherArmed(session.session_id)
      log(`queued for live session ${session.session_id}${armed ? '' : ' (无 watcher，只能等它下次跑工具)'}`)
      if (!armed && config.notify_desktop) {
        notifyDesktop('Buzz 新消息（session 没在监听）', summary(event))
      }
      delivered += 1
      continue
    }
    handleDormant(target, event)
    delivered += 1
  }
  return { delivered, at: nowSeconds() }
}
