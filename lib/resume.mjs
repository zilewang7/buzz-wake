import { readFileSync, renameSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { paths } from './paths.mjs'
import { ensureDir, appendJsonl, nowSeconds, truncate, logLine, writeAtomic } from './util.mjs'
import { writeMeta, readPending } from './sessions.mjs'
import { communicationRulesHint } from './communication-rules.mjs'
import { writeLauncher, openTerminal, screenIsLocked } from './terminals.mjs'

// Buzz renders --reply-to as a collapsed tree: every level has to be clicked
// open, so a channel read top to bottom no longer contains the conversation.
// Replies go back as top-level channel messages instead.
//
// The two follow-ups are not decoration. A flat message carries no reply e tag,
// so the p tag is the only thing left that gate.mjs can pass on. `@Name` in the
// body does produce one when it resolves to exactly one member — the CLI says so
// itself — but a display name with a space in it ("code reviewer") is the
// shape that goes ambiguous, and `--mention <hex>` is the only guarantee. The
// short id is what replaces the tree: it is the only thing left saying which
// message this answers.
//
// This ships with every delivery rather than living in the skill alone, because
// it has to be in context at the moment the reply is written.
export const REPLY_CONVENTION = [
  '回复约定 —— 频道消息一律平铺，不要嵌套：',
  '- 用 `buzz messages send --channel <频道>` 发顶层消息，**不要带 `--reply-to`**（只有 forum comment kind 45003 例外，协议强制要）',
  '- **`@` 对方，并用 `--mention <对方 hex>` 显式指定**：平铺消息没有 e tag，唤醒只剩 p tag 一条路；正文里的 `@名字` 靠 CLI 匹配频道成员，带空格的显示名容易歧义',
  '- 正文首行注明在回哪条：`@<对方> 回 <事件 id 前 8 位>：…`',
  '- 每条消息头部的 `回复:` 已把频道、`--mention` 和首行填好，正文接着首行写、经 heredoc 从 stdin 进；**不要把正文拼进 `--content "…"`**，反引号和 `$` 在双引号里会被 shell 展开',
].join('\n')

const PROMPT_HEADER = [
  '你有新的 Buzz 消息 —— 这个 session 是 buzz-wake 自动恢复起来的。',
  '先读下面的消息，判断要不要回复；要回复就用 buzz CLI 发回原频道。',
  '',
  REPLY_CONVENTION,
  '',
].join('\n')

// The convention asks the writer to remember two things, and both are already
// known at delivery time: channel id, sender hex and event id all arrive with
// the event. So hand over the finished command instead of a rule. The body goes
// in through a quoted heredoc rather than `--content "…"`: channel messages
// carry backticks, `$` and quotes, and inside double quotes the shell would
// expand them — the same hazard README pit 15 closed on our own side. Only
// kind 9 is filled in; forum kinds need --reply-to and are the convention's
// stated exception. A template we cannot fill correctly is worse than none.
//
// The terminator is not the customary EOF on purpose: a body that quotes any
// shell heredoc has a line reading EOF, which would end ours early — sending a
// truncated message and running the rest of the body as commands.
const replyCommand = (event) => {
  if (event.kind !== 9 || !event.id || !event.channel_id || !event.author_pubkey) return null
  const name = event.author_label || event.author_pubkey.slice(0, 8)
  return [
    `回复: buzz messages send --channel ${event.channel_id} --mention ${event.author_pubkey} --content - <<'BUZZ_EOF'`,
    `@${name} 回 ${event.id.slice(0, 8)}：`,
    'BUZZ_EOF',
  ].join('\n')
}

export const formatEvent = (event) => {
  const where = event.channel_label || event.channel_id || '未知频道'
  const who = event.author_label || event.author_pubkey || '未知作者'
  // The full id is in the raw chunk below, buried between Kind and Tags. The
  // reply convention needs it in the first eight characters, so surface it.
  const what = (event.id || '').slice(0, 8) || '未知事件'
  const reply = replyCommand(event)
  // Header before body: truncate() cuts from the end, so a long message loses
  // its tail, never the command that answers it.
  return [
    '---',
    `频道: ${where}`,
    `来自: ${who}`,
    `事件: ${what}`,
    ...(reply ? [reply] : []),
    '',
    truncate(event.text || '', 4000),
    '',
  ].join('\n')
}

// pending/ is the single source of truth. The resume prompt is generated from
// it and the files are consumed in the same step, so a message is never
// delivered twice.
export const drainPendingIntoPrompt = (sessionId) => {
  const pending = readPending(sessionId)
  if (pending.length === 0) return null

  const body = PROMPT_HEADER + communicationRulesHint() + pending.map(({ event }) => formatEvent(event)).join('\n')
  const file = paths.sessionResumePrompt(sessionId)
  writeAtomic(file, body)

  ensureDir(paths.sessionConsumed(sessionId))
  for (const item of pending) {
    renameSync(item.path, join(paths.sessionConsumed(sessionId), item.name))
  }
  return { file, count: pending.length }
}

export const clearResumePrompt = (sessionId) =>
  rmSync(paths.sessionResumePrompt(sessionId), { force: true })

const withinQuietHours = (quietHours, date = new Date()) => {
  if (!Array.isArray(quietHours) || quietHours.length !== 2) return false
  const toMinutes = (text) => {
    const [hour, minute] = String(text).split(':').map(Number)
    return hour * 60 + (minute || 0)
  }
  const now = date.getHours() * 60 + date.getMinutes()
  const start = toMinutes(quietHours[0])
  const end = toMinutes(quietHours[1])
  return start <= end ? now >= start && now < end : now >= start || now < end
}

const windowsOpenedSince = (since) => {
  try {
    return readFileSync(paths.resumeLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter((entry) => entry && entry.opened && entry.at >= since).length
  } catch {
    return 0
  }
}

export const GATE_REASONS = {
  quiet_hours: '在勿扰时段内',
  screen_locked: '屏幕已锁定',
  cooldown: '距上次自动开窗未过冷却期',
  hourly_limit: '已达每小时开窗上限',
}

// Four gates against window explosion, checked in report order.
export const autoResumeGate = (meta, policy) => {
  const now = nowSeconds()
  if (policy.quiet_hours && withinQuietHours(policy.quiet_hours))
    return { ok: false, reason: 'quiet_hours' }
  if (policy.skip_when_locked && screenIsLocked()) return { ok: false, reason: 'screen_locked' }
  if (now - (meta.last_auto_resume || 0) < policy.cooldown_seconds)
    return { ok: false, reason: 'cooldown' }
  if (windowsOpenedSince(now - 3600) >= policy.max_windows_per_hour)
    return { ok: false, reason: 'hourly_limit' }
  return { ok: true, reason: null }
}

const buildCommand = (meta, policy, promptFile) => {
  const template = meta.bind_kind === 'cwd' ? policy.continue_template : policy.command_template
  return template
    .replaceAll('{{session_id}}', meta.session_id)
    .replaceAll('{{prompt_file}}', promptFile)
    .replaceAll('{{cwd}}', meta.cwd)
}

export const notifyDesktop = (title, body) => {
  const script = `display notification ${JSON.stringify(truncate(body, 200))} with title ${JSON.stringify(title)} sound name "Ping"`
  execFile('/usr/bin/osascript', ['-e', script], () => {})
}

export const performResume = (meta, policy, { title } = {}) => {
  const drained = drainPendingIntoPrompt(meta.session_id)
  if (!drained) return { opened: false, reason: 'no_pending' }

  const command = buildCommand(meta, policy, drained.file)
  const launcher = writeLauncher(meta.session_id, meta.cwd, `exec ${command}`)
  const result = openTerminal({
    terminal: policy.terminal,
    sessionId: meta.session_id,
    cwd: meta.cwd,
    launcher,
    title: title || `buzz: ${meta.label || meta.session_id.slice(0, 8)}`,
    customTemplate: policy.launch_template,
  })

  writeMeta({ ...meta, last_auto_resume: nowSeconds() })
  appendJsonl(paths.resumeLog, {
    at: nowSeconds(),
    session_id: meta.session_id,
    opened: true,
    messages: drained.count,
    ...result,
  })
  logLine(paths.routerLog, `[resume] opened ${policy.terminal} for ${meta.session_id}`)
  return { opened: true, ...result, messages: drained.count }
}

export const recordSkip = (sessionId, reason) =>
  appendJsonl(paths.resumeLog, { at: nowSeconds(), session_id: sessionId, opened: false, reason })
