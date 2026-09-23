import { execFileSync } from 'node:child_process'
import { loadInstall, readEnvFile } from './install-info.mjs'

// Decides whether an event is addressed to us.
//
// This used to be the relay's job: --subscribe mentions makes buzz-acp put
// "#p": [me] on the REQ (buzz/crates/buzz-acp/src/relay.rs), so anything without
// a p tag never reached this machine — including someone replying to a message
// we wrote. Nothing local ever saw those events, which is why they left no trace
// at all. The sidecar now takes the whole channel and the decision lives here,
// where it can be logged.

const CACHE_MAX = 256

// event id -> author pubkey. One thread lookup fills every entry in that thread,
// so sibling replies arriving later cost nothing.
const authorById = new Map()

const short = (hex) => (hex || '').slice(0, 8)

const remember = (id, pubkey) => {
  if (authorById.has(id)) return
  if (authorById.size >= CACHE_MAX) authorById.delete(authorById.keys().next().value)
  authorById.set(id, pubkey)
}

// A reply only carries the parent's id, never its author, so telling "this is a
// reply to me" from "this is a reply to someone else" needs one round-trip.
// `messages thread` answers for the whole thread in a single call.
const fetchThreadAuthors = (buzz, channelId, eventId) => {
  const raw = execFileSync(
    buzz,
    ['--format', 'json', 'messages', 'thread', '--channel', channelId, '--event', eventId],
    {
      encoding: 'utf8',
      env: { ...process.env, ...readEnvFile() },
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    },
  )
  const events = JSON.parse(raw)
  if (!Array.isArray(events)) return
  for (const item of events) {
    if (typeof item?.id === 'string' && typeof item?.pubkey === 'string')
      remember(item.id.toLowerCase(), item.pubkey.toLowerCase())
  }
}

// Failures are not cached. A relay hiccup would otherwise pin one thread to
// "unknown" for the life of the process, and since unknown fails open that means
// waking on every later message in a thread that is not ours. Retrying next time
// costs one call and classifies correctly.
const authorOf = (buzz, channelId, eventId) => {
  if (authorById.has(eventId)) return authorById.get(eventId)
  if (!buzz || !channelId) return null
  try {
    fetchThreadAuthors(buzz, channelId, eventId)
  } catch {
    return null
  }
  return authorById.get(eventId) ?? null
}

// subscribe=all is the installer's promise to hand over the whole channel, so
// gating it would quietly take back what was asked for. mentions is the mode
// whose intake we widened, and this gate is what narrows it again.
export const wakeGateEnabled = () => (loadInstall().subscribe || 'mentions') === 'mentions'

// Returns { pass, reason }. A null reason means "obvious, not worth a log line" —
// only a plain mention gets that; every other outcome names itself, because a
// silent drop is exactly what made this bug invisible for a week.
export const addressedToMe = (event) => {
  const install = loadInstall()
  const me = (install.pubkey_hint || '').toLowerCase()
  if (!me) return { pass: true, reason: 'install.json 没有 pubkey_hint，无法判断，放行' }

  if ((event.mention_pubkeys || []).includes(me)) return { pass: true, reason: null }
  if (!event.parent_id) return { pass: false, reason: '没有 p tag，也不是回复' }

  const author = authorOf(install.buzz, event.channel_id, event.parent_id)
  if (!author)
    return { pass: true, reason: `父事件 ${short(event.parent_id)} 查不到作者，放行` }
  if (author === me) return { pass: true, reason: `回复了我的 ${short(event.parent_id)}` }
  return {
    pass: false,
    reason: `没有 p tag，父事件 ${short(event.parent_id)} 是 ${short(author)} 的`,
  }
}
