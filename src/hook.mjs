// Claude Code hooks that make sleeping sessions reachable through the herdr-wake router:
//
//   node hook.mjs pre-send   PreToolUse on SendMessage: if the recipient sleeps, wake it first
//   node hook.mjs post-list  PostToolUse on ListAgents: list the sleeping sessions too
//
// Both stay silent and let the tool run unchanged when the router is not running.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', 'herdr-wake')
let port = 12421
try {
  port = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8')).port ?? port
} catch {}

async function api(path, body, timeoutMs) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  return res.json()
}

function ago(iso) {
  const min = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  return min < 90 ? `${min} min` : `${Math.round(min / 60)} h`
}

const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
const mode = process.argv[2]

try {
  if (mode === 'pre-send') {
    const to = String(input.tool_input?.to ?? '').replace(/\s*\[[0-9a-f]+\]\s*$/i, '').trim().toLowerCase()
    const target = to && (await api('/sleeping', null, 3000)).find(s => s.name.toLowerCase() === to)
    if (target) {
      const r = await api('/wake', { target: target.pane }, 170_000)
      if (!r.ok) {
        console.log(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: `${target.name} is asleep (herdr-wake) and could not be woken: ${r.error}`,
            },
          }),
        )
      }
    }
  } else if (mode === 'post-list') {
    const list = await api('/sleeping', null, 3000)
    if (list.length) {
      const rows = list.map(s => `  ${s.name}  ·  workspace ${s.workspace}  ·  asleep for ${ago(s.slept_at)}`).join('\n')
      const additionalContext =
        `Sleeping sessions on this machine (not listed above): herdr-wake put them to sleep after they sat idle. ` +
        `SendMessage to one by name wakes it first (takes about 10 to 30 seconds), then delivers.\n${rows}`
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } }))
    }
  }
} catch {
  // Router not running or not answering: leave the tool call alone.
}
