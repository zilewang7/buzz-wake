import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { WAKE_HOME } from './paths.mjs'
import { launchdLabel, profileSlug } from './install-info.mjs'
import { readJson, readText } from './util.mjs'
import { plistPathFor } from './cmd/service.mjs'

// Profiles are derived, never registered: a directory under ~ named .buzz-wake*
// with an install.json in it IS a profile. A registry file would be a second
// source of truth that can disagree with reality; a scan cannot.
export const listProfiles = () => {
  const found = new Map()
  const add = (home) => {
    const key = resolve(home)
    if (found.has(key)) return
    const install = readJson(join(key, 'install.json'), null)
    if (!install) return
    found.set(key, {
      home: key,
      slug: profileSlug(key),
      label: launchdLabel(key),
      install,
      current: key === resolve(WAKE_HOME),
    })
  }

  try {
    for (const name of readdirSync(homedir())) {
      if (!name.startsWith('.buzz-wake')) continue
      const home = join(homedir(), name)
      try {
        if (statSync(home).isDirectory()) add(home)
      } catch {
        // raced or unreadable — not a profile we can report on
      }
    }
  } catch {
    // unreadable home dir; the current profile below still gets listed
  }

  // A BUZZWAKE_HOME outside ~ (or one still mid-install) would otherwise be
  // missing from the list you are reading it with.
  add(WAKE_HOME)
  return [...found.values()].sort((a, b) => a.slug.localeCompare(b.slug))
}

// Our own writer emits BUZZWAKE_HOME into the plist, which makes label collisions
// (two same-named dirs under different parents) detectable instead of silent:
// whoever wrote the plist last owns the label.
export const plistHome = (label) => {
  const file = plistPathFor(label)
  if (!existsSync(file)) return null
  const match = readText(file, '').match(
    /<key>BUZZWAKE_HOME<\/key>\s*<string>([^<]*)<\/string>/,
  )
  return match ? match[1] : null
}
