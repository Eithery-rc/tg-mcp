// Which idle Claude sessions to put to sleep. Pure: the router makes the herdr calls.

/** Exact (case-insensitive) names, or "/regex/" patterns. */
export function matchesAny(patterns, values) {
  return patterns.some(pat => {
    const re = /^\/(.+)\/$/.exec(pat)
    return values.some(v => v && (re ? new RegExp(re[1], 'i').test(v) : v.toLowerCase() === pat.toLowerCase()))
  })
}

/**
 * Panes whose Claude session the user exited (/exit, Ctrl+C): the router saw the session
 * there within `windowMs`, the pane has no agent any more and Claude's registry no longer
 * lists the session as running. From then on they count as asleep, so SendMessage and
 * Telegram wake them like the reaper's. The window keeps panes whose Claude ended long ago,
 * now plain shells, out of it. `known` is sessions.json, `live` the running sessions by id.
 */
export function exitedPanes(snap, known, live, now = Date.now(), windowMs = 10 * 60_000) {
  return snap.panes
    .filter(p => {
      const k = known[p.pane_id]
      return k?.session && !k.slept_at && !p.agent && !live.has(k.session) && now - k.seen_at < windowMs
    })
    .map(p => p.pane_id)
}

/**
 * One entry per Claude pane: `sleep: true` for those to put to sleep, otherwise the reason it
 * stays up. `live` maps session id -> Claude's registry entry (~/.claude/sessions). A session
 * sleeps only when Claude itself reports it idle (not busy, not running a background shell)
 * for `idleMinutes`, herdr agrees, the pane is not focused, it is not excluded, and it has no
 * scheduled jobs that would die with it. Entries of registered sessions also carry `status`,
 * `since` (when Claude last changed it) and `idleMin`; `waiting: true` marks the ones that
 * only need more idle time.
 */
export function reapPlan(snap, live, { idleMinutes, exclude = [], now = Date.now(), scheduled = () => false }) {
  const wsLabel = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  const plan = []
  for (const p of snap.panes) {
    if (p.agent !== 'claude') continue
    const id = p.agent_session?.value
    const s = id ? live.get(id) : undefined
    const name = s?.name || p.terminal_title_stripped || p.pane_id
    const workspace = wsLabel.get(p.workspace_id) ?? ''
    if (!s) {
      plan.push({ pane: p.pane_id, name, workspace, sleep: false, reason: 'not in the session registry' })
      continue
    }
    const idleMin = Math.round((now - s.statusUpdatedAt) / 60_000)
    const base = { pane: p.pane_id, name, workspace, status: s.status, since: s.statusUpdatedAt, idleMin }
    const keep = (reason, extra) => plan.push({ ...base, sleep: false, reason, ...extra })
    if (matchesAny(exclude, [s.name, workspace, p.terminal_title_stripped])) keep('excluded')
    else if (s.status !== 'idle') keep(`status ${s.status}`)
    else if (p.agent_status !== 'idle' && p.agent_status !== 'done') keep(`herdr says ${p.agent_status}`)
    else if (scheduled(s)) keep('has scheduled jobs')
    else if (idleMin < idleMinutes) keep(`idle ${idleMin} min`, { waiting: true })
    else if (p.focused) keep('focused')
    else plan.push({ ...base, sleep: true, session: id, cwd: s.cwd, reason: `idle ${idleMin} min` })
  }
  return plan
}
