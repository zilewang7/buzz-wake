import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, utimesSync, cpSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

// Optional runtime argument also exercises installed snapshots without real sessions or relay traffic.
const runtime = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..'))
const home = mkdtempSync(join(tmpdir(), 'buzzwake-rules-'))
process.env.BUZZWAKE_HOME = home
const { communicationRulesHint } = await import(pathToFileURL(join(runtime, 'lib/communication-rules.mjs')))
const { drainPendingIntoPrompt } = await import(pathToFileURL(join(runtime, 'lib/resume.mjs')))
const sessionId = 'communication-rules-test'
const pending = join(home, 'sessions', sessionId, 'pending')
const consumed = join(home, 'sessions', sessionId, 'consumed')
const rulesFile = join(home, 'team docs', '沟通 "规则".md')
let counter = 0

const configure = (value) => writeFileSync(join(home, 'routes.json'), JSON.stringify({
  notify_desktop: false,
  ...(value === undefined ? {} : { communication_rules_file: value }),
}))
const enqueue = (text) => {
  mkdirSync(pending, { recursive: true })
  writeFileSync(join(pending, `${++counter}.json`), JSON.stringify({ id: 'abcdef12', text }))
}
const bothPaths = (pattern) => {
  enqueue('resume message')
  const result = drainPendingIntoPrompt(sessionId)
  const resumed = readFileSync(result.file, 'utf8')
  assert.match(resumed, /resume message/)
  assert.match(resumed, pattern)
  enqueue('live message')
  const delivered = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(pathToFileURL(join(runtime, 'lib/cmd/internal.mjs')).href)}); await m.cmdInternalDrain({ _: ['internal-drain', ${JSON.stringify(sessionId)}] });`,
  ], { env: { ...process.env, BUZZWAKE_HOME: home }, encoding: 'utf8', timeout: 10000 })
  assert.equal(delivered.status, 0, delivered.stderr)
  const live = JSON.parse(delivered.stdout).hookSpecificOutput.additionalContext
  assert.match(live, /live message/)
  assert.match(live, pattern)
  assert.equal(readdirSync(pending).length, 0)
  assert.equal(readdirSync(consumed).length, counter)
  return { resumed, live }
}

try {
  configure(undefined)
  const bundled = join(runtime, 'AGENT_COMMUNICATION.md')
  assert.match(readFileSync(bundled, 'utf8'), /Buzz Agent/)
  const defaults = bothPaths(/Buzz 对话规则加载要求/)
  assert.ok(defaults.resumed.includes(JSON.stringify(bundled)))
  assert.ok(defaults.live.includes(JSON.stringify(bundled)))
  for (const value of [null, '']) {
    configure(value)
    assert.equal(communicationRulesHint(), '')
    const result = bothPaths(/message/)
    assert.doesNotMatch(result.resumed + result.live, /Buzz 对话规则/)
  }
  mkdirSync(dirname(rulesFile), { recursive: true })
  writeFileSync(rulesFile, '# Local team rules\nNever inline this fixture automatically.\n')
  configure('team docs/沟通 "规则".md')
  const hint = communicationRulesHint()
  assert.ok(hint.includes(JSON.stringify(rulesFile)))
  assert.match(hint, /回复前读取规则文件/)
  const valid = bothPaths(/Buzz 对话规则加载要求/)
  assert.doesNotMatch(valid.resumed + valid.live, /Never inline this fixture/)
  configure(rulesFile)
  assert.equal(communicationRulesHint(), hint)
  utimesSync(rulesFile, new Date('2020-01-01'), new Date('2020-01-01'))
  assert.notEqual(communicationRulesHint(), hint)
  bothPaths(/1577836800000/)
  for (const value of [false, 1, {}, [], '   ', 'x'.repeat(2049)]) {
    configure(value)
    bothPaths(/配置无效/)
  }
  for (const value of ['missing.md', 'team docs']) {
    configure(value)
    bothPaths(/无法读取配置文件/)
  }
  configure(null)
  assert.equal(communicationRulesHint(), '')
  configure(undefined)
  bothPaths(/Buzz 对话规则加载要求/)
  // A snapshot missing its bundled document must report it, not claim success.
  const snapshot = join(home, 'snapshot')
  cpSync(join(runtime, 'lib'), join(snapshot, 'lib'), { recursive: true })
  const missing = await import(pathToFileURL(join(snapshot, 'lib/communication-rules.mjs')))
  assert.match(missing.communicationRulesHint(), /无法读取配置文件/)
  const missingFile = join(realpathSync(snapshot), 'AGENT_COMMUNICATION.md')
  assert.ok(missing.communicationRulesHint().includes(JSON.stringify(missingFile)))
  console.log('communication rules: bundled default, override, disable, updates, errors, resume + live drain passed')
} finally {
  rmSync(home, { recursive: true, force: true })
}
