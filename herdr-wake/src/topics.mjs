// Routing keys of herdr tabs, computed the way the claude-tg launcher computes TG_KEY
// (tg-key.mjs): a workspace's first tab is "topic:<workspace>", its other tabs
// "topic:<workspace> / <tab label>", with non-ASCII characters stripped (HTTP headers must be
// ASCII) and the result trimmed.
import { asciiKey, tabKey, workspaceTabs } from './tg-key.mjs'

export { asciiKey }

/** Routing key -> tab ids. Several tabs can collapse into one key once non-ASCII is stripped. */
export function tabKeys(snap) {
  const keys = new Map()
  for (const ws of snap.workspaces) {
    if (!ws.label) continue
    workspaceTabs(snap, ws.workspace_id).forEach((tab, i) => {
      const key = tabKey(ws.label, i, tab.label)
      if (!keys.has(key)) keys.set(key, [])
      keys.get(key).push(tab.tab_id)
    })
  }
  return keys
}
