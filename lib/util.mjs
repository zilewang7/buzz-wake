import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const ensureDir = (dir) => mkdirSync(dir, { recursive: true })

export const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export const readText = (file, fallback = '') => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return fallback
  }
}

// Write via temp file + rename so a reader never sees a half-written file.
export const writeAtomic = (file, content, mode) => {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  writeFileSync(tmp, content, mode === undefined ? undefined : { mode })
  renameSync(tmp, file)
}

export const writeJsonAtomic = (file, value, mode) =>
  writeAtomic(file, `${JSON.stringify(value, null, 2)}\n`, mode)

export const appendJsonl = (file, value) => {
  ensureDir(dirname(file))
  appendFileSync(file, `${JSON.stringify(value)}\n`)
}

export const nowSeconds = () => Math.floor(Date.now() / 1000)

// Drop a file into a directory atomically (same filesystem rename).
export const dropFile = (dir, name, content) => {
  ensureDir(dir)
  const tmp = join(dir, `.tmp-${process.pid}-${randomUUID().slice(0, 8)}`)
  writeFileSync(tmp, content)
  const target = join(dir, name)
  renameSync(tmp, target)
  return target
}

export const truncate = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max)}…[截断 ${text.length - max} 字]`

export const logLine = (file, message) => {
  ensureDir(dirname(file))
  appendFileSync(file, `${new Date().toISOString()} ${message}\n`)
}
