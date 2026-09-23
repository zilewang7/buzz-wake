import { randomUUID } from 'node:crypto'
import { color } from '../args.mjs'
import { nowSeconds } from '../util.mjs'
import { loadConfig, resumePolicyFor } from '../config.mjs'
import { readMeta, allSessions, sessionState, writeMeta, processIsClaude } from '../sessions.mjs'
import { resolveClaudePid } from './internal.mjs'
import { deliver } from '../deliver.mjs'
import { route } from '../router.mjs'

const syntheticEvent = (overrides) => ({
  id: randomUUID().replace(/-/g, ''),
  kind: 9,
  received_at: nowSeconds(),
  acp_session: 'buzzwake-test',
  scope: 'channel',
  channel_id: null,
  channel_label: 'buzzwake 自测',
  author_pubkey: null,
  author_label: 'buzzwake test',
  time: new Date().toISOString(),
  content: '这是 buzzwake test 生成的测试消息，看到它说明管道是通的。',
  reply_to: null,
  text: 'buzzwake 自测消息',
  ...overrides,
})

// A fallback-routed message never opens a window by design (see deliver.mjs), so
// a synthetic event on a made-up channel can NEVER reach mode=auto — --dormant
// would quietly verify the notify branch while claiming to test auto-resume.
// Borrow the channel from the rule that actually binds this session.
const boundChannel = (config, meta) => {
  const selectors = new Set([`session:${meta.session_id}`, `cwd:${meta.cwd}`])
  if (meta.label) selectors.add(`label:${meta.label}`)
  const hit = config.rules.find(
    (rule) => (rule.channel || '*') !== '*' && (rule.to || []).some((s) => selectors.has(s)),
  )
  return hit?.channel || null
}

// --dormant fakes a dead process so the resume path can be exercised without
// actually closing the terminal.
export const cmdTest = (args) => {
  const config = loadConfig()
  const sessionId = args.session || process.env.CLAUDE_CODE_SESSION_ID

  if (args.dormant) {
    const meta = sessionId ? readMeta(sessionId) : allSessions().find((s) => s.state !== 'gone')
    if (!meta) {
      console.error(color.bad('找不到可用的 session，先在一个 Claude 会话里跑 buzzwake bind'))
      return 1
    }
    // Faking dormancy on a session that is actually running means mode=auto
    // resumes the SAME session id into a second window, so two claude processes
    // end up sharing it (only one of them wins the watcher lock).
    if (sessionState(meta) === 'live') {
      console.log(
        color.warn(`⚠ ${meta.session_id.slice(0, 8)} 其实是活的 —— mode=auto 会为它再开一个窗口，测完记得关掉`),
      )
    }

    const saved = { pid: meta.claude_pid, cooldown: meta.last_auto_resume }
    writeMeta({ ...meta, claude_pid: 999999, last_auto_resume: 0 })
    console.log(color.dim(`把 ${meta.session_id.slice(0, 8)} 临时伪装成 dormant…`))

    const bound = boundChannel(config, meta)
    const isUuid = bound !== null && /^[0-9a-f-]{36}$/i.test(bound)
    const event = syntheticEvent({
      channel_id: isUuid ? bound.toLowerCase() : null,
      // For name-based rules matchesChannel does a substring match on the label.
      channel_label: bound !== null && !isUuid ? `buzzwake 自测（dormant）${bound}` : 'buzzwake 自测（dormant）',
      content: '这是 dormant 场景自测：如果配置为 auto，应当自动开一个终端窗口恢复这个 session。',
    })

    // Say which branch this run will take instead of making the reader grep logs
    // — the auto→notify downgrade is exactly what people get wrong here.
    const { rule } = route(config, event)
    const mode = resumePolicyFor(config, rule).mode
    console.log(color.dim(`路由: ${rule ? '显式规则' : '兜底'} · resume.mode=${mode}`))
    if (!rule && mode === 'auto') {
      console.log(color.warn('这个 session 没绑定到具体频道，兜底路由按设计永不自动开窗 —— 本次只会验到 notify'))
      console.log(color.dim('先跑 buzzwake bind --channel <名字> 再来测 auto'))
    }

    const result = deliver(event)

    // Never write a corpse back: saved.pid can already be stale before we start
    // (a duplicate `claude -r` window registers its own pid, then exits), and
    // restoring it blindly re-poisons the record on every run — which makes the
    // router treat this live session as dormant.
    const restored = processIsClaude(saved.pid) ? saved.pid : resolveClaudePid() || saved.pid
    writeMeta({ ...readMeta(meta.session_id), claude_pid: restored, last_auto_resume: saved.cooldown })
    console.log(`投递结果: ${JSON.stringify(result)}`)
    console.log(color.dim('看 buzzwake logs --router 了解具体走了哪条分支'))
    return 0
  }

  const event = syntheticEvent({})
  const { rule, targets } = route(config, event)
  console.log(`匹配规则: ${rule ? JSON.stringify(rule.to) : `兜底 ${config.default}`}`)
  if (targets.length === 0) {
    console.error(color.bad('没有任何目标 session —— 消息会被丢弃。'))
    console.error(color.dim('跑 buzzwake bind --channel <名字> 绑定当前 session。'))
    return 1
  }
  for (const target of targets) {
    console.log(`  → ${target.session.session_id.slice(0, 8)} (${sessionState(target.session)})`)
  }

  deliver(event)
  const self = sessionId && targets.some((t) => t.session.session_id === sessionId)
  console.log()
  console.log(color.ok('已投递。'))
  if (self) console.log('当前 session 应当在几秒内被唤醒并看到这条测试消息。')
  return 0
}
