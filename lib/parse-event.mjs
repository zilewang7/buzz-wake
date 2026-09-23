import { nowSeconds } from './util.mjs'

// buzz-acp renders one or more Buzz events into a single ACP prompt. Every shape
// below was captured off a live relay, never inferred from the binary — see README pit 30.
//
// Buzz.app 0.5.22 (2026-09-04) rewrote the prompt as XML-ish blocks:
//
//   <context>
//   Scope: channel
//   Session scope: channel
//   Channel: dev-team (#11111111-…)
//   Hint: Use `buzz messages get --channel <UUID>` for recent messages if needed.
//   </context>
//
//   <buzz-event type="@mention">
//   Event ID: <hex64>
//   Channel: dev-team (#11111111-…)
//   Kind: 9
//   From: backend (npub: npub1…, hex: <hex64>)
//   Time: 2026-09-07T05:57:11+00:00
//   Content: <可跨行>
//   Tags: [[…]]
//   Parsed: mentions=[…]
//   </buzz-event>
//
// Up to 0.5.21 the same information came as a "[Context]" block, a
// "[Buzz event: …]" opener and "--- Event 87 (mentions) ---" separators between
// any further events. Both older shapes stay supported: one machine upgrading
// Buzz.app must not silently deafen the machines that have not.

// buzz-acp emits both tags on a line of their own, and that is the only thing
// separating a frame from a quotation: a message *about* this format writes
// `<buzz-event type="…">…</buzz-event>` inline, inside a sentence, in backticks.
//
// The first cut of this matched non-greedily to the first `</buzz-event>`
// anywhere, so a real event — a message explaining the 0.5.22 format —
// closed its own frame mid-sentence. Everything after it, the whole `Tags:` line
// included, was dropped. The event still parsed, still logged, still routed, and
// then gate.mjs discarded it for「没有 p tag」: a silent loss that only ever hits
// messages discussing buzz-wake itself, which is the worst possible selection.
const EVENT_BLOCK_OPEN_LINE_RE = /^<buzz-event\b[^>]*>\s*$/
const EVENT_BLOCK_CLOSE_LINE_RE = /^<\/buzz-event>\s*$/
const EVENT_BLOCK_OPEN_RE = /^<buzz-event\b[^>]*>\s*$/m
const EVENT_SPLIT_RE = /(?:^|\n)-{2,}\s*Event\s+\d+\s*\([^)]*\)\s*-{2,}\n/g
const EVENT_SECTION_RE = /(?:^|\n)\[Buzz event:[^\]]*\]\n/
const FIELD_RE = /^(Event ID|Channel|Kind|From|Time|Content|Tags|Scope|Hint|Reply To):\s?(.*)$/
const CHANNEL_RE = /^(.*?)\s*\(#([0-9a-f-]{36})\)\s*$/i
const HEX64_RE = /\b([0-9a-f]{64})\b/i
const HEX64_ONLY_RE = /^[0-9a-f]{64}$/i
const REPLY_TO_RE = /--reply-to\s+([0-9a-f]{64})/i

// Tags arrive as one line of JSON, followed by a human-readable "Parsed:" line
// that parseFields folds into the same field. Only the first line is JSON.
const parseTags = (raw) => {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw.split('\n')[0])
    return Array.isArray(parsed) ? parsed.filter(Array.isArray) : []
  } catch {
    return []
  }
}

const hexTags = (tags, name) =>
  tags.filter((tag) => tag[0] === name && HEX64_ONLY_RE.test(tag[1] || ''))

const mentionPubkeys = (tags) => hexTags(tags, 'p').map((tag) => tag[1].toLowerCase())

// NIP-10 marks the direct parent "reply" — even when that parent is also the
// thread root, which is how this relay writes a first-level reply. A lone e tag
// is the deprecated positional form, so read it as the parent. When both root
// and reply are present, root is deliberately ignored: two other people talking
// inside a thread I started are not talking to me.
const parentEventId = (tags) => {
  const eTags = hexTags(tags, 'e')
  const reply = eTags.find((tag) => tag[3] === 'reply')
  if (reply) return reply[1].toLowerCase()
  return eTags.length === 1 ? eTags[0][1].toLowerCase() : null
}

const flattenPromptText = (prompt) => {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return ''
  return prompt
    .map((block) => (typeof block === 'string' ? block : block?.text || block?.content || ''))
    .filter(Boolean)
    .join('\n\n')
}

// Line-oriented so a multi-line Content field stays intact.
const parseFields = (chunk) => {
  const fields = {}
  let current = null
  for (const line of chunk.split('\n')) {
    const match = line.match(FIELD_RE)
    if (match) {
      current = match[1]
      fields[current] = match[2]
    } else if (current) {
      fields[current] += `\n${line}`
    }
  }
  for (const key of Object.keys(fields)) fields[key] = fields[key].replace(/\s+$/, '')
  return fields
}

const splitChannel = (value) => {
  if (!value) return { name: null, id: null }
  const match = value.match(CHANNEL_RE)
  if (!match) return { name: value.trim() || null, id: null }
  return { name: match[1].trim() || null, id: match[2].toLowerCase() }
}

const relayEpoch = (value) => {
  if (!value) return null
  const ms = Date.parse(value.trim())
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000)
}

const splitAuthor = (value) => {
  if (!value) return { name: null, pubkey: null }
  const hex = value.match(/hex:\s*([0-9a-f]{64})/i)?.[1] || value.match(HEX64_RE)?.[1] || null
  const name = value.split('(')[0].trim()
  const looksLikeNpub = name.startsWith('npub1')
  return { name: looksLikeNpub || !name ? null : name, pubkey: hex ? hex.toLowerCase() : null }
}

// Where the context ends and the events begin is the only thing a buzz-acp
// upgrade has ever changed; the fields inside an event never did. Keeping that
// decision in one function is what makes the next version a one-branch change.
// Line-oriented for the same reason parseFields is: a tag only delimits when it
// owns its line. An unclosed block still yields its chunk — a truncated prompt
// should lose the tail, not the whole event.
const xmlChunks = (text) => {
  const chunks = []
  let current = null
  for (const line of text.split('\n')) {
    if (EVENT_BLOCK_OPEN_LINE_RE.test(line)) {
      if (current) chunks.push(current.join('\n'))
      current = []
    } else if (EVENT_BLOCK_CLOSE_LINE_RE.test(line)) {
      if (current) chunks.push(current.join('\n'))
      current = null
    } else if (current) {
      current.push(line)
    }
  }
  if (current) chunks.push(current.join('\n'))
  return chunks
}

const splitPrompt = (text) => {
  const blockIndex = text.search(EVENT_BLOCK_OPEN_RE)
  if (blockIndex !== -1)
    return { contextPart: text.slice(0, blockIndex), chunks: xmlChunks(text) }

  const sectionIndex = text.search(EVENT_SECTION_RE)
  if (sectionIndex !== -1) {
    const opener = text.slice(sectionIndex).match(EVENT_SECTION_RE)
    return {
      contextPart: text.slice(0, sectionIndex),
      chunks: text.slice(sectionIndex + opener[0].length).split(EVENT_SPLIT_RE),
    }
  }

  // A prompt may open straight with a separator instead of an opener. Keep the
  // separator so split() yields an empty first chunk, dropped for lacking an id.
  const separatorIndex = text.search(EVENT_SPLIT_RE)
  if (separatorIndex !== -1)
    return {
      contextPart: text.slice(0, separatorIndex),
      chunks: text.slice(separatorIndex).split(EVENT_SPLIT_RE),
    }

  return { contextPart: text, chunks: [] }
}

export const parsePromptEvents = (params) => {
  const text = flattenPromptText(params?.prompt)
  const { contextPart, chunks } = splitPrompt(text)

  const context = parseFields(contextPart)
  const contextChannel = splitChannel(context.Channel)
  const replyTo = contextPart.match(REPLY_TO_RE)?.[1]?.toLowerCase() || null
  // 0.5.22 put "Session scope: …" directly under "Scope: …". It is not a known
  // field, so parseFields folds it into Scope — keep the first line only.
  const scope = context.Scope?.split('\n')[0].trim() || null

  const received = nowSeconds()

  return chunks
    .map((chunk) => {
      const fields = parseFields(chunk)
      if (!fields['Event ID']) return null
      const channel = splitChannel(fields.Channel)
      const author = splitAuthor(fields.From)
      const tags = parseTags(fields.Tags)
      return {
        id: fields['Event ID'].trim().toLowerCase(),
        kind: Number.parseInt(fields.Kind, 10) || null,
        received_at: received,
        acp_session: params?.sessionId || null,
        scope,
        channel_id: channel.id || contextChannel.id,
        channel_label: channel.name || contextChannel.name,
        author_pubkey: author.pubkey,
        author_label: author.name,
        time: fields.Time?.trim() || null,
        // Epoch form of the relay timestamp, so end-to-end latency is one
        // subtraction instead of a cross-reference against router.log.
        created_at: relayEpoch(fields.Time),
        content: fields.Content || '',
        reply_to: replyTo,
        // Who this event is addressed to. Kept as derived scalars rather than the
        // raw tag array: the whole event is written into the pending spool file
        // and read back into a Claude prompt, so nothing goes in there that the
        // gate does not need.
        mention_pubkeys: mentionPubkeys(tags),
        parent_id: parentEventId(tags),
        text: chunk.trim(),
      }
    })
    .filter(Boolean)
}
