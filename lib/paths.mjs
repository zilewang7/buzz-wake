import { homedir } from 'node:os'
import { join } from 'node:path'

// Runtime state lives outside ~/.buzz so Buzz Desktop's nest migrations
// can never clobber it. Override with BUZZWAKE_HOME.
export const WAKE_HOME = process.env.BUZZWAKE_HOME || join(homedir(), '.buzz-wake')

export const paths = {
  home: WAKE_HOME,
  env: join(WAKE_HOME, 'env'),
  routes: join(WAKE_HOME, 'routes.json'),
  state: join(WAKE_HOME, 'state.json'),
  install: join(WAKE_HOME, 'install.json'),
  cursor: join(WAKE_HOME, 'cursor'),
  sessionsDir: join(WAKE_HOME, 'sessions'),
  logsDir: join(WAKE_HOME, 'logs'),
  resumeLog: join(WAKE_HOME, 'resume-log.jsonl'),
  rawLog: join(WAKE_HOME, 'logs', 'acp-raw.jsonl'),
  routerLog: join(WAKE_HOME, 'logs', 'router.log'),
  locksDir: join(WAKE_HOME, 'locks'),

  sessionDir: (id) => join(WAKE_HOME, 'sessions', id),
  sessionMeta: (id) => join(WAKE_HOME, 'sessions', id, 'meta.json'),
  sessionPending: (id) => join(WAKE_HOME, 'sessions', id, 'pending'),
  sessionConsumed: (id) => join(WAKE_HOME, 'sessions', id, 'consumed'),
  // Touched by the UserPromptSubmit hook, removed when the watcher re-arms at
  // Stop. Its mtime is the whole payload — a marker file rather than a meta
  // field because the hook must write it in bash, and because meta is
  // read-modify-write JSON that the watcher rewrites concurrently.
  sessionTurnActive: (id) => join(WAKE_HOME, 'sessions', id, 'turn-active'),
  sessionResumePrompt: (id) => join(WAKE_HOME, 'sessions', id, 'resume-prompt.txt'),
}

export const claudeProjectsDir = join(homedir(), '.claude', 'projects')
export const claudeSettings = join(homedir(), '.claude', 'settings.json')
export const warpLaunchDir = join(homedir(), '.warp', 'launch_configurations')
