import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatPrompt, localPane, resolve } from '../src/route.mjs'
import { asciiKey, tabKeys } from '../src/topics.mjs'

// Two workspaces: "Billing" with tabs 1 and "hotfix", and a Cyrillic one.
const snap = {
  workspaces: [
    { workspace_id: 'w1', label: 'Billing' },
    { workspace_id: 'w2', label: 'Счета монитор (2)' },
  ],
  tabs: [
    { tab_id: 'w1:t2', workspace_id: 'w1', label: 'hotfix', number: 2 },
    { tab_id: 'w1:t1', workspace_id: 'w1', label: '1', number: 1 },
    { tab_id: 'w2:t1', workspace_id: 'w2', label: '1', number: 1 },
  ],
  panes: [
    { pane_id: 'w1:p1', tab_id: 'w1:t1', agent: 'claude', terminal_title_stripped: 'Billing-master' },
    { pane_id: 'w1:p2', tab_id: 'w1:t1' },
    { pane_id: 'w1:p3', tab_id: 'w1:t2' },
    { pane_id: 'w2:p1', tab_id: 'w2:t1' },
  ],
  agents: [{ pane_id: 'w1:p1', state_change_seq: 10 }],
}

test('routing keys follow the claude-tg launcher', () => {
  const keys = tabKeys(snap)
  assert.deepEqual(keys.get('topic:Billing'), ['w1:t1'])
  assert.deepEqual(keys.get('topic:Billing / hotfix'), ['w1:t2'])
  assert.deepEqual(keys.get('topic:  (2)'), ['w2:t1']) // non-ASCII stripped like claude-tg does, inner spaces stay
  assert.equal(asciiKey('topic:Счета монитор'), 'topic:')
})

test('a running Claude in the tab wins', () => {
  assert.deepEqual(resolve({ key: 'topic:Billing' }, snap, {}, 'PC'), { pane: 'w1:p1', title: 'Billing-master' })
})

test('a stopped session is resumed in its pane', () => {
  const known = { 'w1:p3': { session: 'abc', title: 'Hotfix' } }
  assert.deepEqual(resolve({ key: 'topic:Billing / hotfix' }, snap, known, 'PC'), { pane: 'w1:p3', session: 'abc', title: 'Hotfix' })
})

test('the server pane hint comes first, but only from this machine', () => {
  const known = { 'w2:p1': { session: 'xyz', title: 'Monitor' } }
  assert.equal(resolve({ key: 'topic:other', pane: 'PC:w2:p1' }, snap, known, 'pc').pane, 'w2:p1')
  assert.equal(resolve({ key: 'topic:other', pane: 'LAPTOP2:w2:p1' }, snap, known, 'pc'), null)
})

test('a key that is a working directory finds the pane in it', () => {
  const s = { ...snap, panes: [...snap.panes, { pane_id: 'w2:p2', tab_id: 'w2:t1', cwd: 'C:\\Work\\Acme\\', agent: 'claude', terminal_title_stripped: 'acme' }] }
  assert.equal(resolve({ key: 'C:/Work/Acme' }, s, {}, 'PC').pane, 'w2:p2')
  assert.equal(resolve({ key: '/home/me/proj' }, s, {}, 'PC'), null)
})

test('nothing to deliver to', () => {
  assert.equal(resolve({ key: 'topic:Billing / hotfix' }, snap, {}, 'PC'), null)
  assert.equal(resolve({ key: 'unknown' }, snap, {}, 'PC'), null)
})

test('pane hints', () => {
  assert.equal(localPane('w1:p2', 'PC'), 'w1:p2')
  assert.equal(localPane('PC:w1:p2', 'pc'), 'w1:p2')
  assert.equal(localPane('PC:', 'PC'), 'PC:') // "PC:" alone has one colon: treated as a bare id that matches no pane
  assert.equal(localPane('OTHER:w1:p2', 'PC'), null)
  assert.equal(localPane('', 'PC'), null)
})

test('prompt format', () => {
  const now = Date.parse('2026-10-13T20:00:00Z')
  const items = [
    { meta: { message_id: '5' }, queued_at: '2026-10-13T19:59:30Z', text: 'hello' },
    { meta: { message_id: '6', file_id: 'AgAC-1', file_kind: 'photo', in_reply_to: 'did you "check"?' }, queued_at: '2026-10-13T19:50:00Z', text: '(photo attached)' },
  ]
  assert.equal(
    formatPrompt(items, now),
    '[telegram message_id=5]\nhello\n\n' +
      '[telegram message_id=6 file_id=AgAC-1 file_kind=photo in_reply_to="did you \\"check\\"?" queued_at=2026-10-13T19:50:00Z]\n(photo attached)',
  )
})
