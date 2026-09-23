import { execFileSync } from 'node:child_process'
import { color } from '../args.mjs'
import { paths } from '../paths.mjs'
import { writeJsonAtomic } from '../util.mjs'
import { loadInstall, readEnvFile } from '../install-info.mjs'
import { cmdRestart } from './service.mjs'

const HEX64 = /^[0-9a-f]{64}$/i

// `users get` with no argument returns your own profile only, so a name has to be
// searched for explicitly — matching on that one-element list never resolved
// anything, which quietly made `peer add <显示名>` hex-only.
const searchUsers = (name) => {
  const env = { ...process.env, ...readEnvFile() }
  const raw = execFileSync('buzz', ['--format', 'compact', 'users', 'get', '--name', name], {
    encoding: 'utf8',
    env,
  })
  return JSON.parse(raw)
}

// Accept a hex pubkey or a display name; names are resolved through the relay.
// Returns { peer } on success, or { candidates } when the name is a substring of
// several — picking the first would put a stranger on the allowlist, which is the
// one list in here that must never be guessed at.
const resolvePeer = (input) => {
  if (HEX64.test(input)) return { peer: { pubkey: input.toLowerCase(), name: null } }
  let users = []
  try {
    users = searchUsers(input)
  } catch {
    return { candidates: [] } // relay unreachable
  }
  const exact = users.find((user) => user.display_name?.toLowerCase() === input.toLowerCase())
  const hit = exact || (users.length === 1 ? users[0] : null)
  if (!hit) return { candidates: users }
  return { peer: { pubkey: hit.pubkey, name: hit.display_name } }
}

export const cmdPeer = async (args) => {
  const action = args._[1] || 'list'
  const install = loadInstall()
  const peers = Array.isArray(install.peers) ? install.peers : []

  if (action === 'list') {
    console.log(`作者门禁: ${install.respond_to || 'owner-only'}`)
    if (peers.length === 0) console.log(color.dim('白名单为空 —— 只有你的 owner 能叫醒你'))
    for (const peer of peers) console.log(`  ${peer.pubkey}${peer.name ? `  ${peer.name}` : ''}`)
    return 0
  }

  const input = args._[2]
  if (!input) {
    console.error('用法: buzzwake peer add|rm <pubkey 或 显示名>')
    return 1
  }

  if (action === 'add') {
    const { peer: resolved, candidates } = resolvePeer(input)
    if (!resolved) {
      if (candidates.length > 0) {
        console.error(color.bad(`"${input}" 匹配到 ${candidates.length} 个人，说清楚是哪个:`))
        for (const user of candidates)
          console.error(`  ${user.pubkey}  ${user.display_name || '(无名)'}`)
      } else {
        console.error(color.bad(`解析不出 "${input}"。给一个 64 位 hex pubkey，或确认 relay 可达。`))
      }
      return 1
    }
    if (peers.some((peer) => peer.pubkey === resolved.pubkey)) {
      console.log(color.dim('已经在白名单里了'))
      return 0
    }
    peers.push(resolved)
    // Adding a peer must not narrow an `anyone` gate — that would be a downgrade
    // nobody asked for, and the allowlist is ignored under anyone anyway.
    const respond_to = install.respond_to === 'anyone' ? 'anyone' : 'allowlist'
    writeJsonAtomic(paths.install, { ...install, peers, respond_to })
    console.log(`${color.ok('已加入白名单')} ${resolved.name || ''} ${resolved.pubkey}`)
    console.log(color.dim('重启 sidecar 生效…'))
    return cmdRestart()
  }

  if (action === 'rm') {
    const next = peers.filter(
      (peer) => peer.pubkey !== input.toLowerCase() && peer.name !== input,
    )
    if (next.length === peers.length) {
      console.error(color.bad('白名单里没有这个人'))
      return 1
    }
    writeJsonAtomic(paths.install, { ...install, peers: next })
    console.log(color.ok('已移除'))
    return cmdRestart()
  }

  console.error(`未知子命令 ${action}`)
  return 1
}
