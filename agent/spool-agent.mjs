#!/usr/bin/env node
// Fake ACP agent for buzz-acp.
//
// It never thinks and never replies to Buzz. Every session/prompt is spooled
// to disk and immediately answered with end_turn, which turns buzz-acp into a
// clean "relay WebSocket -> local file" push pipe.
//
// Protocol: newline-delimited JSON-RPC 2.0 over stdio.

import { createInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { paths } from '../lib/paths.mjs'
import { appendJsonl, logLine, nowSeconds } from '../lib/util.mjs'
import { parsePromptEvents } from '../lib/parse-event.mjs'
import { filterUnseen } from '../lib/seen.mjs'
import { loadConfig } from '../lib/config.mjs'
import { deliver } from '../lib/deliver.mjs'
import { addressedToMe, wakeGateEnabled } from '../lib/gate.mjs'

const CAPTURE_RAW = process.env.BUZZWAKE_CAPTURE_RAW === '1'

const send = (payload) => process.stdout.write(`${JSON.stringify(payload)}\n`)

const reply = (id, result) => send({ jsonrpc: '2.0', id, result })

const log = (message) => logLine(paths.routerLog, `[spool] ${message}`)

const INITIALIZE_RESULT = {
  protocolVersion: 2,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: false, audio: false, embeddedContext: true },
  },
  authMethods: [],
}

const eventsLog = join(paths.logsDir, 'events.jsonl')
const unparsedLog = join(paths.logsDir, 'unparsed-prompts.jsonl')

const handlePrompt = (params) => {
  const parsed = parsePromptEvents(params)
  if (parsed.length === 0) {
    // A buzz-acp upgrade can change the prompt layout (0.5.22 did). Keep the
    // raw params so the new shape can be read off disk instead of guessed.
    appendJsonl(unparsedLog, { at: nowSeconds(), params })
    log(`prompt contained no parseable Buzz event; raw params appended to ${unparsedLog}`)
    return
  }

  const allowedKinds = new Set(loadConfig().kinds)
  const interesting = parsed.filter((event) => event.kind === null || allowedKinds.has(event.kind))
  const skipped = parsed.length - interesting.length
  if (skipped > 0) log(`skipped ${skipped} event(s) by kind filter`)

  // The sidecar hands over the whole channel now, so "is this for me" is decided
  // here instead of by the relay's #p filter.
  const gated = wakeGateEnabled()

  for (const event of filterUnseen(interesting)) {
    appendJsonl(eventsLog, event)
    if (gated) {
      const verdict = addressedToMe(event)
      if (verdict.reason)
        logLine(
          paths.routerLog,
          `[gate] ${verdict.pass ? 'passed' : 'dropped'} ${event.id.slice(0, 8)} from=${(event.author_pubkey || '?').slice(0, 8)} ${verdict.reason}`,
        )
      if (!verdict.pass) continue
    }
    try {
      deliver(event)
    } catch (error) {
      log(`deliver failed for ${event.id}: ${error?.stack || error}`)
    }
  }
}

const handleRequest = (message) => {
  const { id, method, params } = message

  switch (method) {
    case 'initialize':
      return reply(id, INITIALIZE_RESULT)

    case 'session/new':
      return reply(id, { sessionId: `spool-${randomUUID()}` })

    case 'session/load':
      return reply(id, {})

    case 'session/prompt':
      handlePrompt(params || {})
      return reply(id, { stopReason: 'end_turn' })

    default:
      // Be permissive: unknown requests (set_config_option, steering, ...)
      // get an empty success so buzz-acp never tears the session down.
      return reply(id, {})
  }
}

const main = () => {
  logLine(paths.routerLog, `[spool] started pid=${process.pid}`)
  const rl = createInterface({ input: process.stdin })

  rl.on('line', (line) => {
    const trimmed = line.trim()
    if (!trimmed) return

    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      log(`unparseable line: ${trimmed.slice(0, 200)}`)
      return
    }

    if (CAPTURE_RAW) appendJsonl(paths.rawLog, { at: nowSeconds(), frame: message })

    // Notifications carry no id and must not be answered.
    if (message.id === undefined || message.id === null) return

    try {
      handleRequest(message)
    } catch (error) {
      log(`handler failed for ${message.method}: ${error?.stack || error}`)
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } })
    }
  })

  rl.on('close', () => {
    logLine(paths.routerLog, '[spool] stdin closed, exiting')
    process.exit(0)
  })
}

main()
