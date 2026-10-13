// Startup hook and the "start" action: make sure one router pane runs, in its own workspace.
// After a herdr restart that workspace comes back with a plain shell, so its old tabs are
// replaced by a fresh router tab. Whole tabs are closed, not panes, because other plugins
// (herdr-sidebar) add their own panes to every tab.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { herdr, snapshot } from './herdr.mjs'

const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || 'herdr-wake'
const ROOT = process.env.HERDR_PLUGIN_ROOT || process.cwd()
const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR || join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', PLUGIN_ID)

let cfg = {}
try {
  cfg = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8'))
} catch {}
const port = cfg.port ?? 12421
const label = cfg.workspace ?? 'tg-router'

async function running() {
  try {
    return (await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(2000) })).ok
  } catch {
    return false
  }
}

if (await running()) {
  console.log('router already running')
  process.exit(0)
}

const snap = await snapshot()
let ws = snap.workspaces.find(w => w.label === label)
const stale = ws ? snap.tabs.filter(t => t.workspace_id === ws.workspace_id).map(t => t.tab_id) : []
if (!ws) {
  const created = await herdr(['workspace', 'create', '--label', label, '--cwd', ROOT, '--no-focus'])
  ws = created.workspace
  stale.push(created.tab.tab_id)
}
await herdr([
  'plugin', 'pane', 'open',
  '--plugin', PLUGIN_ID,
  '--entrypoint', 'router',
  '--placement', 'tab',
  '--workspace', ws.workspace_id,
  '--cwd', ROOT,
  '--no-focus',
])
for (const tab of stale) await herdr(['tab', 'close', tab]).catch(() => {})
console.log(`router pane opened in workspace ${label}`)
