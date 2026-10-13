// Thin async wrapper over the herdr CLI. HERDR_BIN_PATH hides the socket transport
// (Unix socket or Windows named pipe), so plugins should call herdr through it.
import { execFile } from 'node:child_process'

const BIN = process.env.HERDR_BIN_PATH || 'herdr'

export class HerdrError extends Error {
  constructor(args, code, message) {
    super(`herdr ${args.slice(0, 2).join(' ')}: ${code ? `${code}: ` : ''}${message}`)
    this.code = code
  }
}

function run(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(BIN, args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 32 << 20 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout)
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
      let code
      let message = out || err.message
      try {
        const e = JSON.parse(out).error
        code = e?.code
        message = e?.message ?? message
      } catch {}
      reject(new HerdrError(args, code, message))
    })
  })
}

/** Run a herdr command and return the `result` of its JSON answer (null for commands that print nothing, like pane run). */
export async function herdr(args, timeoutMs = 30_000) {
  const out = await run(args, timeoutMs)
  return out.trim() ? JSON.parse(out).result : null
}

/** Run a herdr command that prints plain text (pane read, agent read). */
export function herdrText(args, timeoutMs = 30_000) {
  return run(args, timeoutMs)
}

/** Workspaces, tabs, panes and agents in one call. */
export async function snapshot() {
  return (await herdr(['api', 'snapshot'])).snapshot
}
