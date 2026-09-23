// Minimal flag parser: --key value, --key=value, --flag, and positionals.
export const parseArgs = (argv) => {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      args._.push(token)
      continue
    }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) {
      args[body.slice(0, eq)] = body.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      args[body] = true
    } else {
      args[body] = next
      i += 1
    }
  }
  return args
}

export const color = {
  ok: (text) => `[32m${text}[0m`,
  bad: (text) => `[31m${text}[0m`,
  warn: (text) => `[33m${text}[0m`,
  dim: (text) => `[2m${text}[0m`,
  bold: (text) => `[1m${text}[0m`,
}
