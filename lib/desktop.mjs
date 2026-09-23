import { copyFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { readJson, writeJsonAtomic, nowSeconds } from './util.mjs'

// Buzz Desktop's agent registry. Undocumented internal file — every read is
// defensive and every write keeps a timestamped backup next to it.
export const REGISTRY = join(
  homedir(),
  'Library',
  'Application Support',
  'xyz.block.buzz.app',
  'agents',
  'managed-agents.json',
)

export const desktopRunning = () => {
  try {
    execFileSync('/usr/bin/pgrep', ['-x', 'buzz-desktop'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export const readRegistry = () => {
  const data = readJson(REGISTRY, null)
  return Array.isArray(data) ? data : null
}

export const findAgent = (pubkey) => {
  const registry = readRegistry()
  if (!registry || !pubkey) return null
  return registry.find((agent) => agent?.pubkey === pubkey) || null
}

export const isPatched = (agent, spoolPath) =>
  Boolean(
    agent &&
      agent.agent_command_override &&
      Array.isArray(agent.agent_args) &&
      agent.agent_args.some((arg) => arg === spoolPath),
  )

export const describe = (pubkey, spoolPath) => {
  const registry = readRegistry()
  if (!registry) return { available: false }
  const agent = findAgent(pubkey)
  if (!agent) return { available: true, agent: null }
  return {
    available: true,
    agent: {
      name: agent.name,
      is_active: agent.is_active,
      respond_to: agent.respond_to,
      parallelism: agent.parallelism,
      override: agent.agent_command_override,
      args: agent.agent_args,
      patched: isPatched(agent, spoolPath),
    },
  }
}

const mutate = (pubkey, apply) => {
  const registry = readRegistry()
  if (!registry) throw new Error(`读不到 ${REGISTRY}`)
  if (desktopRunning())
    throw new Error('Buzz Desktop 正在运行 —— 它会覆写这个文件。请先退出 Desktop（⌘Q）。')

  copyFileSync(REGISTRY, `${REGISTRY}.buzzwake-bak-${nowSeconds()}`)
  const touched = []
  for (const agent of registry) {
    if (agent?.pubkey !== pubkey) continue
    apply(agent)
    touched.push(agent.name)
  }
  if (touched.length === 0) throw new Error(`注册表里没有 pubkey ${pubkey.slice(0, 12)}… 的 agent`)
  writeJsonAtomic(REGISTRY, registry)
  return touched
}

// Repoint Desktop's own harness at our spool agent. Desktop keeps doing the
// process management, reconnects and presence; it just stops answering.
export const patch = (pubkey, { node, spoolPath }) =>
  mutate(pubkey, (agent) => {
    agent.buzzwake_saved = agent.buzzwake_saved || {
      agent_command_override: agent.agent_command_override ?? null,
      agent_args: agent.agent_args ?? [],
      parallelism: agent.parallelism ?? null,
    }
    agent.agent_command_override = node
    agent.agent_args = [spoolPath]
    agent.parallelism = 1
    agent.is_active = true
  })

export const unpatch = (pubkey) =>
  mutate(pubkey, (agent) => {
    const saved = agent.buzzwake_saved
    if (saved) {
      agent.agent_command_override = saved.agent_command_override
      agent.agent_args = saved.agent_args
      if (saved.parallelism !== null) agent.parallelism = saved.parallelism
      delete agent.buzzwake_saved
    } else {
      agent.agent_command_override = null
      agent.agent_args = []
    }
  })

export const registryExists = () => existsSync(REGISTRY)
