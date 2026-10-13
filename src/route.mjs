// Pure routing decisions, kept apart from the router loop so they can be tested.
import { tabKeys } from './topics.mjs'

/** A path in a comparable form: one kind of slash, no trailing slash, case-insensitive with a drive letter. */
export function samePath(p) {
  const s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(s) ? s.toLowerCase() : s
}

/** Sessions send X-Herdr-Pane as "<machine>:<pane id>"; a hint from another machine is no use here. */
export function localPane(hint, machine) {
  if (!hint) return null
  const parts = hint.split(':')
  if (parts.length < 3) return hint // a bare pane id such as "w1:p2"
  return parts[0].toLowerCase() === machine.toLowerCase() ? parts.slice(1).join(':') || null : null
}

/**
 * The pane for a message: a running Claude first, else a pane whose last session can be
 * resumed. Candidates in order: the server's hints (the pane behind the bot message the user
 * replied to, panes connected for the key), then the panes of the tab the key names, most
 * recently active Claude first. `known` maps pane id -> last session seen there.
 */
export function resolve(item, snap, known, machine) {
  const panes = new Map(snap.panes.map(p => [p.pane_id, p]))
  const seq = new Map(snap.agents.map(a => [a.pane_id, a.state_change_seq ?? 0]))
  const order = []
  const add = id => {
    if (id && panes.has(id) && !order.includes(id)) order.push(id)
  }
  add(localPane(item.pane, machine))
  for (const hint of item.live_panes ?? []) add(localPane(hint, machine))
  // The key names a herdr tab (the launcher in tg-mcp's README) or, by default, a working directory.
  const tabs = tabKeys(snap).get(item.key) ?? []
  const dir = samePath(item.key)
  snap.panes
    .filter(p => tabs.includes(p.tab_id) || (p.cwd && samePath(p.cwd) === dir))
    .sort((a, b) => (b.agent === 'claude') - (a.agent === 'claude') || (seq.get(b.pane_id) ?? 0) - (seq.get(a.pane_id) ?? 0))
    .forEach(p => add(p.pane_id))

  const live = order.find(id => panes.get(id).agent === 'claude')
  if (live) return { pane: live, title: panes.get(live).terminal_title_stripped || '' }
  const resumable = order.find(id => known[id] && !panes.get(id).agent)
  if (resumable) return { pane: resumable, session: known[resumable].session, title: known[resumable].title }
  return null
}

/** One prompt for a topic's messages; it starts with "[telegram ...]", as tg-mcp tells agents. */
export function formatPrompt(items, now = Date.now()) {
  return items
    .map(it => {
      const attrs = { message_id: it.meta.message_id }
      for (const k of ['file_id', 'file_kind', 'file_name', 'in_reply_to']) if (it.meta[k]) attrs[k] = it.meta[k]
      if (now - Date.parse(it.queued_at) > 120_000) attrs.queued_at = it.queued_at
      const head = Object.entries(attrs)
        .map(([k, v]) => (/^[\w.:+-]+$/.test(v) ? `${k}=${v}` : `${k}=${JSON.stringify(v)}`))
        .join(' ')
      return `[telegram ${head}]\n${it.text}`
    })
    .join('\n\n')
}
