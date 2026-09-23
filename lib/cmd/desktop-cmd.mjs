import { join } from 'node:path'
import { color } from '../args.mjs'
import { loadInstall } from '../install-info.mjs'
import { describe, patch, unpatch, desktopRunning, registryExists } from '../desktop.mjs'

const spoolPath = (install) => join(install.root || process.cwd(), 'agent', 'spool-agent.mjs')

export const cmdDesktop = async (args) => {
  const action = args._[1] || 'status'
  const install = loadInstall()
  const pubkey = args.pubkey || install.pubkey_hint

  if (!registryExists()) {
    console.log(color.dim('这台机器上没有 Buzz Desktop 的 agent 注册表，跳过。'))
    return 0
  }
  if (!pubkey) {
    console.error(color.bad('不知道你的 pubkey。先跑 ./install.sh，或传 --pubkey <hex>'))
    return 1
  }

  const spool = spoolPath(install)

  if (action === 'status') {
    const info = describe(pubkey, spool)
    console.log(`Desktop 进程 : ${desktopRunning() ? color.warn('运行中') : color.dim('未运行')}`)
    if (!info.agent) {
      console.log(color.dim('注册表里没有用这个身份的托管 agent —— 不会抢答。'))
      return 0
    }
    const a = info.agent
    console.log(`托管 agent   : ${a.name}`)
    console.log(`  是否接管   : ${a.patched ? color.ok('已接管（不会抢答）') : color.bad('未接管 —— 它会抢答')}`)
    console.log(`  override   : ${a.override || color.dim('(空)')}`)
    console.log(`  args       : ${JSON.stringify(a.args)}`)
    console.log(`  respond_to : ${a.respond_to}   parallelism: ${a.parallelism}`)
    if (!a.patched) console.log(color.dim('  → buzzwake desktop patch（需先退出 Desktop）'))
    return a.patched ? 0 : 1
  }

  if (action === 'patch' || action === 'unpatch') {
    if (desktopRunning()) {
      console.error(color.bad('Buzz Desktop 正在运行，它会覆写注册表 —— 改了也白改。'))
      console.error(`先退出它:  ${color.bold(`osascript -e 'quit app "Buzz"'`)}   ${color.dim('（或 ⌘Q）')}`)
      console.error(`再重跑:    ${color.bold(`buzzwake desktop ${action}`)}`)
      return 1
    }
    try {
      const names =
        action === 'patch' ? patch(pubkey, { node: install.node || process.execPath, spoolPath: spool }) : unpatch(pubkey)
      console.log(`${color.ok(action === 'patch' ? '已接管' : '已还原')} ${names.join(', ')}`)
      console.log(color.dim('重开 Buzz Desktop 生效。'))
      return 0
    } catch (error) {
      console.error(color.bad(String(error.message || error)))
      return 1
    }
  }

  console.error(`未知子命令 ${action}（可用: status | patch | unpatch）`)
  return 1
}
