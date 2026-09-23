import { execFileSync } from 'node:child_process'
import { color } from '../args.mjs'
import { loadConfig, saveConfig, upsertRule, removeTargetFromRules, RESUME_MODES } from '../config.mjs'
import { readMeta, writeMeta, registerSession, allSessions } from '../sessions.mjs'
import { resolveClaudePid } from './internal.mjs'
import { readEnvFile } from '../install-info.mjs'

const currentSessionId = () => process.env.CLAUDE_CODE_SESSION_ID || null

// Channel names are nicer to type than UUIDs; resolve to a UUID when we can so
// the rule keeps working after a rename.
const resolveChannel = (input) => {
  if (!input) return null
  if (/^[0-9a-f-]{36}$/i.test(input)) return { id: input.toLowerCase(), name: null }
  try {
    const env = { ...process.env, ...readEnvFile() }
    const raw = execFileSync('buzz', ['--format', 'compact', 'channels', 'list'], {
      encoding: 'utf8',
      env,
    })
    const channels = JSON.parse(raw)
    const hit = channels.find((c) => c.name?.toLowerCase() === input.toLowerCase())
      || channels.find((c) => c.name?.toLowerCase().includes(input.toLowerCase()))
    if (hit) return { id: hit.channel_id, name: hit.name }
  } catch {
    // relay unreachable or buzz missing — fall back to matching by name text
  }
  return { id: null, name: input }
}

export const cmdBind = (args) => {
  const sessionId = args.session || currentSessionId()
  if (!sessionId) {
    console.error(color.bad('拿不到当前 session id。'))
    console.error('在 Claude Code 会话里跑本命令即可自动识别；或显式传 --session <id>。')
    return 1
  }

  const meta =
    readMeta(sessionId) ||
    registerSession({ sessionId, cwd: process.cwd(), claudePid: resolveClaudePid() })

  // Default to newest: compact / fork / claude -c / reopen all mint a new session
  // id, and a pinned binding then keeps "successfully" delivering into a
  // transcript nobody will reopen — the failure looks like a green log. Unlike
  // cwd: it resolves to exactly one session instead of fanning out to every
  // window in the directory. --pin restores the old exact-id behaviour.
  // label: is the durable handle for "that one window" — the rule names a role
  // and the session claims it, so reopening in a new session id moves the claim
  // instead of rewriting routes.json the way session: would.
  const labelName = args.label ? String(args.label).trim() : null
  const bindKind = args.pin ? 'session' : args.cwd ? 'cwd' : labelName ? 'label' : 'newest'
  const target =
    bindKind === 'session'
      ? `session:${sessionId}`
      : bindKind === 'cwd'
        ? `cwd:${meta.cwd}`
        : bindKind === 'label'
          ? `label:${labelName}`
          : 'newest'

  const config = loadConfig()

  // A role has exactly one holder. label: resolves to every session carrying the
  // name, so leaving it on the previous holder quietly turns the rule back into
  // the fan-out it was chosen to avoid — claiming takes it away from them.
  const displaced = labelName
    ? allSessions().filter((s) => s.label === labelName && s.session_id !== sessionId)
    : []
  for (const other of displaced) writeMeta({ ...readMeta(other.session_id), label: null })

  if (labelName) writeMeta({ ...readMeta(sessionId), label: labelName })
  writeMeta({ ...readMeta(sessionId), bind_kind: bindKind })

  // Every selector here is also valid as the global fallback, and gating this on
  // session: would have made --default a silent no-op the moment newest became
  // the default binding kind.
  if (args.default) config.default = target

  const channel = resolveChannel(args.channel ? String(args.channel) : null)
  const rule = { channel: channel ? channel.id || channel.name : '*', to: [target] }
  if (args.from) rule.from = String(args.from).toLowerCase()
  if (args.resume) {
    if (!RESUME_MODES.includes(String(args.resume))) {
      console.error(color.bad(`--resume 只能是 ${RESUME_MODES.join(' | ')}`))
      return 1
    }
    rule.resume = { mode: String(args.resume) }
  }

  // Keep any target already bound to this channel instead of replacing it —
  // except newest, which cannot coexist with a narrower target: it resolves to
  // whatever window was last active, so it re-admits exactly the drift that
  // session:/cwd: were chosen to exclude. Binding narrower is a request to stop
  // that drift, so treat it as superseding rather than adding.
  const existing = config.rules.find(
    (r) => (r.channel || '*') === rule.channel && (r.from || null) === (rule.from || null),
  )
  const previous = existing?.to || []
  const superseded = bindKind === 'newest' ? [] : previous.filter((t) => t === 'newest')
  if (existing) {
    rule.to = Array.from(new Set([...previous.filter((t) => !superseded.includes(t)), target]))
  }

  upsertRule(config, { ...existing, ...rule })
  saveConfig(config)

  const where = channel?.name ? `${channel.name} (${channel.id || '按名字匹配'})` : rule.channel
  console.log(`${color.ok('已绑定')} 频道 ${color.bold(where)} → ${color.bold(target)}`)

  if (superseded.length > 0) {
    console.log(color.dim(`  已摘掉 newest —— 它会绕过 ${target} 投给最近活跃的窗口`))
  }
  if (displaced.length > 0) {
    const who = displaced.map((s) => s.session_id.slice(0, 8)).join(', ')
    console.log(color.dim(`  标签 ${labelName} 从 ${who} 移交过来，它们不再收这个频道`))
  }

  // Targets accumulate by design (multi-session fan-out), which is a trap when
  // you came here to REPLACE a binding that went stale — both keep receiving,
  // one of them into a transcript nobody reopens. Report every leftover kind:
  // a stale cwd: fans out just as silently as a stale session:.
  const leftovers = rule.to.filter((t) => t !== target)
  if (leftovers.length > 0) {
    console.log(color.warn(`  ⚠ 这个频道还绑着 ${leftovers.join(', ')}，它们会一起收到消息`))
    console.log(color.dim('     想只保留刚绑的这个: buzzwake unbind --session <旧 id> 或直接改 routes.json'))
  }

  // newest ignores cwd entirely, so with several projects open the channel can
  // land in an unrelated one. Nothing can detect that after the fact — the
  // delivery is technically correct — so say it here, while the dirs are known.
  if (bindKind === 'newest') {
    const elsewhere = allSessions().filter((s) => s.state === 'live' && s.cwd !== meta.cwd)
    if (elsewhere.length > 0) {
      const dirs = [...new Set(elsewhere.map((s) => s.cwd))].join(', ')
      console.log(color.warn(`  ⚠ newest 不看目录，另有活会话在 ${dirs}`))
      console.log(color.dim('     它更活跃时这个频道的消息会投给它；要钉住当前会话用 --pin'))
    }
  }
  if (rule.resume) console.log(`  resume 模式: ${rule.resume.mode}`)
  if (args.label) console.log(`  标签: ${args.label}`)
  console.log(color.dim('提示: buzzwake routes 查看全部规则'))
  return 0
}

export const cmdUnbind = (args) => {
  const wanted = args.session || currentSessionId()
  if (!wanted) {
    console.error(color.bad('拿不到当前 session id，请传 --session <id>'))
    return 1
  }

  // resume and forget both take a prefix, so people type one here too. readMeta
  // only answers to a full id: a prefix left meta null, so unbind removed just
  // the nonexistent session:<prefix> and still printed 已解绑, while the real
  // cwd:/label: target stayed and kept receiving.
  const matches = allSessions().filter((session) => session.session_id.startsWith(wanted))
  if (matches.length > 1) {
    console.error(color.bad(`前缀 ${wanted} 匹配到 ${matches.length} 个 session，请写长一点`))
    return 1
  }
  // An unregistered id still gets to run: `forget` drops the session dir without
  // touching routes.json, so removing the session:<id> it left behind is the
  // only way to clean that up.
  const sessionId = matches[0]?.session_id || wanted
  const meta = matches.length === 1 ? readMeta(sessionId) : null

  const targets = [`session:${sessionId}`]
  if (meta?.cwd) targets.push(`cwd:${meta.cwd}`)
  if (meta?.bind_kind === 'label' && meta.label) targets.push(`label:${meta.label}`)
  // Remove what this session's bind put there. Without this newest has no CLI
  // exit at all: it matches no session-specific selector, so unbind left it
  // behind and the channel kept waking whichever window was last active.
  if (meta?.bind_kind === 'newest') targets.push('newest')

  const config = loadConfig()
  const bound = targets.filter((target) =>
    config.rules.some((rule) => (rule.to || []).includes(target)),
  )
  // Say nothing happened when nothing happened — the old unconditional 已解绑 is
  // what made the prefix bug invisible.
  if (bound.length === 0) {
    console.error(color.bad(`${sessionId} 没有绑定任何频道，routes.json 未改动`))
    if (matches.length === 0) console.error(color.dim('这个 id 也没注册过，跑 buzzwake sessions 看看'))
    return 1
  }
  for (const target of bound) removeTargetFromRules(config, target)
  saveConfig(config)
  console.log(`${color.ok('已解绑')} ${sessionId} —— 摘掉 ${bound.join(', ')}`)
  return 0
}

export const cmdRoutes = (args) => {
  const config = loadConfig()
  if (args.json) {
    console.log(JSON.stringify(config, null, 2))
    return 0
  }
  console.log(color.bold('全局'))
  console.log(`  兜底目标   : ${config.default}`)
  console.log(`  关注事件   : kind ${config.kinds.join(', ')}`)
  console.log(`  resume 默认: ${config.resume_defaults.mode} / 终端 ${config.resume_defaults.terminal} / 冷却 ${config.resume_defaults.cooldown_seconds}s / 每小时上限 ${config.resume_defaults.max_windows_per_hour}`)
  console.log()
  console.log(color.bold(`规则 (${config.rules.length})`))
  if (config.rules.length === 0) console.log(color.dim('  还没有规则，跑 buzzwake bind --channel <名字> 绑一个'))
  config.rules.forEach((rule, index) => {
    const from = rule.from ? ` from=${rule.from.slice(0, 12)}…` : ''
    const resume = rule.resume?.mode ? ` resume=${rule.resume.mode}` : ''
    console.log(`  ${index + 1}. channel=${rule.channel}${from}${resume}`)
    for (const target of rule.to || []) console.log(`       → ${target}`)
  })
  return 0
}
