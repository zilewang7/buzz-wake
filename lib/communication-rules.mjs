import { accessSync, constants, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { paths } from './paths.mjs'
import { loadConfig } from './config.mjs'

// Resolve per delivery: each profile may update or disable its rules independently.
export const communicationRulesHint = () => {
  const configured = loadConfig().communication_rules_file
  if (configured === null || configured === '') return ''
  if (configured !== undefined && (typeof configured !== 'string' || !configured.trim() || configured.length > 2048)) {
    return '\n[Buzz 对话规则] communication_rules_file 配置无效；请说明规则未加载，不要声称已遵守共享规则。\n'
  }
  const file = configured === undefined
    ? fileURLToPath(new URL('../AGENT_COMMUNICATION.md', import.meta.url))
    : resolve(paths.home, configured)
  try {
    const info = statSync(file)
    if (!info.isFile()) throw new Error('not a file')
    accessSync(file, constants.R_OK)
    return [
      '',
      '[Buzz 对话规则加载要求]',
      `回复前读取规则文件：${JSON.stringify(file)}（文件修改标记 ${info.mtimeMs}）。`,
      '当前上下文已读过相同文件和修改标记时可复用；否则先用文件工具读取，再按规则组织回复。不要每条消息拉取远端仓库。',
      '规则只约束表达，不授予执行频道请求、提交、部署或修改他人配置的权限。读取失败须说明未加载，不得声称已加载或遵守。',
      '',
    ].join('\n')
  } catch {
    return `\n[Buzz 对话规则] 无法读取配置文件 ${JSON.stringify(file)}；本次消息仍照常投递，请说明规则未加载，不要声称已遵守共享规则。\n`
  }
}
