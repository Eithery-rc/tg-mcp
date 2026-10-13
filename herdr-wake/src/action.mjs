// herdr actions for the focused pane: `node src/action.mjs sleep|wake`, through the router's local API.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR || join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', 'herdr-wake')
let port = 12421
try {
  port = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8')).port ?? port
} catch {}

const mode = process.argv[2]
const ctx = JSON.parse(process.env.HERDR_PLUGIN_CONTEXT_JSON || '{}')
const pane = process.argv[3] || ctx.focused_pane_id || process.env.HERDR_PANE_ID
if (!['sleep', 'wake'].includes(mode) || !pane) {
  console.error('usage: node src/action.mjs sleep|wake [pane id]')
  process.exit(2)
}

const res = await fetch(`http://127.0.0.1:${port}/${mode}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ target: pane }),
  signal: AbortSignal.timeout(180_000),
})
const out = await res.json()
console.log(out.ok ? `${mode === 'sleep' ? 'asleep' : 'awake'}: ${out.name} (${out.pane})` : out.error)
process.exit(out.ok ? 0 : 1)
