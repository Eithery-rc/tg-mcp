import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resumeArgs } from '../src/hook.mjs'
import { launcherFiles } from '../src/install-launcher.mjs'
import { keyFor } from '../src/tg-key.mjs'
import { tabKeys } from '../src/topics.mjs'

const snap = {
  workspaces: [
    { workspace_id: 'w1', label: 'Billing' },
    { workspace_id: 'w2', label: 'Счета 2' },
    { workspace_id: 'w3', label: '' },
  ],
  tabs: [
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'hotfix', number: 2 },
    { tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 },
    { tab_id: 'w2:t1', workspace_id: 'w2', label: '1', number: 1 },
    { tab_id: 'w3:t1', workspace_id: 'w3', label: '1', number: 1 },
  ],
  panes: [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' },
    { pane_id: 'w1:p3', tab_id: 'w1:t2', workspace_id: 'w1' },
    { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2' },
    { pane_id: 'w3:p1', tab_id: 'w3:t1', workspace_id: 'w3' },
  ],
}

test('the launcher’s topic: the workspace for its first tab, workspace / tab for the others, else the folder', () => {
  assert.equal(keyFor(snap, 'w1:p1', 'C:\\w'), 'topic:Billing')
  assert.equal(keyFor(snap, 'w1:p3', 'C:\\w'), 'topic:Billing / hotfix')
  assert.equal(keyFor(snap, 'w2:p1', 'C:\\w'), 'topic: 2') // headers are ASCII: the rest is dropped
  assert.equal(keyFor(snap, 'w3:p1', 'C:\\Work\\Проект x'), 'C:\\Work\\ x') // no workspace label: the folder
  assert.equal(keyFor(snap, 'gone', '/home/u/app'), '/home/u/app')
  assert.equal(keyFor(null, undefined, '/home/u/app'), '/home/u/app')
  // The router finds the tab by the very key the launcher gave the session.
  for (const pane of snap.panes.filter(p => p.workspace_id !== 'w3')) assert.ok(tabKeys(snap).get(keyFor(snap, pane.pane_id, ''))?.includes(pane.tab_id), pane.pane_id)
})

test('after a herdr restart, a session comes back through wakeCommand when that is a launcher of your own', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  assert.deepEqual(resumeArgs('claude-tg --dangerously-skip-permissions --resume {session}', id), ['claude-tg', '--dangerously-skip-permissions', '--resume', id])
  assert.equal(resumeArgs('claude --resume {session}', id), null) // herdr does that already
  assert.equal(resumeArgs(undefined, id), null)
  assert.equal(resumeArgs('cd x; claude --resume {session}', id), null) // shell syntax: not a plain command
  assert.equal(resumeArgs('"C:\\Program Files\\c.exe" --resume {session}', id), null)
})

test('claude-tg: the key from tg-key.mjs in TG_KEY, the arguments passed on to claude', { skip: process.platform !== 'win32' && 'the .cmd runs on Windows; the sh one is checked below' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-tg-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const key = fileURLToPath(new URL('../src/tg-key.mjs', import.meta.url))
    writeFileSync(join(bin, 'claude-tg.cmd'), launcherFiles(key)['claude-tg.cmd'])
    // A stand-in claude that says what it got.
    writeFileSync(join(bin, 'claude.cmd'), '@echo key=[%TG_KEY%] args=[%*]\r\n')
    const env = { ...process.env, PATH: `${bin};${process.env.PATH}`, HERDR_PANE_ID: 'w1:p3', HERDR_BIN_PATH: process.execPath, NODE_OPTIONS: `--import=${new URL('./fake-snapshot.mjs', import.meta.url).href}`, FAKE_SNAPSHOT: JSON.stringify(snap) }
    const out = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'claude-tg.cmd', '--resume', 'abc'], { env, cwd: dir, encoding: 'utf8' })
    assert.equal(out.trim(), 'key=[topic:Billing / hotfix] args=[--resume abc]')
    // Outside herdr: the folder.
    const outside = execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'claude-tg.cmd'], { env: { ...env, HERDR_PANE_ID: '' }, cwd: dir, encoding: 'utf8' })
    assert.equal(outside.trim(), `key=[${dir}] args=[]`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('claude-tg for sh: exec claude with TG_KEY set', () => {
  const sh = launcherFiles('/opt/herdr-wake/tg-key.mjs')['claude-tg']
  assert.match(sh, /^#!\/bin\/sh\n/)
  assert.match(sh, /TG_KEY="\$\(node "\/opt\/herdr-wake\/tg-key\.mjs" 2>\/dev\/null\)"/)
  assert.match(sh, /\nexport TG_KEY\nexec claude "\$@"\n$/)
  assert.equal(launcherFiles('C:\\x\\tg-key.mjs')['claude-tg'].includes('node "C:/x/tg-key.mjs"'), true)
})
