import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resumeArgs } from '../src/hook.mjs'
import { launcherFiles } from '../src/install-launcher.mjs'
import { keyFor } from '../src/tg-key.mjs'
import { tabKeys } from '../src/topics.mjs'

const src = name => fileURLToPath(new URL(`../src/${name}`, import.meta.url))
const FAKE = new URL('./fake-herdr.mjs', import.meta.url).href

const snap = {
  workspaces: [
    { workspace_id: 'w1', label: 'Billing' },
    { workspace_id: 'w2', label: 'Счета 2' },
    { workspace_id: 'w3', label: '' },
    { workspace_id: 'w4', label: 'Счета' },
  ],
  tabs: [
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'hotfix', number: 2 },
    { tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 },
    { tab_id: 'w2:t1', workspace_id: 'w2', label: '1', number: 1 },
    { tab_id: 'w3:t1', workspace_id: 'w3', label: '1', number: 1 },
    { tab_id: 'w4:t1', workspace_id: 'w4', label: '1', number: 1 },
  ],
  panes: [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', workspace_id: 'w1' },
    { pane_id: 'w1:p3', tab_id: 'w1:t2', workspace_id: 'w1' },
    { pane_id: 'w2:p1', tab_id: 'w2:t1', workspace_id: 'w2' },
    { pane_id: 'w3:p1', tab_id: 'w3:t1', workspace_id: 'w3' },
    { pane_id: 'w4:p1', tab_id: 'w4:t1', workspace_id: 'w4' },
  ],
}

function sandbox(t) {
  const dir = mkdtempSync(join(tmpdir(), 'claude-tg-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const home = join(dir, 'home')
  mkdirSync(home)
  return { dir, home, bin: join(home, '.local', 'bin'), env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(dir, 'appdata') } }
}

test('the launcher’s topic: the workspace for its first tab, workspace / tab for the others, else the folder', () => {
  assert.equal(keyFor(snap, 'w1:p1', 'C:\\w'), 'topic:Billing')
  assert.equal(keyFor(snap, 'w1:p3', 'C:\\w'), 'topic:Billing / hotfix')
  assert.equal(keyFor(snap, 'w2:p1', 'C:\\w'), 'topic: 2') // headers are ASCII: the rest is dropped
  assert.equal(keyFor(snap, 'w3:p1', 'C:\\Work\\Проект x'), 'C:\\Work\\ x') // no workspace label: the folder
  assert.equal(keyFor(snap, 'w4:p1', '/home/u/app'), '/home/u/app') // nothing left of the name: not a nameless topic
  assert.equal(keyFor(snap, 'gone', '/home/u/app'), '/home/u/app')
  assert.equal(keyFor(null, undefined, '/home/u/app'), '/home/u/app')
  // The router finds the tab by the very key the launcher gave the session.
  for (const pane of snap.panes.filter(p => p.workspace_id === 'w1' || p.workspace_id === 'w2')) assert.ok(tabKeys(snap).get(keyFor(snap, pane.pane_id, ''))?.includes(pane.tab_id), pane.pane_id)
})

test('after a herdr restart, a session comes back through wakeCommand when that is a launcher of your own', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  assert.deepEqual(resumeArgs('claude-tg --dangerously-skip-permissions --resume {session}', id), ['claude-tg', '--dangerously-skip-permissions', '--resume', id])
  assert.equal(resumeArgs('claude --resume {session}', id), null) // herdr does that already
  assert.equal(resumeArgs(undefined, id), null)
  assert.equal(resumeArgs('cd x; claude --resume {session}', id), null) // shell syntax: not a plain command
  assert.equal(resumeArgs('"C:\\Program Files\\c.exe" --resume {session}', id), null)
  for (const path of ['./claude-tg', 'C:\\bin\\claude-tg', '~/bin/claude-tg']) assert.equal(resumeArgs(`${path} --resume {session}`, id), null, path) // herdr takes a command name, not a path
})

test('the resume report: herdr is told the launcher, retried until it takes it', { timeout: 20_000 }, t => {
  const box = sandbox(t)
  const config = join(box.env.APPDATA, 'herdr', 'plugins', 'config', 'herdr-wake')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'config.json'), JSON.stringify({ wakeCommand: 'claude-tg --resume {session}' }))
  const log = join(box.dir, 'calls.jsonl')
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e'
  execFileSync(process.execPath, [src('hook.mjs'), 'report', id], { env: { ...box.env, HERDR_ENV: '1', HERDR_PANE_ID: 'w1:p3', HERDR_BIN_PATH: process.execPath, NODE_OPTIONS: `--import=${FAKE}`, FAKE_HERDR_LOG: log }, timeout: 15_000 })
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(calls.length, 1)
  const [call] = calls
  assert.deepEqual(call.slice(0, 7), ['pane', 'report-agent-session', 'w1:p3', '--source', 'herdr:claude', '--agent', 'claude'])
  assert.deepEqual(call.slice(-6), ['--agent-session-id', id, '--', 'claude-tg', '--resume', id])
})

test('install-hooks: the SessionStart hook with the others, once, and everyone else’s left alone', t => {
  const box = sandbox(t)
  const settingsFile = join(box.home, '.claude', 'settings.json')
  mkdirSync(join(box.home, '.claude'))
  writeFileSync(settingsFile, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'theirs' }] }] } }))
  const env = { ...box.env, HERDR_PLUGIN_CONFIG_DIR: join(box.dir, 'herdr-wake-config') }
  for (let i = 0; i < 2; i++) execFileSync(process.execPath, [src('install-hooks.mjs')], { env })
  const hooks = JSON.parse(readFileSync(settingsFile, 'utf8')).hooks
  assert.deepEqual(hooks.SessionStart.map(e => e.hooks[0].command.replace(/^node ".*hook\.mjs"/, 'hook')), ['theirs', 'hook session-start'])
  assert.equal(hooks.SessionStart[1].matcher, undefined)
  assert.equal(hooks.PreToolUse.length, 1)
  assert.equal(hooks.PostToolUse.length, 1)
})

test('install-launcher: the launchers and their key script, and nothing at all over someone else’s claude-tg', t => {
  const box = sandbox(t)
  const run = () => spawnSync(process.execPath, [src('install-launcher.mjs')], { env: box.env, encoding: 'utf8' })
  assert.equal(run().status, 0)
  for (const name of ['claude-tg', 'claude-tg.cmd', 'claude-tg-key.mjs']) assert.ok(existsSync(join(box.bin, name)), name)
  assert.equal(readFileSync(join(box.bin, 'claude-tg-key.mjs'), 'utf8'), readFileSync(src('tg-key.mjs'), 'utf8'))
  assert.equal(run().status, 0) // again: its own files are replaced
  writeFileSync(join(box.bin, 'claude-tg.cmd'), '@echo mine, not from herdr-wake\r\n')
  rmSync(join(box.bin, 'claude-tg'))
  const r = run()
  assert.equal(r.status, 1)
  assert.match(r.stdout, /not installed: .*claude-tg\.cmd is not herdr-wake's/)
  assert.equal(existsSync(join(box.bin, 'claude-tg')), false)
  assert.equal(readFileSync(join(box.bin, 'claude-tg.cmd'), 'utf8'), '@echo mine, not from herdr-wake\r\n')
})

// The launchers as they run: a stand-in claude says what it got, herdr is the stand-in above.
function launcherBox(t, claude) {
  const box = sandbox(t)
  mkdirSync(box.bin, { recursive: true })
  for (const [name, body] of Object.entries(launcherFiles())) writeFileSync(join(box.bin, name), body, { mode: 0o755 })
  writeFileSync(join(box.bin, 'claude-tg-key.mjs'), readFileSync(src('tg-key.mjs'), 'utf8'))
  writeFileSync(join(box.bin, claude.name), claude.body, { mode: 0o755 })
  const sep = process.platform === 'win32' ? ';' : ':'
  return { ...box, env: { ...box.env, PATH: `${box.bin}${sep}${process.env.PATH}`, HERDR_PANE_ID: 'w1:p3', HERDR_BIN_PATH: process.execPath, NODE_OPTIONS: `--import=${FAKE}`, FAKE_SNAPSHOT: JSON.stringify(snap) } }
}

test('claude-tg.cmd: the key in TG_KEY, the arguments and the exit code passed on', { skip: process.platform !== 'win32' && 'Windows only' }, t => {
  const box = launcherBox(t, { name: 'claude.cmd', body: '@echo key=[%TG_KEY%] args=[%*]\r\n@exit /b 7\r\n' })
  const cmd = process.env.ComSpec || 'cmd.exe'
  const r = spawnSync(cmd, ['/d', '/c', 'claude-tg.cmd', '--resume', 'abc'], { env: box.env, cwd: box.dir, encoding: 'utf8' })
  assert.equal(r.stdout.trim(), 'key=[topic:Billing / hotfix] args=[--resume abc]')
  assert.equal(r.status, 7)
  const outside = spawnSync(cmd, ['/d', '/c', 'claude-tg.cmd'], { env: { ...box.env, HERDR_PANE_ID: '' }, cwd: box.dir, encoding: 'utf8' })
  assert.equal(outside.stdout.trim(), `key=[${box.dir}] args=[]`)
})

const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0
test('claude-tg (sh): the key in TG_KEY, then claude in its place with the arguments', { skip: !hasSh && 'no sh here' }, t => {
  const box = launcherBox(t, { name: 'claude', body: '#!/bin/sh\necho "key=[$TG_KEY] args=[$*]"\nexit 7\n' })
  const r = spawnSync('sh', [join(box.bin, 'claude-tg').replace(/\\/g, '/'), '--resume', 'a b'], { env: box.env, cwd: box.dir, encoding: 'utf8' })
  assert.equal(r.stdout.trim(), 'key=[topic:Billing / hotfix] args=[--resume a b]')
  assert.equal(r.status, 7)
  assert.match(launcherFiles()['claude-tg'], /\nexport TG_KEY\nexec claude "\$@"\n$/)
})
