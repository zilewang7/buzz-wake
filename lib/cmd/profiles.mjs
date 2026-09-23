import { homedir } from 'node:os'
import { color } from '../args.mjs'
import { listProfiles, plistHome } from '../profiles.mjs'
import { serviceRunning } from './service.mjs'

const short = (path) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path)

const serviceCell = (profile) => {
  if ((profile.install.mode || 'standalone') === 'desktop') return color.dim('desktop 模式，无 launchd')
  const { loaded, pid } = serviceRunning(profile.label)
  if (!loaded) return color.bad('未加载')
  return color.ok(`运行中 pid ${pid ?? '?'}`)
}

export const cmdProfiles = () => {
  const profiles = listProfiles()
  if (profiles.length === 0) {
    console.log(color.warn('没找到任何 profile（~ 下没有带 install.json 的 .buzz-wake* 目录）'))
    return 1
  }

  for (const profile of profiles) {
    const mark = profile.current ? color.bold('*') : ' '
    const pubkey = profile.install.pubkey_hint?.slice(0, 8) || color.dim('身份未知')
    console.log(
      `${mark} ${color.bold(profile.slug.padEnd(16))} ${short(profile.home).padEnd(34)} ${profile.label.padEnd(30)} ${pubkey}  ${serviceCell(profile)}`,
    )
    // Same basename under different parents derives the same label, so one plist
    // silently overwrites the other. We do not prevent it — we name it.
    const owner = plistHome(profile.label)
    if (owner && owner !== profile.home)
      console.log(
        color.warn(`    ⚠ label ${profile.label} 的 plist 指向 ${short(owner)} —— 这个 label 被别的 profile 占了`),
      )
  }
  console.log(color.dim('\n* = 当前（BUZZWAKE_HOME 决定）；换 profile 就 export BUZZWAKE_HOME=<上面的目录>'))
  return 0
}
