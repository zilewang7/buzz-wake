import { createInterface } from 'node:readline/promises'
import { existsSync, copyFileSync, rmSync, lstatSync, readlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { userInfo, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { color } from './args.mjs'
import { paths, claudeSettings, WAKE_HOME } from './paths.mjs'
import { readJson, writeJsonAtomic, nowSeconds } from './util.mjs'
import { LAUNCHD_LABEL, profileSlug } from './install-info.mjs'
import { listProfiles } from './profiles.mjs'
import { plistPath } from './cmd/service.mjs'

const rl = createInterface({ input: process.stdin, output: process.stdout })
const say = (text = '') => console.log(text)
const FORCE_SHARED = process.argv.includes('--hooks')
const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const stopService = () => {
  spawnSync('/bin/launchctl', ['bootout', `gui/${userInfo().uid}/${LAUNCHD_LABEL}`])
  if (existsSync(plistPath)) {
    rmSync(plistPath, { force: true })
    say(color.ok(`  已删除 ${plistPath}`))
  }
  say(color.ok('  sidecar 已停止'))
}

const OWN_LAUNCHER = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'buzzwake')

// Only unlink what points back into this checkout — a `buzzwake` from someone
// else's install, or a real file, is not ours to delete.
const removePathLink = () => {
  for (const dir of [join(homedir(), '.local', 'bin'), join(homedir(), 'bin'), '/usr/local/bin']) {
    const link = join(dir, 'buzzwake')
    try {
      if (!lstatSync(link).isSymbolicLink()) continue
      if (resolve(dir, readlinkSync(link)) !== OWN_LAUNCHER) continue
      rmSync(link, { force: true })
      say(color.ok(`  已删除 ${link}`))
    } catch {
      // not there, or not readable — nothing to clean up
    }
  }
}

const isOurs = (entry) => String(entry?.command || '').includes('buzz-wake/hooks/')

const removeHooks = () => {
  const settings = readJson(claudeSettings, null)
  if (!settings?.hooks) {
    say(color.dim('  settings.json 里没有 hook 需要清理'))
    return
  }
  copyFileSync(claudeSettings, `${claudeSettings}.buzzwake-bak-${nowSeconds()}`)
  let removed = 0
  for (const event of Object.keys(settings.hooks)) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : []
    settings.hooks[event] = groups
      .map((group) => {
        const kept = (group.hooks || []).filter((entry) => {
          if (isOurs(entry)) {
            removed += 1
            return false
          }
          return true
        })
        return { ...group, hooks: kept }
      })
      .filter((group) => (group.hooks || []).length > 0)
  }
  writeJsonAtomic(claudeSettings, settings)
  say(color.ok(`  已从 settings.json 移除 ${removed} 个 hook（其他 hook 未动）`))
}

// hooks in settings.json and the buzzwake symlink belong to the *checkout*, not to
// this profile — every profile sharing it uses the same ones. Removing them while
// another identity still runs would leave that identity silently deaf, which is
// exactly the class of breakage multi-profile support exists to prevent.
const sharingCheckout = (others) =>
  others.filter((profile) => resolve(profile.install.root || '') === CHECKOUT)

const main = async () => {
  say(color.bold('\nbuzz-wake 卸载\n'))
  say(color.dim(`  profile: ${profileSlug()} (${WAKE_HOME}) → ${LAUNCHD_LABEL}`))
  const others = listProfiles().filter((profile) => !profile.current)
  stopService()

  const shared = sharingCheckout(others)
  if (shared.length > 0 && !FORCE_SHARED) {
    say(color.warn(`  还有 ${shared.length} 个 profile 用着同一个 checkout: ${shared.map((p) => p.slug).join(', ')}`))
    say(color.warn('  hook 和 PATH 上的 buzzwake 是它们共用的，本次不动 —— 删了它们就收不到消息了。'))
    say(color.dim('  确实要一起删: ./uninstall.sh --hooks'))
  } else {
    removeHooks()
    removePathLink()
  }

  say('')
  const answer = (
    await rl.question(`要删掉状态目录 ${WAKE_HOME} 吗？里面有你的私钥备份和路由配置 (y/N): `)
  ).trim().toLowerCase()
  rl.close()

  if (answer.startsWith('y')) {
    rmSync(WAKE_HOME, { recursive: true, force: true })
    say(color.ok(`  已删除 ${WAKE_HOME}`))
    say(color.warn('  提醒: 私钥备份也一起没了，确认你别处还有。'))
  } else {
    say(color.dim(`  保留 ${WAKE_HOME}（私钥备份在 ${paths.env}）`))
  }

  say('\n卸载完成。已经打开的 Claude 会话里 watcher 会在当轮结束后自然退出。')
  if (others.length > 0)
    say(color.dim(`另外还有 ${others.length} 个 profile 在跑，没动它们: ${others.map((p) => p.slug).join(', ')}`))
  return 0
}

main().then((code) => process.exit(code))
