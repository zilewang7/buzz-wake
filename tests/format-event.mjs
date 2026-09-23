#!/usr/bin/env node
// Regression tests for formatEvent in lib/resume.mjs — the text every delivery
// hands to Claude, and in particular the ready-to-run `回复:` command.
//
//   node tests/format-event.mjs
//
// Same anchor as tests/parse-event.mjs: the event object comes from parsing the
// frame in fixtures/quoted-frame.json, derived from a real capture, so the command
// is checked against the shape a real sender, channel and id arrive in.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePromptEvents } from '../lib/parse-event.mjs'
import { formatEvent } from '../lib/resume.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const real = JSON.parse(readFileSync(join(HERE, 'fixtures', 'quoted-frame.json'), 'utf8'))

const CHANNEL_ID = '11111111-2222-4333-8444-555555555555'
const CHANNEL = `dev-team (#${CHANNEL_ID})`

let passed = 0
let failed = 0

const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
    return
  }
  failed += 1
  console.log(`  ✗ ${name}\n      得到 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`)
}

const group = (name, body) => {
  console.log(name)
  body()
}

const frame = [
  '<context>',
  'Scope: channel',
  `Channel: ${CHANNEL}`,
  '</context>',
  '',
  '<buzz-event type="@mention">',
  `Event ID: ${real.id}`,
  `Channel: ${CHANNEL}`,
  `Kind: ${real.kind}`,
  `From: frontend (npub: npub1x, hex: ${real.pubkey})`,
  'Time: 2026-09-07T06:59:08+00:00',
  `Content: ${real.content}`,
  `Tags: ${JSON.stringify(real.tags)}`,
  '</buzz-event>',
].join('\n')

const [event] = parsePromptEvents({ prompt: frame })

// Only the header counts — everything after the first blank line is the message
// body, and a body may quote a `回复:` line of its own. The fixture does: it is
// derived from the message that proposed this command in the first place.
const replyBlock = (text) => {
  const lines = text.split('\n')
  const header = lines.slice(0, lines.indexOf(''))
  const start = header.findIndex((line) => line.startsWith('回复: '))
  return start === -1 ? null : { lines, start, command: lines[start] }
}

group('1. 派生自真实帧 —— 回复命令填好了', () => {
  const text = formatEvent(event)
  const reply = replyBlock(text)
  check('有回复行', reply !== null, true)
  check('在正文之前（truncate 从尾砍不掉它）', reply.start < reply.lines.indexOf(`Event ID: ${real.id}`), true)
  check('频道 id', reply.command.includes(`--channel ${CHANNEL_ID}`), true)
  check('--mention 发件人 hex', reply.command.includes(`--mention ${real.pubkey}`), true)
  check('正文走 stdin', reply.command.endsWith("--content - <<'BUZZ_EOF'"), true)
  check('首行 @ 对方并引前 8 位', reply.lines[reply.start + 1], `@frontend 回 ${real.id.slice(0, 8)}：`)
  check('heredoc 闭合，且分界符不是会撞上引用的 EOF', reply.lines[reply.start + 2], 'BUZZ_EOF')
  check('没有 --reply-to', reply.command.includes('--reply-to'), false)
  check('正文没被拼进命令', reply.command.includes(real.content.slice(0, 20)), false)
})

group('2. 填不出来就不给，宁缺毋错', () => {
  const noPubkey = formatEvent({ ...event, author_pubkey: null })
  check('没有发件人 hex → 无回复行', replyBlock(noPubkey), null)
  check('  但 事件: 行照旧', noPubkey.includes(`事件: ${real.id.slice(0, 8)}`), true)
  check('forum 帖子 → 无回复行', replyBlock(formatEvent({ ...event, kind: 45001 })), null)
  check('没有频道 id → 无回复行', replyBlock(formatEvent({ ...event, channel_id: null })), null)
})

// With an explicit --mention on the line, an ambiguous @Name is presentation-only,
// so a display name with a space is safe here — the CLI says so in its help.
group('3. 显示名带空格', () => {
  const text = formatEvent({ ...event, author_label: 'code reviewer' })
  const reply = replyBlock(text)
  check('首行仍是完整显示名', reply.lines[reply.start + 1], `@code reviewer 回 ${real.id.slice(0, 8)}：`)
  check('--mention 仍是 hex', reply.command.includes(`--mention ${real.pubkey}`), true)
})

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}：${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
