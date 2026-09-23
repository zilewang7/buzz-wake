#!/usr/bin/env node
// Regression tests for hooks/buzz-drain.sh — the PostToolUse courier.
//
//   node tests/drain-hook.mjs
//
// The hook runs inside subagents too, with the MAIN session's session_id, so
// without a guard it hands the message to a context that is thrown away. These
// cases drive the real script with real hook payloads against a throwaway
// BUZZWAKE_HOME, and assert on what survives in pending/.
//
// Payload shapes are copied from a live capture on Claude Code 2.1.258: the
// subagent one differs only by agent_id / agent_type sitting in the header.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parsePromptEvents } from '../lib/parse-event.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const HOOK = join(ROOT, 'hooks', 'buzz-drain.sh')
const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'

// Same anchor as the other two suites: derived from a real frame, not invented.
const real = JSON.parse(readFileSync(join(HERE, 'fixtures', 'quoted-frame.json'), 'utf8'))
const CHANNEL = 'dev-team (#11111111-2222-4333-8444-555555555555)'
const [EVENT] = parsePromptEvents({
  prompt: [
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
  ].join('\n'),
})

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

// The header fields are emitted before tool_name in the real payload; the guard
// must not depend on that, so keep the order here and vary only the extras.
const payload = ({ agent, toolCommand }) =>
  JSON.stringify({
    session_id: SESSION,
    transcript_path: `/Users/x/.claude/projects/p/${SESSION}.jsonl`,
    cwd: ROOT,
    prompt_id: '00000000-0000-4000-8000-000000000000',
    permission_mode: 'bypassPermissions',
    ...(agent ? { agent_id: 'a0000000000000001', agent_type: 'general-purpose' } : {}),
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: toolCommand || 'echo hi' },
    tool_response: { stdout: 'hi', stderr: '', interrupted: false },
  })

// Each case gets its own state dir so nothing leaks between them.
const runHook = ({ agent = false, toolCommand = null, queued = 1 } = {}) => {
  const home = mkdtempSync(join(tmpdir(), 'buzzwake-drain-test-'))
  const pending = join(home, 'sessions', SESSION, 'pending')
  mkdirSync(pending, { recursive: true })
  for (let i = 0; i < queued; i += 1) {
    writeFileSync(join(pending, `00178876434${i}-${real.id}.json`), JSON.stringify(EVENT))
  }
  let stdout = ''
  let status = 0
  try {
    stdout = execFileSync('/bin/bash', [HOOK], {
      input: payload({ agent, toolCommand }),
      env: { ...process.env, BUZZWAKE_HOME: home },
      encoding: 'utf8',
    })
  } catch (error) {
    status = error.status
    stdout = error.stdout || ''
  }
  const left = readdirSync(pending)
  const consumed = (() => {
    try {
      return readdirSync(join(home, 'sessions', SESSION, 'consumed'))
    } catch {
      return []
    }
  })()
  rmSync(home, { recursive: true, force: true })
  return { stdout, status, left: left.length, consumed: consumed.length }
}

group('1. 主线程调用 —— 照常投递', () => {
  const run = runHook()
  check('退出码 0', run.status, 0)
  check('交出了 additionalContext', run.stdout.includes('"additionalContext"'), true)
  check('正文在里面', run.stdout.includes(real.id.slice(0, 8)), true)
  check('pending 清空', run.left, 0)
  check('进了 consumed', run.consumed, 1)
})

// The bug this file exists for: without the guard the subagent eats the message
// and the main thread finds pending empty. Losing it is silent — the router log
// says "delivered".
group('2. 子 agent 调用 —— 留在队列里，不投给它', () => {
  const run = runHook({ agent: true })
  check('退出码 0', run.status, 0)
  check('没有输出', run.stdout, '')
  check('pending 原封不动', run.left, 1)
  check('没进 consumed', run.consumed, 0)
})

// JSON escapes every quote inside a string value, so a body that spells the
// field out cannot look like the field. This is what lets the guard match the
// raw payload instead of parsing it — the same hazard that ate a real message on the
// parser side, closed here by the encoding rather than by a line rule.
group('3. 正文里写出 "agent_id" —— 不误判', () => {
  const run = runHook({ toolCommand: 'echo \'{"agent_id":"fake"}\' && grep "agent_id" x.log' })
  check('退出码 0', run.status, 0)
  check('照常投递', run.stdout.includes('"additionalContext"'), true)
  check('pending 清空', run.left, 0)
})

group('4. 队列为空 —— 连 node 都不起', () => {
  const run = runHook({ queued: 0 })
  check('退出码 0', run.status, 0)
  check('没有输出', run.stdout, '')
})

console.log(`\n${failed === 0 ? '全部通过' : `${failed} 项失败`}：${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
