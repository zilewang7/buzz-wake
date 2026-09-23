import { parseArgs, color } from './args.mjs'
import { cmdBind, cmdUnbind, cmdRoutes } from './cmd/bind.mjs'
import { cmdSessions, cmdForget } from './cmd/sessions.mjs'
import { cmdDoctor } from './cmd/doctor.mjs'
import { cmdResume, cmdResumePolicy } from './cmd/resume-cmd.mjs'
import { cmdPeer } from './cmd/peer.mjs'
import { cmdTest } from './cmd/test.mjs'
import { cmdDesktop } from './cmd/desktop-cmd.mjs'
import { cmdStart, cmdStop, cmdRestart, cmdStatus, cmdLogs } from './cmd/service.mjs'
import { cmdProfiles } from './cmd/profiles.mjs'
import {
  cmdInternalRegister,
  cmdInternalWatch,
  cmdInternalDrain,
  cmdInternalTouch,
  cmdInternalPeers,
  cmdInternalRespondTo,
} from './cmd/internal.mjs'

const HELP = `${color.bold('buzzwake')} — 让 Buzz 的 @ 立刻叫醒终端里的 Claude

${color.bold('日常')}
  buzzwake bind --channel <名字|UUID>   把当前 session 绑到一个频道
      --label <名字>       绑到一个角色：规则写 label:<名字>，认领它的会话收消息
                           换窗口就在新会话里重跑同一条命令移交，不用改配置
                           没人认领时消息不投递（不退回 newest），doctor 会报
      --pin                钉死当前 session id（compact 和 claude -c 都不换 id，
                           只有开全新会话才换；换了 doctor 会报）
      --cwd                绑目录（恢复时用 claude -c，同目录多窗口会扇出）
      默认绑 newest —— 最近活跃的那一个 session，但不看目录
      --resume off|notify|ask|auto   这个频道关窗后怎么办
      --from <pubkey>      只匹配某个人发的消息
  buzzwake unbind [--session <前缀>]   解绑当前 session；没绑东西会报错而不是假装成功
  buzzwake routes [--json]             看全部路由规则
  buzzwake sessions [--json]           看所有 session 及其 live/dormant/gone 状态
  buzzwake doctor                      体检，装完先跑这个
  buzzwake test [--dormant]            自测；--dormant 验证自动开窗

${color.bold('关窗后自动恢复')}
  buzzwake resume <session前缀> [--force]
  buzzwake resume-policy               看当前策略
      --mode off|notify|ask|auto  --terminal warp|terminal.app|custom
      --cooldown <秒>  --max-per-hour <n>  --quiet-hours 22:00-09:00|off
      --reset

${color.bold('服务与白名单')}
  buzzwake start | stop | restart | status
  buzzwake logs [--router] [--follow] [--lines n]
  buzzwake peer list | add <pubkey|显示名> | rm <pubkey>
  buzzwake desktop status | patch | unpatch   Desktop 托管 agent 的接管状态
  buzzwake forget <session前缀|--gone>

${color.bold('一台机器多身份')}
  buzzwake profiles                    列出这台机器上所有 profile（身份、label、服务状态）
      每个 profile 就是一个 BUZZWAKE_HOME 目录，各自的私钥、路由、会话
      切换：export BUZZWAKE_HOME=~/.buzz-wake-<名字> 之后再跑 claude / buzzwake
`

const COMMANDS = {
  bind: cmdBind,
  unbind: cmdUnbind,
  routes: cmdRoutes,
  sessions: cmdSessions,
  forget: cmdForget,
  doctor: cmdDoctor,
  resume: cmdResume,
  'resume-policy': cmdResumePolicy,
  peer: cmdPeer,
  test: cmdTest,
  desktop: cmdDesktop,
  start: cmdStart,
  stop: cmdStop,
  restart: cmdRestart,
  status: cmdStatus,
  logs: cmdLogs,
  profiles: cmdProfiles,
  'internal-register': cmdInternalRegister,
  'internal-watch': cmdInternalWatch,
  'internal-drain': cmdInternalDrain,
  'internal-touch': cmdInternalTouch,
  'internal-peers': cmdInternalPeers,
  'internal-respond-to': cmdInternalRespondTo,
}

const main = async () => {
  const args = parseArgs(process.argv.slice(2))
  const name = args._[0]

  if (!name || name === 'help' || args.help) {
    console.log(HELP)
    return 0
  }

  const command = COMMANDS[name]
  if (!command) {
    console.error(color.bad(`未知命令: ${name}`))
    console.error(color.dim('buzzwake help 看用法'))
    return 1
  }

  return (await command(args)) || 0
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(color.bad(`出错: ${error?.message || error}`))
    if (process.env.BUZZWAKE_DEBUG) console.error(error?.stack)
    process.exit(1)
  })
