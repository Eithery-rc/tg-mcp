// Routing keys, computed the way ~/.local/bin/cldt.ps1 computes TG_KEY: a workspace's first
// tab is "topic:<workspace>", its other tabs "topic:<workspace> / <tab label>", with
// non-ASCII characters stripped (HTTP headers must be ASCII) and the result trimmed.

export function asciiKey(raw) {
  return raw.replace(/[^\x20-\x7E]/g, '').trim()
}

/** Routing key -> tab ids. Several tabs can collapse into one key once non-ASCII is stripped. */
export function tabKeys(snap) {
  const keys = new Map()
  for (const ws of snap.workspaces) {
    if (!ws.label) continue
    const tabs = snap.tabs.filter(t => t.workspace_id === ws.workspace_id).sort((a, b) => a.number - b.number)
    tabs.forEach((tab, i) => {
      const key = asciiKey(i === 0 ? `topic:${ws.label}` : `topic:${ws.label} / ${tab.label}`)
      if (!keys.has(key)) keys.set(key, [])
      keys.get(key).push(tab.tab_id)
    })
  }
  return keys
}
