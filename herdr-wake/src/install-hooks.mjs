// The "install-hooks" action: registers the ListAgents / SendMessage hooks in
// ~/.claude/settings.json. hook.mjs is copied into the plugin config dir first, because a
// GitHub-installed plugin moves to a new directory on every update. Idempotent; replaces
// hooks from earlier copies and keeps a backup of settings.json.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR || join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', 'herdr-wake')
const settingsFile = join(homedir(), '.claude', 'settings.json')

mkdirSync(CONFIG_DIR, { recursive: true })
const hookFile = join(CONFIG_DIR, 'hook.mjs')
copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'hook.mjs'), hookFile)

const settings = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
if (existsSync(settingsFile)) copyFileSync(settingsFile, `${settingsFile}.bak-herdr-wake`)
settings.hooks ??= {}

const ours = command => /herdr-wake.*hook\.mjs"? (pre-send|post-list)$/.test(command ?? '')
function put(event, matcher, mode, timeout) {
  const list = (settings.hooks[event] ??= [])
  for (const entry of list) entry.hooks = (entry.hooks ?? []).filter(h => !ours(h.command))
  settings.hooks[event] = list.filter(entry => entry.hooks.length)
  settings.hooks[event].push({ matcher, hooks: [{ type: 'command', command: `node "${hookFile}" ${mode}`, timeout }] })
}

put('PreToolUse', 'SendMessage', 'pre-send', 180)
put('PostToolUse', 'ListAgents', 'post-list', 10)
writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`)
console.log(`hooks installed: ${hookFile} (pre-send on SendMessage, post-list on ListAgents) in ${settingsFile}`)
