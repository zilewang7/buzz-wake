import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, userInfo } from 'node:os'
import { color } from '../args.mjs'
import { paths } from '../paths.mjs'
import { LAUNCHD_LABEL } from '../install-info.mjs'
import { readText } from '../util.mjs'

export const plistPathFor = (label) =>
  join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`)

export const plistPath = plistPathFor(LAUNCHD_LABEL)
const domain = () => `gui/${userInfo().uid}`
const serviceTarget = (label = LAUNCHD_LABEL) => `${domain()}/${label}`

const launchctl = (args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8' })

// The label argument only exists for `buzzwake profiles`, which reports on the
// other profiles' services; everything else operates on its own label.
export const serviceRunning = (label = LAUNCHD_LABEL) => {
  const result = launchctl(['print', serviceTarget(label)])
  if (result.status !== 0) return { loaded: false, pid: null }
  const pid = result.stdout.match(/\bpid = (\d+)/)?.[1]
  return { loaded: true, pid: pid ? Number.parseInt(pid, 10) : null }
}

const UNLOAD_TIMEOUT_MS = 5000

// bootout returns once the job has been *asked* to exit, so bootstrapping the
// same label right after races the teardown and launchd answers
// `Bootstrap failed: 5: Input/output error`. A fresh install never sees it —
// nothing to boot out — while every upgrade does, which made install.sh fail
// for everyone re-running it. Poll until the label is really gone.
//
// bootout+bootstrap rather than kickstart -k on purpose: install.sh rewrites the
// plist, and kickstart restarts the job from launchd's cached copy of it.
const waitForUnload = () => {
  const deadline = Date.now() + UNLOAD_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!serviceRunning().loaded) return true
    spawnSync('/bin/sleep', ['0.1'])
  }
  return false
}

export const cmdStart = () => {
  if (!existsSync(plistPath)) {
    console.error(color.bad(`找不到 ${plistPath}，先跑 ./install.sh`))
    return 1
  }
  launchctl(['bootout', serviceTarget()])
  const unloaded = waitForUnload()
  const result = launchctl(['bootstrap', domain(), plistPath])
  if (result.status !== 0) {
    // Name the teardown when it is the likely cause — a bare EIO reads like a
    // broken install rather than "wait a second and try again".
    const why = unloaded
      ? ''
      : `\n旧 sidecar ${UNLOAD_TIMEOUT_MS / 1000}s 内没退干净，等几秒再跑 buzzwake start`
    console.error(color.bad(`启动失败: ${result.stderr.trim() || result.stdout.trim()}${why}`))
    return 1
  }
  console.log(color.ok('sidecar 已启动'))
  return 0
}

export const cmdStop = () => {
  const result = launchctl(['bootout', serviceTarget()])
  if (result.status !== 0 && !/No such process/i.test(result.stderr)) {
    console.error(color.bad(result.stderr.trim()))
    return 1
  }
  console.log(color.ok('sidecar 已停止'))
  return 0
}

export const cmdRestart = () => {
  const result = launchctl(['kickstart', '-k', serviceTarget()])
  if (result.status !== 0) return cmdStart()
  console.log(color.ok('sidecar 已重启'))
  return 0
}

export const cmdStatus = () => {
  const { loaded, pid } = serviceRunning()
  console.log(`launchd : ${loaded ? color.ok('已加载') : color.bad('未加载')}${pid ? ` (pid ${pid})` : ''}`)
  const lines = readText(join(paths.logsDir, 'sidecar.log'), '').split('\n')
  const connectAt = lines.findLastIndex((line) => line.includes('connected to relay'))
  console.log(`最后连接: ${connectAt === -1 ? color.dim('无记录') : lines[connectAt].slice(0, 140)}`)
  // Only errors newer than the last successful connect still matter.
  const lastError = lines.slice(connectAt + 1).filter((line) => /ERROR|panic|Error:/.test(line)).pop()
  if (lastError) console.log(`连接后错误: ${color.warn(lastError.slice(0, 160))}`)
  return 0
}

export const cmdLogs = (args) => {
  const file = args.router ? paths.routerLog : join(paths.logsDir, 'sidecar.log')
  if (!existsSync(file)) {
    console.error(color.bad(`还没有日志: ${file}`))
    return 1
  }
  const lines = args.lines ? String(args.lines) : '60'
  if (args.follow) {
    spawnSync('/usr/bin/tail', ['-f', '-n', lines, file], { stdio: 'inherit' })
    return 0
  }
  process.stdout.write(execFileSync('/usr/bin/tail', ['-n', lines, file], { encoding: 'utf8' }))
  return 0
}
