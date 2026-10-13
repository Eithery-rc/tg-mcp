// Claude Code hooks that make sleeping sessions reachable through the herdr-wake router:
//
//   node hook.mjs pre-send   PreToolUse on SendMessage: if the recipient sleeps, wake it first
//   node hook.mjs post-list  PostToolUse on ListAgents: list the sleeping sessions too, and
//                            how long each running one has been idle or busy
//
// Both stay silent and let the tool run unchanged when the router is not running.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CONFIG_DIR = join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', 'herdr-wake')
let cfg = {}
try {
  cfg = JSON.parse(readFileSync(join(CONFIG_DIR, 'config.json'), 'utf8'))
} catch {}
const port = cfg.port ?? 12421
// ListAgents shows the sessions that fell asleep recently, the rest as a count: a sleeping
// session stays until its pane is closed, so the full list only grows. All stay wakeable.
const LIST_DAYS = cfg.listSleepingDays ?? 7
const LIST_MAX = 15

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
  return min < 90 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`
}

// Why the reaper leaves a running session up (see reaper.mjs); busy and shell need no words.
const KEPT = {
  excluded: 'never sleeps (excluded)',
  'has scheduled jobs': 'stays awake: has scheduled jobs',
  focused: 'stays awake while focused',
  'herdr says blocked': 'waiting for an answer in its terminal',
}

function activity(s) {
  const when = s.sleeps_in_min === 0 ? 'goes to sleep within a minute' : s.sleeps_in_min != null ? `sleeps in ${s.sleeps_in_min} min` : KEPT[s.kept]
  return [s.name, `${s.status} ${ago(s.since)}`, when].filter(Boolean).join('  ·  ')
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
    // /awake is newer than /sleeping: an older router answers 404, then only the sleepers show
    const [list, running] = await Promise.all([
      api('/sleeping', null, 3000),
      api('/awake', null, 3000).catch(() => null),
    ])
    const parts = []
    if (Array.isArray(running) && running.length) {
      parts.push(
        `Running sessions on this machine, how long since their status last changed ("started" above is when ` +
          `the process started or was woken, not the last activity):\n` +
          running.map(s => `  ${activity(s)}`).join('\n'),
      )
    }
    if (list.length) {
      const recent = list
        .filter(s => Date.now() - Date.parse(s.slept_at) < LIST_DAYS * 86_400_000)
        .sort((a, b) => Date.parse(b.slept_at) - Date.parse(a.slept_at))
        .slice(0, LIST_MAX)
      const rows = recent.map(
        s => `  ${s.name}  ·  workspace ${s.workspace}  ·  ${s.exited ? 'exited by the user' : 'put to sleep'} ${ago(s.slept_at)} ago`,
      )
      const rest = list.length - recent.length
      if (rest) {
        rows.push(
          `  ... and ${rest} asleep longer, not shown (all: http://127.0.0.1:${port}/sleeping); ` +
            `SendMessage by name wakes them too`,
        )
      }
      parts.push(
        `Sleeping sessions on this machine (not listed above): put to sleep by herdr-wake after they sat idle, or ` +
          `exited by the user; their pane is still open. ` +
          `SendMessage to one by name wakes it first (takes about 10 to 30 seconds), then delivers.\n${rows.join('\n')}`,
      )
    }
    if (parts.length) {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join('\n\n') } }))
    }
  }
} catch {
  // Router not running or not answering: leave the tool call alone.
}
