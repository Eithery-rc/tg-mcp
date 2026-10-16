// The "install-launcher" action: puts `claude-tg` on PATH (~/.local/bin, a sh script for Git
// Bash, Linux and macOS and a .cmd for PowerShell and cmd). claude-tg starts Claude Code with
// TG_KEY set to the herdr tab's Telegram topic (tg-key.mjs), and passes its arguments on:
//   claude-tg --dangerously-skip-permissions        claude-tg --resume <session id>
// tg-key.mjs is copied into the plugin config dir first, because a GitHub-installed plugin moves
// to a new directory on every update. Idempotent; a claude-tg that is not ours is left alone.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR || join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', 'herdr-wake')
const binDir = join(homedir(), '.local', 'bin')

/** The two command files, for a tg-key.mjs at `keyScript`. */
export function launcherFiles(keyScript) {
  return {
    // The key is worked out by node, then the shell is replaced by Claude: no process in between.
    'claude-tg': `#!/bin/sh
# herdr-wake: Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)
TG_KEY="$(node "${keyScript.replace(/\\/g, '/')}" 2>/dev/null)"
[ -n "$TG_KEY" ] || TG_KEY="$(pwd)"
export TG_KEY
exec claude "$@"
`,
    'claude-tg.cmd': `@echo off\r
rem herdr-wake: Claude Code with this herdr tab's Telegram topic in TG_KEY (tg-mcp's X-Cwd)\r
setlocal\r
set "TG_KEY="\r
for /f "usebackq delims=" %%k in (\`node "${keyScript}" 2^>nul\`) do set "TG_KEY=%%k"\r
if not defined TG_KEY set "TG_KEY=%CD%"\r
claude %*\r
`,
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(CONFIG_DIR, { recursive: true })
  const keyScript = join(CONFIG_DIR, 'tg-key.mjs')
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'tg-key.mjs'), keyScript)
  mkdirSync(binDir, { recursive: true })
  for (const [name, body] of Object.entries(launcherFiles(keyScript))) {
    const file = join(binDir, name)
    if (existsSync(file) && !readFileSync(file, 'utf8').includes('herdr-wake')) {
      console.log(`skipped ${file}: exists and is not ours`)
      continue
    }
    writeFileSync(file, body, { mode: 0o755 })
  }
  console.log(`claude-tg in ${binDir} (+ claude-tg.cmd), the topic from ${keyScript}`)
  console.log('use it where Claude starts: the agent board\'s launch.claude ["claude-tg"], herdr-wake\'s wakeCommand "claude-tg --resume {session}"')
}
