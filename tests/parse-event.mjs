#!/usr/bin/env node
// Regression tests for lib/parse-event.mjs.
//
//   node tests/parse-event.mjs
//
// No framework and no dependencies — same rule as the rest of the repo. Exits
// non-zero on the first failing run so it can gate a commit.
//
// This parser has silently eaten real messages twice now (README pit 30), and
// both times synthetic cases passed while production did not. So the anchor here
// is derived from a *real* frame: fixtures/quoted-frame.json keeps the line
// structure and hazard lines of an event our own gate once discarded, with
// identifiers and prose replaced. Anything added here should keep that property —
// start from a captured frame, do not invent one.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePromptEvents } from '../lib/parse-event.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const real = JSON.parse(readFileSync(join(HERE, 'fixtures', 'quoted-frame.json'), 'utf8'))

const CHANNEL = 'dev-team (#11111111-2222-4333-8444-555555555555)'
const CHANNEL_ID = '11111111-2222-4333-8444-555555555555'
const ME = 'b2'.repeat(32)

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

// The 0.5.22 shape, as captured off the relay. See lib/parse-event.mjs.
const xmlFrame = (event, { close = true } = {}) =>
  [
    '<buzz-event type="@mention">',
    `Event ID: ${event.id}`,
    `Channel: ${CHANNEL}`,
    `Kind: ${event.kind}`,
    `From: ${event.from} (npub: npub1x, hex: ${event.pubkey})`,
    `Time: ${event.time}`,
    `Content: ${event.content}`,
    `Tags: ${JSON.stringify(event.tags)}`,
    `Parsed: mentions=[backend (${ME})]`,
    ...(close ? ['</buzz-event>'] : []),
  ].join('\n')

const CONTEXT = [
  '<context>',
  'Scope: channel',
  'Session scope: channel',
  `Channel: ${CHANNEL}`,
  '</context>',
  '',
].join('\n')

const realEvent = {
  id: real.id,
  kind: real.kind,
  from: 'frontend',
  pubkey: real.pubkey,
  time: '2026-09-07T06:59:08+00:00',
  content: real.content,
  tags: real.tags,
}

const plainEvent = {
  ...realEvent,
  id: 'b'.repeat(64),
  content: '普通一句话，正文里没有任何标签。',
}

// The whole point of the fixture: this body quotes both tags inline, because it
// is a message explaining the format. Before the line-oriented split it closed
// its own frame mid-sentence and took the Tags line with it.
group('1. 派生自真实帧 —— 正文里同时含开标签和闭标签', () => {
  const [event] = parsePromptEvents({ prompt: CONTEXT + xmlFrame(realEvent) })
  check('拿到 p tag', event.mention_pubkeys, [ME])
  check('正文完整（结尾那句还在）', event.content.trimEnd().endsWith('skill 漏了）。'), true)
  check('Tags 行进来了', event.text.includes('Tags:'), true)
  check('channel_id', event.channel_id, CHANNEL_ID)
  check('author_pubkey', event.author_pubkey, real.pubkey)
  check('kind', event.kind, 9)
})

group('2. 一个 prompt 里两条事件，第一条正文含闭标签', () => {
  const events = parsePromptEvents({
    prompt: `${CONTEXT + xmlFrame(realEvent)}\n${xmlFrame(plainEvent)}`,
  })
  check('事件数', events.length, 2)
  check('两条的 id', events.map((event) => event.id.slice(0, 4)), [real.id.slice(0, 4), 'bbbb'])
  check('两条都拿到 p tag', events.map((event) => event.mention_pubkeys.length), [1, 1])
})

// A truncated prompt should cost the tail, not the event.
group('3. 末块没有闭标签', () => {
  const [event] = parsePromptEvents({ prompt: CONTEXT + xmlFrame(plainEvent, { close: false }) })
  check('仍然解析出事件', event?.id.slice(0, 4), 'bbbb')
  check('仍然拿到 p tag', event?.mention_pubkeys, [ME])
})

// One machine upgrading Buzz.app must not deafen the ones that have not.
group('4. 0.5.21 及更早的 [Buzz event:] 版式', () => {
  const prompt = [
    '[Context]',
    'Scope: channel',
    `Channel: ${CHANNEL}`,
    '',
    '[Buzz event: mentions]',
    `Event ID: ${'c'.repeat(64)}`,
    `Channel: ${CHANNEL}`,
    'Kind: 9',
    `From: frontend (npub: npub1x, hex: ${real.pubkey})`,
    'Time: 2026-09-07T06:59:08+00:00',
    'Content: 老版式一条',
    `Tags: ${JSON.stringify(real.tags)}`,
  ].join('\n')
  const [event] = parsePromptEvents({ prompt })
  check('id', event?.id.slice(0, 4), 'cccc')
  check('p tag', event?.mention_pubkeys, [ME])
})

group('5. 分隔符开头的合并 prompt', () => {
  const prompt = [
    '--- Event 1 (mentions) ---',
    `Event ID: ${'d'.repeat(64)}`,
    `Channel: ${CHANNEL}`,
    'Kind: 9',
    `From: frontend (npub: npub1x, hex: ${real.pubkey})`,
    'Time: 2026-09-07T06:59:08+00:00',
    'Content: 分隔符版式',
    `Tags: ${JSON.stringify(real.tags)}`,
  ].join('\n')
  const events = parsePromptEvents({ prompt })
  check('解析出 1 条', events.length, 1)
  check('p tag', events[0]?.mention_pubkeys, [ME])
})

group('6. 空输入', () => {
  check('空字符串', parsePromptEvents({ prompt: '' }).length, 0)
  check('只有 context', parsePromptEvents({ prompt: CONTEXT }).length, 0)
})

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}：${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
