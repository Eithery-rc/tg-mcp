// Which idle Claude sessions to put to sleep. Pure: the router makes the herdr calls.

/** Exact (case-insensitive) names, or "/regex/" patterns. */
export function matchesAny(patterns, values) {
  return patterns.some(pat => {
    const re = /^\/(.+)\/$/.exec(pat)
    return values.some(v => v && (re ? new RegExp(re[1], 'i').test(v) : v.toLowerCase() === pat.toLowerCase()))
  })
}

/**
 * One entry per Claude pane: `sleep: true` for those to put to sleep, otherwise the reason it
 * stays up. `live` maps session id -> Claude's registry entry (~/.claude/sessions). A session
 * sleeps only when Claude itself reports it idle (not busy, not running a background shell)
 * for `idleMinutes`, herdr agrees, the pane is not focused, it is not excluded, and it has no
 * scheduled jobs that would die with it.
 */
export function reapPlan(snap, live, { idleMinutes, exclude = [], now = Date.now(), scheduled = () => false }) {
  const wsLabel = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  const plan = []
  for (const p of snap.panes) {
    if (p.agent !== 'claude') continue
    const id = p.agent_session?.value
    const s = id ? live.get(id) : undefined
    const name = s?.name || p.terminal_title_stripped || p.pane_id
    const keep = reason => plan.push({ pane: p.pane_id, name, sleep: false, reason })
    if (!s) {
      keep('not in the session registry')
      continue
    }
    const idleMin = Math.round((now - s.statusUpdatedAt) / 60_000)
    if (s.status !== 'idle') keep(`status ${s.status}`)
    else if (p.agent_status !== 'idle' && p.agent_status !== 'done') keep(`herdr says ${p.agent_status}`)
    else if (idleMin < idleMinutes) keep(`idle ${idleMin} min`)
    else if (p.focused) keep('focused')
    else if (matchesAny(exclude, [s.name, wsLabel.get(p.workspace_id), p.terminal_title_stripped])) keep('excluded')
    else if (scheduled(s)) keep('has scheduled jobs')
    else plan.push({ pane: p.pane_id, name, sleep: true, session: id, cwd: s.cwd, idleMin, reason: `idle ${idleMin} min` })
  }
  return plan
}
