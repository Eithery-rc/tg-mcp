#!/usr/bin/env node
// The Telegram topic a Claude session in herdr belongs to: the routing key tg-mcp takes in the
// X-Cwd header, which the claude-tg launcher puts in TG_KEY. A workspace's first tab is
// "topic:<workspace>", its other tabs "topic:<workspace> / <tab label>"; outside herdr it is the
// folder. Characters outside ASCII are dropped (HTTP headers must be ASCII) and the result is
// trimmed. The router maps keys back to tabs with the same functions (topics.mjs).
//
//   node tg-key.mjs    prints the key for this shell's pane (HERDR_PANE_ID), else the folder
//
// No imports from the plugin: install-launcher copies this file into the plugin's config folder,
// so the launcher keeps working when the plugin moves.
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function asciiKey(raw) {
  return String(raw ?? '').replace(/[^\x20-\x7E]/g, '').trim()
}

/** A workspace's tabs in the order herdr shows them. */
export const workspaceTabs = (snap, workspaceId) => (snap?.tabs ?? []).filter(t => t.workspace_id === workspaceId).sort((a, b) => a.number - b.number)

/** The key of the tab at `index` (0: the first) of a workspace labelled `workspace`. */
export const tabKey = (workspace, index, tabLabel) => asciiKey(index === 0 ? `topic:${workspace}` : `topic:${workspace} / ${tabLabel}`)

/** The key for a pane in a herdr snapshot, or the folder's when herdr does not know the pane or its workspace has no label. */
export function keyFor(snap, paneId, cwd) {
  const pane = paneId ? (snap?.panes ?? []).find(p => p.pane_id === paneId) : null
  const ws = pane && (snap?.workspaces ?? []).find(w => w.workspace_id === pane.workspace_id)
  if (ws?.label) {
    const tabs = workspaceTabs(snap, ws.workspace_id)
    const i = tabs.findIndex(t => t.tab_id === pane.tab_id)
    if (i >= 0) return tabKey(ws.label, i, tabs[i].label)
  }
  return asciiKey(cwd)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let snap = null
  if (process.env.HERDR_PANE_ID) {
    try {
      const out = execFileSync(process.env.HERDR_BIN_PATH || 'herdr', ['api', 'snapshot'], { encoding: 'utf8', timeout: 5000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      snap = JSON.parse(out).result.snapshot
    } catch {}
  }
  console.log(keyFor(snap, process.env.HERDR_PANE_ID, process.cwd()))
}
