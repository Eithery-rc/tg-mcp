// The "install-launcher" action: puts `claude-tg` on PATH (~/.local/bin, a sh script for Git
// Bash, Linux and macOS and a .cmd for PowerShell and cmd). claude-tg starts Claude Code with
// TG_KEY set to the herdr tab's Telegram topic, and passes its arguments on:
//   claude-tg --dangerously-skip-permissions        claude-tg --resume <session id>
// The key script (tg-key.mjs) is copied next to them as claude-tg-key.mjs, and each launcher
// finds it beside itself: nothing depends on where the plugin lives (a GitHub-installed plugin
// moves on updates), and no path is written into the .cmd, which cmd.exe would read in the
// console's code page. Idempotent; when a file of these names is not ours, nothing is written.
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const binDir = join(homedir(), '.local', 'bin')
const OURS = /^(#|rem|\/\/) herdr-wake: /m

/** The two command files; the key script is claude-tg-key.mjs in the same folder. */
export function launcherFiles() {
  return {
    // The key is worked out by node, then the shell is replaced by Claude.
    'claude-tg': `#!/bin/sh
# herdr-wake: claude-tg, Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)
TG_KEY="$(node "$(dirname "$0")/claude-tg-key.mjs" 2>/dev/null)"
[ -n "$TG_KEY" ] || TG_KEY="$(pwd)"
export TG_KEY
exec claude "$@"
`,
    // %~dp0 is this file's folder, read at run time; no delayed expansion, so a ! in a key stays.
    'claude-tg.cmd': `@echo off\r
rem herdr-wake: claude-tg, Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)\r
setlocal DisableDelayedExpansion\r
set "TG_KEY="\r
for /f "usebackq delims=" %%k in (\`node "%~dp0claude-tg-key.mjs" 2^>nul\`) do set "TG_KEY=%%k"\r
if not defined TG_KEY set "TG_KEY=%CD%"\r
claude %*\r
`,
  }
}

/** Whether a file of ours (or none) is at `file`: ours start with a "herdr-wake:" comment line. */
export const replaceable = file => !existsSync(file) || OURS.test(readFileSync(file, 'utf8'))

function isMain() {
  try {
    const a = realpathSync(process.argv[1])
    const b = realpathSync(fileURLToPath(import.meta.url))
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  } catch {
    return false
  }
}

if (process.argv[1] && isMain()) {
  const files = { ...launcherFiles(), 'claude-tg-key.mjs': readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tg-key.mjs'), 'utf8') }
  const foreign = Object.keys(files).map(name => join(binDir, name)).filter(file => !replaceable(file))
  if (foreign.length) {
    console.log(`not installed: ${foreign.join(', ')} ${foreign.length === 1 ? 'is' : 'are'} not herdr-wake's. Move ${foreign.length === 1 ? 'it' : 'them'} away and run this again.`)
    process.exit(1)
  }
  mkdirSync(binDir, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(binDir, name), body, { mode: 0o755 })
  console.log(`claude-tg installed in ${binDir} (sh, .cmd, and claude-tg-key.mjs beside them)`)
  const win = process.platform === 'win32'
  const fold = p => (win ? p.replace(/[\\/]+$/, '').toLowerCase() : p.replace(/\/+$/, ''))
  const onPath = String(process.env.PATH ?? '').split(delimiter).some(d => fold(d) === fold(binDir))
  if (!onPath) console.log(`${binDir} is not on PATH: add it, or herdr and the board cannot find claude-tg`)
  console.log('use it where Claude starts: the agent board\'s launch.claude ["claude-tg"], herdr-wake\'s wakeCommand "claude-tg --resume {session}"')
}
