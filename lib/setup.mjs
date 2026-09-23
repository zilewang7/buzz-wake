import { createInterface } from 'node:readline/promises'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  writeFileSync,
  chmodSync,
  copyFileSync,
  symlinkSync,
  rmSync,
  accessSync,
  constants,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { parseArgs, color } from './args.mjs'
import { paths, claudeSettings, WAKE_HOME } from './paths.mjs'
import { ensureDir, readJson, writeJsonAtomic, writeAtomic, nowSeconds } from './util.mjs'
import { loadConfig, saveConfig, DEFAULT_KINDS, RESUME_MODES } from './config.mjs'
import { findBinary, toWebsocketUrl, readEnvFile, LAUNCHD_LABEL, profileSlug } from './install-info.mjs'
import { listProfiles } from './profiles.mjs'
import { TERMINALS } from './terminals.mjs'
import { plistPath, cmdStart } from './cmd/service.mjs'
import { describe, patch as patchDesktop, desktopRunning, registryExists } from './desktop.mjs'
import { cmdDoctor } from './cmd/doctor.mjs'

const args = parseArgs(process.argv.slice(2))
const ROOT = args.root || process.cwd()
const NODE = args.node || process.execPath
const YES = args.yes === true || args.y === true
const rl = createInterface({ input: process.stdin, output: process.stdout })

const say = (text = '') => console.log(text)
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`
const step = (n, total, text) => say(`\n${color.bold(`[${n}/${total}]`)} ${text}`)

const ask = async (question, fallback) => {
  if (YES) {
    say(`${question}: ${color.dim(`${fallback ?? ''} (--yes)`)}`)
    return fallback || ''
  }
  const suffix = fallback ? ` ${color.dim(`[${fallback}]`)}` : ''
  const answer = (await rl.question(`${question}${suffix}: `)).trim()
  return answer || fallback || ''
}

const askChoice = async (question, choices, fallback) => {
  if (YES) {
    say(`${question}: ${color.dim(`${fallback} (--yes)`)}`)
    return fallback
  }
  say(`${question} ${color.dim(`(${choices.join(' / ')})`)}`)
  for (;;) {
    const answer = await ask('  选择', fallback)
    if (choices.includes(answer)) return answer
    say(color.bad(`  只能是: ${choices.join(', ')}`))
  }
}

const askYesNo = async (question, fallback = 'y') => {
  const answer = (await ask(`${question} (y/n)`, fallback)).toLowerCase()
  return answer.startsWith('y')
}

// ---------------------------------------------------------------- preflight

const preflight = () => {
  const buzzAcp = findBinary('buzz-acp')
  const buzz = findBinary('buzz')
  if (!buzzAcp || !buzz) {
    say(color.bad('找不到 buzz-acp / buzz 二进制。'))
    say('这两个都随 Buzz Desktop 一起分发，去 https://github.com/block/buzz 装一个 Desktop 就有了。')
    process.exit(1)
  }
  say(`  buzz-acp : ${buzzAcp}`)
  say(`  buzz     : ${buzz}`)
  say(`  node     : ${NODE}`)
  if (NODE.includes('fnm_multishells') || NODE.includes('/.nvm/')) {
    say(color.warn('  注意: node 路径看起来是版本管理器的临时路径，launchd 可能找不到它。'))
  }
  return { buzzAcp, buzz }
}

// ------------------------------------------------------------------ credentials

const collectEnv = async () => {
  const existing = { ...readEnvFile() }
  const fromShell = {
    BUZZ_PRIVATE_KEY: process.env.BUZZ_PRIVATE_KEY,
    BUZZ_RELAY_URL: process.env.BUZZ_RELAY_URL,
    BUZZ_AUTH_TAG: process.env.BUZZ_AUTH_TAG,
  }
  const values = { ...fromShell, ...existing }

  if (values.BUZZ_PRIVATE_KEY) {
    say(`  已找到私钥 ${color.dim(`(${values.BUZZ_PRIVATE_KEY.slice(0, 9)}… 共 ${values.BUZZ_PRIVATE_KEY.length} 位)`)}`)
  } else {
    say('  需要这个 agent 的 nostr 私钥（nsec1… 或 64 位 hex）。')
    say(color.dim('  Buzz Desktop 里 agent 的 profile 菜单可以 Export；丢了无法找回。'))
    values.BUZZ_PRIVATE_KEY = await ask('  BUZZ_PRIVATE_KEY')
    if (!values.BUZZ_PRIVATE_KEY) {
      say(color.bad('没有私钥没法继续。'))
      process.exit(1)
    }
  }

  values.BUZZ_RELAY_URL = await ask('  BUZZ_RELAY_URL', values.BUZZ_RELAY_URL || 'http://localhost:3000')
  if (!values.BUZZ_AUTH_TAG && (await askYesNo('  要填 BUZZ_AUTH_TAG 吗（用于 owner 解析，不填也能跑）', 'n'))) {
    values.BUZZ_AUTH_TAG = await ask('  BUZZ_AUTH_TAG')
  }

  ensureDir(WAKE_HOME)
  // Single-quote every value: BUZZ_AUTH_TAG is a JSON array and an unquoted
  // assignment silently loses its double quotes, which the relay then rejects
  // with "restricted: not a relay member".
  const body = Object.entries(values)
    .filter(([, value]) => value)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('\n')
  writeAtomic(paths.env, `${body}\n`, 0o600)
  chmodSync(paths.env, 0o600)
  say(color.ok(`  已写入 ${paths.env} (600)`))
  return values
}

const resolveOwnIdentity = (buzz, env) => {
  try {
    const raw = execFileSync(buzz, ['--format', 'compact', 'users', 'get'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    const users = JSON.parse(raw)
    if (users.length > 0) return users[0]
  } catch {
    // relay unreachable; not fatal for install
  }
  return null
}

// ------------------------------------------------------- Desktop conflict check

const DESKTOP_REGISTRY = join(
  homedir(),
  'Library',
  'Application Support',
  'xyz.block.buzz.app',
  'agents',
  'managed-agents.json',
)

const checkDesktopConflict = (pubkey) => {
  const registry = readJson(DESKTOP_REGISTRY, null)
  if (!Array.isArray(registry) || !pubkey) return true
  const clash = registry.filter((agent) => agent?.pubkey === pubkey && agent?.is_active)
  if (clash.length === 0) {
    say(color.ok('  Desktop 里没有启用同一身份的托管 agent'))
    return true
  }
  say(color.bad(`  Desktop 里有 ${clash.length} 个启用中的 agent 用着同一个身份 (${clash.map((a) => a.name).join(', ')})`))
  say('  它会抢答 @mention —— 那是个没有你终端上下文的全新 Claude。')
  say(color.dim('  退出 Buzz Desktop 后，在 agent 的 profile 菜单里停用/删除它，或跑：'))
  say(color.dim(`    python3 -c "import json,os;p=os.path.expanduser('~/Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json');d=json.load(open(p));[a.update(is_active=False) for a in d if a.get('pubkey')=='${pubkey}'];json.dump(d,open(p,'w'),indent=2)"`))
  return false
}

// ------------------------------------------------------------------- peers

const collectPeers = async (buzz, env, ownPubkey) => {
  const existing = readJson(paths.install, {})?.peers || []
  if (existing.length > 0) {
    say(`  已有白名单 ${existing.length} 人: ${existing.map((p) => p.name || p.pubkey.slice(0, 8)).join(', ')}`)
    if (!(await askYesNo('  要重新设置吗', 'n'))) return existing
  }

  say('  谁的 @ 应该能叫醒你？（同事的 agent，以及他们本人）')
  say(color.dim('  不设的话默认只有你自己的 owner 能触发 —— 同事的 mention 会被静默丢弃，这是最常见的踩坑。'))

  let users = []
  try {
    const raw = execFileSync(buzz, ['--format', 'compact', 'users', 'get'], {
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    users = JSON.parse(raw).filter((user) => user.pubkey !== ownPubkey)
  } catch {
    say(color.dim('  (relay 暂时读不到用户列表，只能手输 pubkey)'))
  }

  if (users.length > 0) {
    say('  relay 上认识的人：')
    users.forEach((user, index) => {
      say(`    ${index + 1}. ${user.display_name || '(无名)'}  ${user.pubkey.slice(0, 16)}…`)
    })
    const picked = await ask('  选序号（逗号分隔），或直接粘 pubkey，留空跳过')
    if (!picked) return []
    const peers = []
    for (const token of picked.split(',').map((t) => t.trim()).filter(Boolean)) {
      const index = Number.parseInt(token, 10)
      if (index >= 1 && index <= users.length) {
        peers.push({ pubkey: users[index - 1].pubkey, name: users[index - 1].display_name })
      } else if (/^[0-9a-f]{64}$/i.test(token)) {
        peers.push({ pubkey: token.toLowerCase(), name: null })
      } else {
        say(color.warn(`    忽略无法识别的输入: ${token}`))
      }
    }
    return peers
  }

  const manual = await ask('  逗号分隔的 pubkey（留空跳过）')
  return manual
    .split(',')
    .map((t) => t.trim())
    .filter((t) => /^[0-9a-f]{64}$/i.test(t))
    .map((t) => ({ pubkey: t.toLowerCase(), name: null }))
}

// ------------------------------------------------------------------- policy

const collectPolicy = async () => {
  const config = loadConfig()

  say('  兜底路由：没有显式绑定的消息怎么办？')
  config.default = await askChoice(
    '  ',
    ['newest', 'none'],
    config.default,
  )
  say(color.dim('    newest = 投给最近活跃的 session（不丢消息）；none = 严格只投显式绑定的'))

  say('\n  被绑定的 session 已经关了的时候：')
  say(color.dim('    off    只排队，等你下次打开这个 session 时补上'))
  say(color.dim('    notify 只弹桌面通知（不推荐：不开窗，也不告诉你该恢复哪个，ask 严格更好）'))
  say(color.dim('    ask    弹通知，通知里带上恢复命令'))
  say(color.dim('    auto   直接开一个终端窗口 claude -r 恢复它，并把消息作为第一句（默认）'))
  say(color.dim('           只有你显式 bind 过的频道会开窗，兜底路由命中的一律降级为 notify'))
  config.resume_defaults.mode = await askChoice('  ', RESUME_MODES, config.resume_defaults.mode)

  if (config.resume_defaults.mode === 'auto' || config.resume_defaults.mode === 'ask') {
    config.resume_defaults.terminal = await askChoice('  用哪个终端开窗', TERMINALS, config.resume_defaults.terminal)
    if (config.resume_defaults.terminal === 'custom') {
      say(color.dim('    模板里 {{cmd}} 会被替换成启动脚本路径，{{cwd}} 是工作目录'))
      config.resume_defaults.launch_template = await ask('  启动模板', config.resume_defaults.launch_template || '')
    }
  }

  const subscribe = await askChoice(
    '\n  订阅范围：只有 @ 你的消息，还是绑定频道的全部消息',
    ['mentions', 'all'],
    'mentions',
  )

  config.kinds = [...DEFAULT_KINDS]
  saveConfig(config)
  return { config, subscribe }
}

const detectClaudeCommand = async (policy) => {
  if (policy.mode !== 'auto' && policy.mode !== 'ask') return policy.command_template
  say('\n  自动恢复时用什么命令启动 Claude？')
  say(color.dim('    默认 claude -r <id> "$(cat <消息文件>)"'))
  say(color.dim('    如果你平时是带 alias 跑的（比如要 unset 代理），把真实命令写进来。'))
  const custom = await ask('  命令模板', policy.command_template)
  return custom
}

// -------------------------------------------------------------- sidecar script

const writeSidecarScript = ({ buzzAcp, subscribe, kinds }) => {
  const file = join(WAKE_HOME, 'run-sidecar.sh')
  const script = `#!/usr/bin/env bash
# generated by buzz-wake install.sh — edit at your own risk, re-running the
# installer overwrites this file.
set -euo pipefail

WAKE_HOME="\${BUZZWAKE_HOME:-$HOME/.buzz-wake}"
. "$WAKE_HOME/env"

# buzz-acp only speaks WebSocket; the CLI is happy with http(s).
case "\$BUZZ_RELAY_URL" in
  https://*) export BUZZ_RELAY_URL="wss://\${BUZZ_RELAY_URL#https://}" ;;
  http://*)  export BUZZ_RELAY_URL="ws://\${BUZZ_RELAY_URL#http://}" ;;
esac

export BUZZ_ACP_AGENT_COMMAND=${JSON.stringify(NODE)}
export BUZZ_ACP_AGENT_ARGS=${JSON.stringify(join(ROOT, 'agent', 'spool-agent.mjs'))}

# --no-mention-filter in both modes. The relay turns require_mention into
# "#p": [me] on the REQ, so with it on, someone replying to a message you wrote
# never reaches this machine — no event, no log, indistinguishable from silence.
# Take the whole channel; lib/gate.mjs decides what is addressed to you, which is
# the only place that decision can be written down.
ARGS=(--no-presence --no-typing --subscribe ${subscribe} --kinds ${kinds.join(',')} --no-mention-filter)

GATE="\$(${JSON.stringify(join(ROOT, 'bin', 'buzzwake'))} internal-respond-to 2>/dev/null || true)"
if [ "\$GATE" = "anyone" ]; then
  # No author filtering. lib/gate.mjs still narrows to "@ me or a reply to me",
  # so this widens who may wake you, not what counts as addressed to you.
  ARGS+=(--respond-to anyone)
else
  PEERS="\$(${JSON.stringify(join(ROOT, 'bin', 'buzzwake'))} internal-peers 2>/dev/null || true)"
  if [ -n "\$PEERS" ]; then
    ARGS+=(--respond-to allowlist --respond-to-allowlist "\$PEERS")
  else
    # owner-only silently drops a colleague's mention — warn loudly in the log.
    echo "buzz-wake: 白名单为空，只有 owner 能叫醒你（buzzwake peer add <pubkey>）" >&2
    ARGS+=(--respond-to owner-only)
  fi
fi

exec ${JSON.stringify(buzzAcp)} "\${ARGS[@]}"
`
  writeFileSync(file, script)
  chmodSync(file, 0o700)
  return file
}

// ------------------------------------------------------------------ hooks

// Caps how long the watcher can stay armed, so it has to sit above
// WATCH_SECONDS (86400) with room to log its own expiry. Claude Code documents
// no upper bound — only a 600s default. 21900 is verified honoured: five
// watchers reached their own 21600s deadline and logged it, within a second of
// the mark. Above that nothing is measured, so if a future version clamps this,
// the tell is a watcher that vanishes with no "监听到期" line at all — a killed
// hook never gets to log — which surfaces as doctor's "没有 watcher" warning.
const HOOK_TIMEOUT = 86700

const wakeHookEntry = () => ({
  type: 'command',
  command: join(ROOT, 'hooks', 'buzz-wake.sh'),
  asyncRewake: true,
  timeout: HOOK_TIMEOUT,
})

const sessionHookEntry = () => ({
  type: 'command',
  command: join(ROOT, 'hooks', 'buzz-session.sh'),
  timeout: 15,
})

// Runs on every tool call, so it must stay cheap and must never block one:
// 5s is far above the measured 11.5ms and still fails fast if disk hangs.
const drainHookEntry = () => ({
  type: 'command',
  command: join(ROOT, 'hooks', 'buzz-drain.sh'),
  timeout: 5,
})

const turnHookEntry = () => ({
  type: 'command',
  command: join(ROOT, 'hooks', 'buzz-turn.sh'),
  timeout: 5,
})

const isOurs = (entry) => String(entry?.command || '').includes('buzz-wake/hooks/')

// Merge, never replace: the user's existing hooks stay exactly where they are.
const mergeHooks = () => {
  const settings = readJson(claudeSettings, {}) || {}
  if (existsSync(claudeSettings)) {
    const backup = `${claudeSettings}.buzzwake-bak-${nowSeconds()}`
    copyFileSync(claudeSettings, backup)
    say(color.dim(`  已备份 ${backup}`))
  }

  settings.hooks = settings.hooks || {}
  for (const event of ['Stop', 'SessionStart', 'PostToolUse', 'UserPromptSubmit']) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    // drop our own previous entries so re-running stays idempotent
    const cleaned = groups
      .map((group) => ({ ...group, hooks: (group.hooks || []).filter((entry) => !isOurs(entry)) }))
      .filter((group) => (group.hooks || []).length > 0)
    settings.hooks[event] = cleaned
  }

  settings.hooks.Stop.push({ hooks: [wakeHookEntry()] })
  settings.hooks.SessionStart.push({ hooks: [sessionHookEntry(), wakeHookEntry()] })
  // No matcher: which tool runs next says nothing about when a mention arrives,
  // and narrowing would just move the blind spot around.
  settings.hooks.PostToolUse.push({ hooks: [drainHookEntry()] })
  settings.hooks.UserPromptSubmit.push({ hooks: [turnHookEntry()] })

  writeJsonAtomic(claudeSettings, settings)
  say(color.ok(`  已合并 hook 到 ${claudeSettings}`))
}

// ----------------------------------------------------------------- launchd

const writePlist = (sidecar) => {
  ensureDir(join(homedir(), 'Library', 'LaunchAgents'))
  ensureDir(paths.logsDir)
  const log = join(paths.logsDir, 'sidecar.log')
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${sidecar}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin</string>
    <key>BUZZWAKE_HOME</key><string>${WAKE_HOME}</string>
  </dict>
</dict>
</plist>
`
  writeAtomic(plistPath, plist)
  say(color.ok(`  已写入 ${plistPath}`))
}

// -------------------------------------------------------------- work mode

// Two ways to receive the relay push:
//   desktop    – repoint Buzz Desktop's own harness at our spool agent
//   standalone – run our own buzz-acp under launchd
// Both can run at once; delivery is deduped by event id.
const chooseMode = async (pubkey, root) => {
  const spool = join(root, 'agent', 'spool-agent.mjs')
  const info = registryExists() ? describe(pubkey, spool) : { available: false }
  const hasAgent = Boolean(info.agent)

  if (hasAgent) {
    say(`  Buzz Desktop 里有一个用同一身份的托管 agent: ${color.bold(info.agent.name)}`)
    say(color.dim('  它默认会抢答 @mention —— 那是个没有你终端上下文的全新 Claude。'))
    say(color.dim('  把它的 harness 换成 buzz-wake 的 spool agent，它就只推送、不回帖，'))
    say(color.dim('  而且顺带帮我们做进程管理、断线重连和 presence。'))
  } else {
    say(color.dim('  Desktop 里没有用同一身份的托管 agent。'))
  }

  const choices = hasAgent ? ['desktop', 'standalone', 'both'] : ['standalone']
  const fallback = hasAgent ? 'both' : 'standalone'
  say('')
  say(color.dim('    desktop    只用 Desktop 的 harness（最省事，但 Desktop 关着就不推了）'))
  say(color.dim('    standalone 自己跑一个 launchd sidecar（Desktop 开不开都行）'))
  say(color.dim('    both       两个都要，按 event id 去重（最稳）'))
  const mode = await askChoice('  工作模式', choices, fallback)

  // Takeover needs Desktop closed, so it often can't happen during install.
  // Report that as unfinished work instead of a dim aside — until it's done the
  // managed agent still hijacks every @mention.
  let patchPending = false
  if ((mode === 'desktop' || mode === 'both') && hasAgent) {
    if (desktopRunning()) {
      say(color.warn('  ⚠ Buzz Desktop 正在运行，它会覆写注册表 —— 本次跳过接管。'))
      patchPending = true
    } else {
      try {
        const names = patchDesktop(pubkey, { node: NODE, spoolPath: spool })
        say(color.ok(`  已接管 Desktop 的 harness: ${names.join(', ')}`))
      } catch (error) {
        say(color.bad(`  接管失败: ${error.message}`))
        patchPending = true
      }
    }
  }
  return { mode, patchPending }
}

// ------------------------------------------------------------------- PATH

// Every instruction we print says to type bare `buzzwake`, so the command has to
// actually exist. Prefer a dir already on PATH; ~/.local/bin is the fallback
// even when absent from PATH, because telling the user one export line beats
// leaving them with command-not-found.
const BIN_DIRS = [join(homedir(), '.local', 'bin'), join(homedir(), 'bin'), '/usr/local/bin']

const linkOnPath = () => {
  const source = join(ROOT, 'bin', 'buzzwake')
  const onPath = (process.env.PATH || '').split(':')
  // Probe without side effects — mkdir'ing a candidate just to test it would
  // litter ~/bin on machines that never asked for one.
  const usable = (dir) => {
    try {
      accessSync(dir, constants.W_OK)
      return true
    } catch {
      return false
    }
  }
  let target = BIN_DIRS.find((dir) => onPath.includes(dir) && usable(dir))
  if (!target) {
    target = BIN_DIRS[0]
    try {
      ensureDir(target)
    } catch (error) {
      say(color.warn(`  ⚠ 没能创建 ${target}: ${error?.message || error}`))
      return { linkedTo: null, exportNeeded: null }
    }
  }
  const link = join(target, 'buzzwake')
  try {
    // symlinkSync throws on an existing path, and a stale link from an older
    // checkout must lose to this one.
    rmSync(link, { force: true })
    symlinkSync(source, link)
  } catch (error) {
    say(color.warn(`  ⚠ 没能链接 ${link}: ${error?.message || error}`))
    return { linkedTo: null, exportNeeded: null }
  }
  say(color.ok(`  ${link} → ${source}`))
  if (onPath.includes(target)) return { linkedTo: link, exportNeeded: null }
  say(color.warn(`  ⚠ ${target} 不在 PATH 上`))
  return { linkedTo: link, exportNeeded: target }
}

// ------------------------------------------------------------------- main

const main = async () => {
  say(color.bold('\nbuzz-wake 安装\n'))
  say('把 Buzz 的 @mention 从「等下一次轮询」变成「几秒内叫醒你终端里的 Claude」。')

  // Which identity this run installs is decided before the first question, and
  // getting it wrong means overwriting another identity's setup — so say it up front.
  const others = listProfiles().filter((profile) => !profile.current)
  say(`\n${color.dim('profile:')} ${color.bold(profileSlug())}  ${WAKE_HOME}  →  ${LAUNCHD_LABEL}`)
  if (others.length > 0)
    say(color.dim(`另外检测到 ${others.length} 个 profile（${others.map((p) => p.slug).join(', ')}），本次不会碰它们`))

  const total = 10

  step(1, total, '检查依赖')
  const { buzzAcp, buzz } = preflight()

  step(2, total, '凭据')
  const env = await collectEnv()

  step(3, total, '身份')
  const identity = resolveOwnIdentity(buzz, env)
  if (identity) say(`  你是 ${color.bold(identity.display_name || '(无名)')} ${color.dim(identity.pubkey)}`)
  else say(color.warn('  暂时连不上 relay，跳过身份确认（不影响安装）'))
  const clean = checkDesktopConflict(identity?.pubkey)

  step(4, total, '谁能叫醒你')
  const peers = await collectPeers(buzz, env, identity?.pubkey)
  if (peers.length > 0) say(color.ok(`  白名单 ${peers.length} 人`))
  else say(color.warn('  白名单为空 —— 只有你的 owner 能叫醒你，同事的 @ 会被丢弃'))

  step(5, total, '工作模式')
  const { mode, patchPending } = await chooseMode(identity?.pubkey, ROOT)

  step(6, total, '路由与恢复策略')
  const { config, subscribe } = await collectPolicy()
  config.resume_defaults.command_template = await detectClaudeCommand(config.resume_defaults)
  saveConfig(config)

  step(7, total, '写配置')
  writeJsonAtomic(paths.install, {
    node: NODE,
    root: ROOT,
    buzz,
    buzz_acp: buzzAcp,
    peers,
    mode,
    // anyone is only ever set on purpose, so a reinstall must not quietly narrow
    // it back to the allowlist — that would silently stop waking non-peers.
    respond_to:
      readJson(paths.install, {})?.respond_to === 'anyone'
        ? 'anyone'
        : peers.length > 0
          ? 'allowlist'
          : 'owner-only',
    subscribe,
    pubkey_hint: identity?.pubkey || null,
    installed_at: nowSeconds(),
  })
  const sidecar = writeSidecarScript({ buzzAcp, subscribe, kinds: config.kinds })
  say(color.ok(`  已写入 ${sidecar}`))
  // Skip the backlog buzz-acp would otherwise replay on first connect.
  writeJsonAtomic(paths.state, { ...(readJson(paths.state, {}) || {}), installed_cursor: nowSeconds() })

  step(8, total, '安装 hook 与后台服务')
  mergeHooks()
  if (mode === 'desktop') {
    say(color.dim('  desktop 模式：不装 launchd，由 Buzz Desktop 拉起 spool agent'))
  } else {
    writePlist(sidecar)
    cmdStart()
  }

  step(9, total, '把 buzzwake 放上 PATH')
  const { exportNeeded } = linkOnPath()

  step(10, total, '体检')
  await new Promise((resolve) => setTimeout(resolve, 4000))
  rl.close()
  const code = cmdDoctor()

  let n = 0
  say(`\n${color.bold('下一步')}（hook 已经生效，不用重开会话）`)
  if (exportNeeded) {
    say(color.warn(`  ${(n += 1)}. 先让 shell 找到这个命令，加到 ~/.zshrc 然后重开终端:`))
    say(`     ${color.bold(`export PATH="${exportNeeded}:$PATH"`)}`)
  }
  if (profileSlug() !== 'default') {
    // Hooks read BUZZWAKE_HOME from the environment they inherit, so the only thing
    // that binds a Claude window to this identity is having it exported before launch.
    say(color.warn(`  ${(n += 1)}. 这是非默认 profile —— 用这个身份跑 Claude 必须先带上 BUZZWAKE_HOME，加到 ~/.zshrc:`))
    say(`     ${color.bold(`alias claude-${profileSlug()}='BUZZWAKE_HOME=${WAKE_HOME} claude'`)}`)
    say(color.dim(`     buzzwake 同理：BUZZWAKE_HOME=${WAKE_HOME} buzzwake doctor`))
  }
  say(`  ${(n += 1)}. 在 Claude Code 会话里跑: ${color.bold('buzzwake bind --channel <频道名>')}`)
  say(color.dim('     顺带把当前 session 补注册进来，SessionStart hook 只对新会话生效'))
  say(`  ${(n += 1)}. 验证:                    ${color.bold('buzzwake test')}`)
  if (patchPending) {
    say(color.warn(`  ${(n += 1)}. 收编 Desktop 那个会抢答的托管 agent —— 必须做，否则每条 @ 都有两个回复:`))
    say(`     ${color.bold('osascript -e \'quit app "Buzz"\'')}   # 或者 ⌘Q`)
    say(`     ${color.bold('buzzwake desktop patch')}`)
    say(color.dim('     然后重开 Desktop。之后 buzzwake doctor 的「Desktop 抢答」那行会变绿。'))
  } else if (!clean) {
    say(color.warn('  ⚠ 先把 Desktop 里那个同身份的 agent 停掉，否则它会抢答'))
  }
  return code
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(color.bad(`\n安装失败: ${error?.message || error}`))
    if (process.env.BUZZWAKE_DEBUG) console.error(error?.stack)
    process.exit(1)
  })
