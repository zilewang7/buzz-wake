import { existsSync, statSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join, dirname, resolve } from 'node:path'
import { color } from '../args.mjs'
import { paths, claudeSettings } from '../paths.mjs'
import { readJson, readText } from '../util.mjs'
import { loadConfig } from '../config.mjs'
import { resolveSelector } from '../router.mjs'
import { loadInstall, readEnvFile, toWebsocketUrl, profileSlug, LAUNCHD_LABEL } from '../install-info.mjs'
import { listProfiles, plistHome } from '../profiles.mjs'
import { allSessions, readMeta, sessionState, watcherArmed } from '../sessions.mjs'
import { serviceRunning, plistPath } from './service.mjs'
import { terminalAvailable } from '../terminals.mjs'
import { describe, registryExists } from '../desktop.mjs'

const ok = (name, detail) => ({ name, status: 'ok', detail })
const warn = (name, detail, fix) => ({ name, status: 'warn', detail, fix })
const fail = (name, detail, fix) => ({ name, status: 'fail', detail, fix })

// Every other line below is about *this* profile, so say which one that is before
// saying anything else — on a two-identity machine a green doctor is meaningless
// until you know whose doctor it is.
const checkProfile = () => {
  const home = resolve(paths.home)
  const others = listProfiles().filter((profile) => !profile.current)
  const detail = `${profileSlug()}  ${home} → ${LAUNCHD_LABEL}${others.length > 0 ? `（另有 ${others.length} 个 profile）` : ''}`
  // Two dirs with the same basename derive the same label, and the second install
  // overwrote the first one's plist without a word.
  const owner = plistHome(LAUNCHD_LABEL)
  if (owner && resolve(owner) !== home)
    return warn(
      'profile',
      `${detail}；但这个 label 的 plist 指向 ${owner} —— label 撞车了`,
      '把其中一个 profile 换成不同的目录名再重装；buzzwake profiles 看是谁占着',
    )
  return ok('profile', detail)
}

const checkBinaries = (install) => {
  const missing = ['buzz_acp', 'buzz'].filter((key) => !install[key] || !existsSync(install[key]))
  if (missing.length > 0)
    return fail('二进制', `缺少 ${missing.join(', ')}`, '装 Buzz Desktop 后重跑 ./install.sh')
  return ok('二进制', `buzz-acp ${install.buzz_acp}`)
}

const checkNode = (install) => {
  if (!install.node || !existsSync(install.node))
    return fail('node', '未记录或路径失效', '重跑 ./install.sh')
  if (install.node.includes('fnm_multishells'))
    return fail(
      'node',
      'node 指向 fnm multishell 路径，终端一关就失效',
      '重跑 ./install.sh 让它解析成稳定路径',
    )
  return ok('node', install.node)
}

const checkEnv = () => {
  if (!existsSync(paths.env)) return fail('环境变量', `缺少 ${paths.env}`, '重跑 ./install.sh')
  const values = readEnvFile()
  const missing = ['BUZZ_PRIVATE_KEY', 'BUZZ_RELAY_URL'].filter((key) => !values[key])
  if (missing.length > 0) return fail('环境变量', `缺少 ${missing.join(', ')}`, '编辑 ~/.buzz-wake/env')
  const mode = statSync(paths.env).mode & 0o777
  if (mode !== 0o600)
    return warn('环境变量', `权限是 ${mode.toString(8)}，私钥应当只有自己可读`, 'chmod 600 ~/.buzz-wake/env')
  const relay = values.BUZZ_RELAY_URL
  if (toWebsocketUrl(relay) !== relay && !relay.startsWith('ws'))
    return ok('环境变量', `relay ${relay}（sidecar 会自动转成 ${toWebsocketUrl(relay)}）`)
  return ok('环境变量', `relay ${relay}`)
}

const checkService = () => {
  if (!existsSync(plistPath)) return fail('sidecar', '未安装 launchd 服务', './install.sh')
  const { loaded, pid } = serviceRunning()
  if (!loaded) return fail('sidecar', 'launchd 未加载', 'buzzwake start')
  const log = join(paths.logsDir, 'sidecar.log')
  if (!existsSync(log)) return warn('sidecar', `已加载 (pid ${pid}) 但还没有日志`, '等几秒或 buzzwake logs')
  // A healthy idle sidecar writes nothing, so log mtime says nothing about health.
  // Only errors appearing after the last successful connect mean anything.
  const lines = readText(log, '').split('\n')
  const connectAt = lines.findLastIndex((line) => line.includes('connected to relay'))
  if (connectAt === -1) return fail('sidecar', '日志里没有 connected to relay', 'buzzwake logs 看错误')
  const since = lines.slice(connectAt + 1).filter((line) => /ERROR|panic|Error:|disconnect/i.test(line))
  if (since.length > 0)
    return warn('sidecar', `连接后出现 ${since.length} 条错误: ${since.at(-1).slice(0, 90)}`, 'buzzwake restart')
  return ok('sidecar', `运行中 (pid ${pid})，连接正常`)
}

const HOOK_MARK = 'buzz-wake'

const checkHooks = () => {
  const settings = readJson(claudeSettings, null)
  if (!settings) return fail('hook', `读不到 ${claudeSettings}`, './install.sh')
  const hooks = settings.hooks || {}
  const flat = JSON.stringify(hooks)
  if (!flat.includes(HOOK_MARK)) return fail('hook', '未安装到 settings.json', './install.sh')

  const stopEntries = (hooks.Stop || []).flatMap((group) => group.hooks || [])
  const wake = stopEntries.find((entry) => String(entry.command || '').includes('buzz-wake.sh'))
  if (!wake) return fail('hook', 'Stop 上没有 buzz-wake.sh', './install.sh')
  if (wake.asyncRewake !== true)
    return fail('hook', 'buzz-wake.sh 缺少 asyncRewake: true，唤不醒 Claude', './install.sh')

  // These two arrived after the first release, so an install that predates them
  // looks entirely healthy while every message arriving mid-turn waits it out.
  const has = (event, file) =>
    (hooks[event] || []).flatMap((group) => group.hooks || [])
      .some((entry) => String(entry.command || '').includes(file))
  const missing = [
    has('PostToolUse', 'buzz-drain.sh') ? null : 'PostToolUse/buzz-drain.sh（turn 中不投递）',
    has('UserPromptSubmit', 'buzz-turn.sh') ? null : 'UserPromptSubmit/buzz-turn.sh（watcher 会打断 turn）',
  ].filter(Boolean)
  if (missing.length > 0) return warn('hook', `缺少 ${missing.join('、')}`, './install.sh')

  const foreignStop = stopEntries.filter((entry) => !String(entry.command || '').includes(HOOK_MARK))
  return ok('hook', `已装（含 turn 中投递）；同层保留了 ${foreignStop.length} 个其他 Stop hook`)
}

// install.json's respond_to is what the next restart will use; the argv of the
// running sidecar is what is gating right now. Same lesson as checkIntake below —
// reporting the config makes an edit that never reached the process read green.
const runningGate = () => {
  const { pid } = serviceRunning()
  if (!pid) return null
  const args = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout || ''
  return args.match(/--respond-to (owner-only|allowlist|anyone|nobody)/)?.[1] || null
}

const gateDetail = (mode, install) =>
  mode === 'anyone'
    ? 'anyone —— 频道里任何人 @ 你或回复你都能唤醒'
    : `${mode}${install.peers?.length ? `，白名单 ${install.peers.length} 人` : ''}`

const checkAuthorGate = (install) => {
  // Desktop builds buzz-acp's argv itself, so install.json says nothing about the
  // gate in that mode — its own registry does.
  if ((install.mode || 'standalone') === 'desktop') {
    const spool = join(install.root || '', 'agent', 'spool-agent.mjs')
    const gate = describe(install.pubkey_hint, spool).agent?.respond_to
    if (!gate) return ok('作者门禁', '由 Buzz Desktop 决定（注册表里没有这个身份的 agent）')
    if (gate === 'owner-only')
      return fail(
        '作者门禁',
        'Desktop 侧 respond_to = owner-only，同事 agent 的 mention 会被静默丢弃',
        'Buzz Desktop 里把这个 agent 的 who can send interactions 改宽',
      )
    return ok('作者门禁', `${gate}（Desktop 注册表）`)
  }

  const configured = install.respond_to || 'owner-only'
  const running = runningGate()
  if (running && running !== configured)
    return warn(
      '作者门禁',
      `install.json 写的是 ${configured}，跑着的 sidecar 是 ${running}`,
      'buzzwake restart；重启后还是这条，说明 run-sidecar.sh 是旧的 → ./install.sh',
    )
  const mode = running || configured
  if (mode === 'owner-only')
    return fail(
      '作者门禁',
      'respond-to = owner-only，同事 agent 的 mention 会被静默丢弃',
      'buzzwake peer add <同事pubkey>',
    )
  if (mode === 'allowlist' && (!install.peers || install.peers.length === 0))
    return warn('作者门禁', 'allowlist 模式但白名单为空（只有 owner 能叫醒你）', 'buzzwake peer add <pubkey>')
  return ok('作者门禁', gateDetail(mode, install))
}

// The intake widening lives in the generated run-sidecar.sh, so a git pull that
// skips ./install.sh leaves the relay still filtering on #p: mentions keep
// working and reply-to never fires, with nothing in any log to say so. Read the
// running process rather than install.json — config and effective value are two
// different things, and that gap has cost us an afternoon before.
const checkIntake = (install) => {
  // Desktop mode has no run-sidecar.sh at all: Buzz Desktop builds buzz-acp's
  // argv itself, and its agent registry exposes no field for it (acp_command is
  // the bare binary name). So the REQ keeps its #p filter no matter what we ship
  // here, and reply-to wake cannot work. Skipping the check silently — which is
  // what this did at first — hands desktop users an all-green doctor for a
  // feature that never fires, i.e. exactly the failure this feature exists to kill.
  if ((install.mode || 'standalone') === 'desktop')
    return warn(
      '订阅范围',
      'desktop 模式的订阅参数由 Buzz Desktop 决定，去不掉 #p —— 只有 @ 你能唤醒，别人回复你不会',
      '改用 both 模式（加装 launchd sidecar，Desktop 侧不动）：./install.sh',
    )

  const { pid } = serviceRunning()
  if (!pid) return warn('订阅范围', 'sidecar 没在跑，无法核对生效值', 'buzzwake start')
  const args = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout || ''
  if (!args.includes('--no-mention-filter'))
    return warn(
      '订阅范围',
      '生效参数缺 --no-mention-filter —— relay 仍按 #p 过滤，别人回复你不会唤醒',
      './install.sh',
    )
  return ok('订阅范围', `${install.subscribe || 'mentions'} —— 本地判定（@ 你 或 回复你）`)
}

const checkCurrentSession = () => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  if (!sessionId) return warn('当前 session', '不在 Claude Code 会话里，跳过', null)
  const meta = readMeta(sessionId)
  // SessionStart hook only fires for new sessions; bind backfills the registration.
  if (!meta) return fail('当前 session', '未注册（本会话早于安装）', 'buzzwake bind --channel <名字>')
  const config = loadConfig()
  // Ask the router rather than matching selector strings. "Bound" has to mean
  // "some rule actually resolves to this session" — a hardcoded list of
  // session:/cwd:/label: read a to:["newest"] rule as unbound the moment newest
  // became bind's default, and then told you to run the bind you just ran.
  const sessions = allSessions()
  const boundBy = config.rules.find((rule) =>
    (rule.to || []).some((selector) =>
      resolveSelector(selector, sessions).some((s) => s.session_id === sessionId),
    ),
  )
  if (!boundBy && config.default === 'none')
    return fail('当前 session', '没有绑定任何频道，且兜底是 none —— 消息会被丢弃', 'buzzwake bind --channel <名字>')
  if (!boundBy)
    return warn('当前 session', `已注册，未显式绑定（靠兜底 ${config.default}）`, 'buzzwake bind --channel <名字>')
  return ok('当前 session', `已注册并已绑定（${boundBy.to.join(',')} ← ${boundBy.channel || '*'}）`)
}

const checkBacklog = () => {
  const stuck = allSessions().filter((session) => session.pending > 10)
  if (stuck.length === 0) return ok('待投递队列', '无积压')
  return warn(
    '待投递队列',
    `${stuck.map((s) => `${s.session_id.slice(0, 8)}:${s.pending}`).join(' ')} 有积压，watcher 可能没在跑`,
    '重开对应 session，或 buzzwake resume <id>',
  )
}

// The watcher is what makes an idle window reachable at all, and it dies quietly:
// its window expires, or its process is gone, and nothing says so. Everything
// downstream still looks healthy — the rule resolves, the router queues, the log
// is green — while the message waits for the human to type. Name it here.
const checkWatchers = () => {
  const deaf = allSessions().filter((s) => s.state === 'live' && !watcherArmed(s.session_id))
  if (deaf.length === 0) return ok('唤醒监听', '所有活会话都在监听')
  return warn(
    '唤醒监听',
    `${deaf.map((s) => s.session_id.slice(0, 8)).join(', ')} 没有 watcher —— 空闲时收不到，要等它下次跑工具`,
    '在那个窗口里说句话，一轮结束就会重新上岗',
  )
}

const checkTargets = () => {
  const config = loadConfig()
  const sessions = allSessions()
  const broken = []
  const stale = []
  const unclaimed = []
  for (const rule of config.rules) {
    for (const target of rule.to || []) {
      // An unclaimed label drops messages on the floor by design (no fallback to
      // newest — that is the drift label: exists to stop), so it has to be loud.
      if (target.startsWith('label:')) {
        const name = target.slice('label:'.length)
        if (!sessions.some((s) => s.label === name && s.state !== 'gone')) unclaimed.push(name)
        continue
      }
      if (!target.startsWith('session:')) continue
      const id = target.slice('session:'.length)
      const meta = readMeta(id)
      if (!meta || sessionState(meta) === 'gone') {
        broken.push(id.slice(0, 8))
        continue
      }
      // A session: binding outlives the session id it names — compact, fork and
      // `claude -c` all mint a new one. "Resumable" is not "will be resumed":
      // messages pile up in a transcript nobody reopens, and every log line says
      // delivered. A live session in the same cwd is the tell that the id moved on.
      if (sessionState(meta) !== 'dormant') continue
      const heir = sessions.find(
        (s) => s.cwd === meta.cwd && s.state === 'live' && s.session_id !== id,
      )
      if (heir) stale.push(`${id.slice(0, 8)}→${heir.session_id.slice(0, 8)}`)
    }
  }
  if (unclaimed.length > 0)
    return warn(
      '绑定目标',
      `标签 ${unclaimed.join(', ')} 当前没人认领，这些频道的消息不会投递`,
      '在要接管的会话里跑 buzzwake bind --channel <名字> --label <标签>',
    )
  if (broken.length > 0)
    return warn('绑定目标', `${broken.join(', ')} 的 transcript 已消失`, 'buzzwake forget --gone 后重新 bind')
  if (stale.length > 0)
    return warn(
      '绑定目标',
      `${stale.join(', ')}：绑的 session 已休眠，同目录另有活会话（compact/fork 换了 id）`,
      '在活会话里重跑 buzzwake bind --channel <名字>，或改用 --newest',
    )
  return ok('绑定目标', '全部可恢复')
}

const checkTerminal = () => {
  const policy = loadConfig().resume_defaults
  if (!terminalAvailable(policy.terminal))
    return fail('resume 终端', `${policy.terminal} 不可用`, 'buzzwake resume-policy --terminal terminal.app')
  return ok('resume 终端', `${policy.terminal}（默认模式 ${policy.mode}）`)
}

const checkDesktopAgent = (install) => {
  if (!registryExists()) return ok('Desktop 抢答', '没装 Buzz Desktop，无从抢答')
  const spool = join(install.root || '', 'agent', 'spool-agent.mjs')
  const info = describe(install.pubkey_hint, spool)
  if (!info.agent) return ok('Desktop 抢答', '没有用同一身份的托管 agent')
  if (info.agent.patched)
    return ok('Desktop 抢答', `${info.agent.name} 的 harness 已被接管（只推送，不回帖）`)
  return fail(
    'Desktop 抢答',
    `${info.agent.name} 仍在用 claude-agent-acp —— 它会抢答 @mention`,
    '退出 Buzz Desktop，然后跑 buzzwake desktop patch',
  )
}

const checkMode = (install) => {
  const mode = install.mode || 'standalone'
  if (mode === 'desktop')
    return ok('工作模式', 'desktop —— 由 Buzz Desktop 的 harness 推送，无 launchd')
  if (mode === 'both') return ok('工作模式', 'both —— Desktop 与 launchd 双订阅（按 event id 去重）')
  return ok('工作模式', 'standalone —— 自带 launchd sidecar')
}

// macOS ps has no etimes, and lstart is locale-formatted. etime's
// [dd-]hh:mm:ss parses cleanly without touching dates at all.
const processAgeSeconds = (pid) => {
  const result = spawnSync('/bin/ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8' })
  if (result.status !== 0) return null
  const parts = result.stdout.trim().split(/[-:]/).map(Number)
  if (parts.length < 2 || parts.some(Number.isNaN)) return null
  const [days, hours, minutes, seconds] =
    parts.length === 4 ? parts : parts.length === 3 ? [0, ...parts] : [0, 0, ...parts]
  return days * 86400 + hours * 3600 + minutes * 60 + seconds
}

// Walk the spool agent's actual import graph rather than guessing by directory:
// lib/cmd/* is CLI-only today, but a blacklist would silently rot the moment
// that stops being true.
const newestCodeMtime = (entry) => {
  const seen = new Set()
  const queue = [entry]
  let newest = 0
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file) || !existsSync(file)) continue
    seen.add(file)
    newest = Math.max(newest, statSync(file).mtimeMs)
    for (const match of readText(file, '').matchAll(/\bfrom\s+'(\.[^']+)'/g))
      queue.push(resolve(dirname(file), match[1]))
  }
  return newest
}

// In both mode there are two spool agents and `restart` only owns one of them,
// so a single fix line makes the warning look like restart didn't work. Say
// which half each command covers.
const restartHint = (mode) =>
  mode === 'desktop'
    ? '重开 Buzz Desktop'
    : mode === 'both'
      ? 'buzzwake restart 只换 launchd 那半边；Desktop 托管的那个要重开 Buzz Desktop'
      : 'buzzwake restart'

// Which processes are still holding an old copy of lib/, measured against the
// newest mtime in that entry's import graph.
const staleResidents = (pattern, entry) => {
  const found = spawnSync('/usr/bin/pgrep', ['-f', pattern], { encoding: 'utf8' })
  const pids = (found.stdout || '').trim().split('\n').filter(Boolean).map(Number)
  const newest = newestCodeMtime(entry)
  if (!newest) return { pids, stale: [], comparable: false }
  const stale = pids.filter((pid) => {
    const age = processAgeSeconds(pid)
    return age !== null && Date.now() - age * 1000 < newest
  })
  return { pids, stale, comparable: true }
}

// Long-running processes keep executing whatever they loaded at start, so
// editing lib/ without restarting them silently changes nothing. Cost me a
// round of "I shipped the fix" while the old parser was still running.
//
// There are TWO kinds of them, and checking only the spool agent is how this
// check reported "1 个 spool agent 都在跑当前代码" while five watchers armed
// four hours earlier were still resident — and the next message was rendered by
// the old formatEvent. A watcher exits the moment it delivers, so the damage is
// bounded at one message per session, which is exactly enough to look like the
// change never shipped. `buzzwake restart` does not touch them: they re-arm on
// the next Stop hook, or on a pkill, whichever comes first.
const checkCodeFreshness = (install) => {
  const root = install.root
  if (!root) return warn('代码版本', '不知道项目路径', '重跑 ./install.sh')
  const spool = join(root, 'agent', 'spool-agent.mjs')
  // install.root is written once at install time and never re-validated. Move the
  // checkout and pgrep finds nothing, so this would report a cheerful "no spool
  // agent running" — a false green on the one check whose job is catching code
  // that silently isn't running.
  if (!existsSync(spool))
    return fail('代码版本', `install.json 记的项目路径已失效: ${root}`, '在新位置重跑 ./install.sh')
  const cli = join(root, 'lib', 'cli.mjs')

  const agents = staleResidents(spool, spool)
  const watchers = staleResidents(`${cli} internal-watch`, cli)

  if (agents.pids.length === 0 && watchers.pids.length === 0)
    return ok('代码版本', color.dim('没有在跑的常驻进程'))
  if (!agents.comparable && !watchers.comparable) return ok('代码版本', '无法比对，跳过')

  const problems = []
  const fixes = []
  if (agents.stale.length > 0) {
    problems.push(`spool agent (pid ${agents.stale.join(', ')})`)
    fixes.push(restartHint(install.mode))
  }
  if (watchers.stale.length > 0) {
    problems.push(`${watchers.stale.length} 个 session watcher (pid ${watchers.stale.join(', ')})`)
    // restart does not own these. Killing them is not free either: a session
    // with no watcher is deaf while idle until its next Stop, so say what each
    // option costs instead of handing over a command that looks mandatory.
    fixes.push(
      `不急可以不管 —— watcher 投完一条就退，下次 Stop 自动换成新代码（代价：每个 session 有一条按旧格式渲染）。` +
        `要立刻生效: pkill -f "${cli} internal-watch"（代价：空闲 session 到下次 Stop 前收不到）`,
    )
  }
  if (problems.length > 0)
    return warn('代码版本', `${problems.join(' 与 ')} 起于代码改动之前，跑的是旧代码`, fixes.join('；'))

  const counted = [
    agents.pids.length > 0 ? `${agents.pids.length} 个 spool agent` : null,
    watchers.pids.length > 0 ? `${watchers.pids.length} 个 watcher` : null,
  ].filter(Boolean)
  return ok('代码版本', `${counted.join(' + ')} 都在跑当前代码`)
}

const ICON = { ok: color.ok('✓'), warn: color.warn('!'), fail: color.bad('✗') }

export const cmdDoctor = () => {
  const install = loadInstall()
  const results = [
    checkProfile(),
    checkBinaries(install),
    checkNode(install),
    checkEnv(),
    checkMode(install),
    ...(install.mode === 'desktop' ? [] : [checkService()]),
    checkHooks(),
    checkAuthorGate(install),
    checkIntake(install),
    checkCurrentSession(),
    checkBacklog(),
    checkWatchers(),
    checkTargets(),
    checkTerminal(),
    checkDesktopAgent(install),
    checkCodeFreshness(install),
  ]

  for (const result of results) {
    console.log(`${ICON[result.status]} ${result.name.padEnd(12)} ${result.detail}`)
    if (result.fix && result.status !== 'ok') console.log(`  ${color.dim(`→ ${result.fix}`)}`)
  }

  const failures = results.filter((r) => r.status === 'fail').length
  const warnings = results.filter((r) => r.status === 'warn').length
  console.log()
  if (failures === 0 && warnings === 0) console.log(color.ok('全部通过。'))
  else console.log(`${failures > 0 ? color.bad(`${failures} 项失败`) : ''}${failures && warnings ? '，' : ''}${warnings > 0 ? color.warn(`${warnings} 项警告`) : ''}`)
  return failures > 0 ? 1 : 0
}
