import { color } from '../args.mjs'
import { allSessions, forgetSession } from '../sessions.mjs'
import { loadConfig } from '../config.mjs'
import { nowSeconds } from '../util.mjs'

const STATE_LABEL = {
  live: color.ok('live   '),
  dormant: color.warn('dormant'),
  gone: color.bad('gone   '),
}

const ago = (timestamp) => {
  if (!timestamp) return '-'
  const seconds = nowSeconds() - timestamp
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`
  return `${Math.floor(seconds / 86400)}d`
}

const boundChannels = (config, session) => {
  const targets = new Set([`session:${session.session_id}`, `cwd:${session.cwd}`])
  if (session.label) targets.add(`label:${session.label}`)
  return config.rules
    .filter((rule) => (rule.to || []).some((target) => targets.has(target)))
    .map((rule) => rule.channel)
}

export const cmdSessions = (args) => {
  const sessions = allSessions()
  if (args.json) {
    console.log(JSON.stringify(sessions, null, 2))
    return 0
  }
  if (sessions.length === 0) {
    console.log(color.dim('还没有注册过 session。在一个 Claude Code 会话里跑 buzzwake bind 即可。'))
    return 0
  }
  const config = loadConfig()
  console.log(`${color.bold('状态')}    ${color.bold('session')}   ${color.bold('待投')} ${color.bold('最后活动')} ${color.bold('标签/目录')}`)
  for (const session of sessions) {
    const channels = boundChannels(config, session)
    const bound = channels.length > 0 ? color.dim(` ← ${channels.join(', ')}`) : ''
    console.log(
      `${STATE_LABEL[session.state]} ${session.session_id.slice(0, 8)}  ${String(session.pending).padStart(3)}  ${ago(session.last_seen).padStart(6)}  ${session.label ? `${session.label} ` : ''}${color.dim(session.cwd)}${bound}`,
    )
  }
  return 0
}

export const cmdForget = (args) => {
  const target = args._[1]
  if (!target) {
    console.error('用法: buzzwake forget <session-id 前缀|--gone>')
    return 1
  }
  const sessions = allSessions()
  const victims =
    target === '--gone'
      ? sessions.filter((session) => session.state === 'gone')
      : sessions.filter((session) => session.session_id.startsWith(target))
  if (victims.length === 0) {
    console.error(color.bad('没有匹配的 session'))
    return 1
  }
  for (const victim of victims) {
    forgetSession(victim.session_id)
    console.log(`${color.ok('已移除')} ${victim.session_id}`)
  }
  return 0
}
