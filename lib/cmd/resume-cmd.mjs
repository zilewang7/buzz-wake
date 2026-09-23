import { color } from '../args.mjs'
import { loadConfig, saveConfig, RESUME_MODES, DEFAULT_RESUME } from '../config.mjs'
import { TERMINALS, terminalAvailable } from '../terminals.mjs'
import { allSessions, readMeta, sessionState } from '../sessions.mjs'
import { performResume, autoResumeGate, GATE_REASONS } from '../resume.mjs'

export const cmdResume = (args) => {
  const prefix = args._[1]
  if (!prefix) {
    console.error('用法: buzzwake resume <session-id 前缀> [--force]')
    return 1
  }
  const match = allSessions().filter((session) => session.session_id.startsWith(prefix))
  if (match.length === 0) {
    console.error(color.bad('没有匹配的 session，跑 buzzwake sessions 看看'))
    return 1
  }
  if (match.length > 1) {
    console.error(color.bad(`前缀 ${prefix} 匹配到 ${match.length} 个 session，请写长一点`))
    return 1
  }

  const meta = readMeta(match[0].session_id)
  const state = sessionState(meta)
  if (state === 'live') {
    console.log(color.warn('这个 session 还活着，不需要 resume —— 它会被 watcher 直接唤醒。'))
    return 0
  }
  if (state === 'gone') {
    console.error(color.bad('transcript 已不存在，无法恢复。'))
    return 1
  }

  const policy = loadConfig().resume_defaults
  if (!args.force) {
    const gate = autoResumeGate(meta, policy)
    if (!gate.ok) {
      console.error(color.warn(`被限流拦下: ${GATE_REASONS[gate.reason] || gate.reason}`))
      console.error(color.dim('确实要开就加 --force'))
      return 1
    }
  }

  const result = performResume(meta, policy, {})
  if (!result.opened) {
    console.log(color.dim('没有待投递的消息，不需要开窗。'))
    return 0
  }
  console.log(`${color.ok('已开窗恢复')} ${meta.session_id.slice(0, 8)}（${result.messages} 条消息）`)
  return 0
}

const NUMERIC_KEYS = ['cooldown_seconds', 'max_windows_per_hour']

export const cmdResumePolicy = (args) => {
  const config = loadConfig()
  const policy = config.resume_defaults

  const changes = []
  if (args.mode) {
    if (!RESUME_MODES.includes(String(args.mode))) {
      console.error(color.bad(`--mode 只能是 ${RESUME_MODES.join(' | ')}`))
      return 1
    }
    policy.mode = String(args.mode)
    changes.push(`mode=${policy.mode}`)
  }
  if (args.terminal) {
    if (!TERMINALS.includes(String(args.terminal))) {
      console.error(color.bad(`--terminal 只能是 ${TERMINALS.join(' | ')}`))
      return 1
    }
    policy.terminal = String(args.terminal)
    if (!terminalAvailable(policy.terminal)) console.log(color.warn(`注意: ${policy.terminal} 当前不可用`))
    changes.push(`terminal=${policy.terminal}`)
  }
  if (args.cooldown !== undefined) {
    policy.cooldown_seconds = Number.parseInt(String(args.cooldown), 10) || 0
    changes.push(`cooldown=${policy.cooldown_seconds}s`)
  }
  if (args['max-per-hour'] !== undefined) {
    policy.max_windows_per_hour = Number.parseInt(String(args['max-per-hour']), 10) || 0
    changes.push(`max_per_hour=${policy.max_windows_per_hour}`)
  }
  if (args['quiet-hours'] !== undefined) {
    const value = String(args['quiet-hours'])
    policy.quiet_hours = value === 'off' ? null : value.split('-')
    changes.push(`quiet_hours=${value}`)
  }
  if (args['launch-template']) {
    policy.launch_template = String(args['launch-template'])
    changes.push('launch_template 已更新')
  }
  if (args['command-template']) {
    policy.command_template = String(args['command-template'])
    changes.push('command_template 已更新')
  }
  if (args.reset) {
    config.resume_defaults = { ...DEFAULT_RESUME }
    changes.push('已恢复默认')
  }

  if (changes.length === 0) {
    console.log('当前 resume 策略:')
    for (const [key, value] of Object.entries(policy)) {
      const marker = NUMERIC_KEYS.includes(key) ? '' : ''
      console.log(`  ${key.padEnd(20)} ${marker}${JSON.stringify(value)}`)
    }
    console.log()
    console.log(color.dim('可改: --mode --terminal --cooldown --max-per-hour --quiet-hours 22:00-09:00|off --reset'))
    return 0
  }

  saveConfig(config)
  console.log(`${color.ok('已更新')} ${changes.join('，')}`)
  return 0
}
