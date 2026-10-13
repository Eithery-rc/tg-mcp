import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hasSchedules, transcriptPath } from '../src/claude.mjs'
import { matchesAny, reapPlan } from '../src/reaper.mjs'

const now = Date.parse('2026-10-13T21:00:00Z')
const min = m => now - m * 60_000
const snap = {
  workspaces: [
    { workspace_id: 'w1', label: 'Billing' },
    { workspace_id: 'w2', label: 'Блюбениан монитор' },
  ],
  panes: [
    { pane_id: 'w1:p1', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { value: 'a' } },
    { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'claude', agent_status: 'done', agent_session: { value: 'b' } },
    { pane_id: 'w1:p3', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { value: 'c' } },
    { pane_id: 'w1:p4', workspace_id: 'w1', agent: 'claude', agent_status: 'blocked', agent_session: { value: 'd' } },
    { pane_id: 'w1:p5', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { value: 'e' }, focused: true },
    { pane_id: 'w2:p1', workspace_id: 'w2', agent: 'claude', agent_status: 'idle', agent_session: { value: 'f' } },
    { pane_id: 'w1:p6', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { value: 'g' } },
    { pane_id: 'w1:p7', workspace_id: 'w1', agent: 'claude', agent_status: 'idle', agent_session: { value: 'unknown' } },
    { pane_id: 'w1:p8', workspace_id: 'w1' }, // a plain shell
  ],
}
const live = new Map(
  [
    { sessionId: 'a', name: 'Billing-master', status: 'idle', statusUpdatedAt: min(90), cwd: 'C:\\Work\\BB' },
    { sessionId: 'b', name: 'recent', status: 'idle', statusUpdatedAt: min(20) },
    { sessionId: 'c', name: 'monitor-like', status: 'shell', statusUpdatedAt: min(300) },
    { sessionId: 'd', name: 'asking', status: 'idle', statusUpdatedAt: min(300) },
    { sessionId: 'e', name: 'looked-at', status: 'idle', statusUpdatedAt: min(300) },
    { sessionId: 'f', name: 'watcher', status: 'idle', statusUpdatedAt: min(300) },
    { sessionId: 'g', name: 'with-cron', status: 'idle', statusUpdatedAt: min(300) },
  ].map(s => [s.sessionId, s]),
)

test('who sleeps and why the rest stays up', () => {
  const plan = reapPlan(snap, live, { idleMinutes: 60, exclude: ['/монитор/'], now, scheduled: s => s.name === 'with-cron' })
  const byPane = Object.fromEntries(plan.map(p => [p.pane, p.sleep ? 'SLEEP' : p.reason]))
  assert.deepEqual(byPane, {
    'w1:p1': 'SLEEP',
    'w1:p2': 'idle 20 min',
    'w1:p3': 'status shell',
    'w1:p4': 'herdr says blocked',
    'w1:p5': 'focused',
    'w2:p1': 'excluded',
    'w1:p6': 'has scheduled jobs',
    'w1:p7': 'not in the session registry',
  })
  assert.deepEqual(plan[0], {
    pane: 'w1:p1',
    name: 'Billing-master',
    workspace: 'Billing',
    status: 'idle',
    since: min(90),
    idleMin: 90,
    sleep: true,
    session: 'a',
    cwd: 'C:\\Work\\BB',
    reason: 'idle 90 min',
  })
  // only sessions that just need more idle time count down to sleep
  assert.deepEqual(plan.filter(p => p.waiting).map(p => p.pane), ['w1:p2'])
  assert.equal(plan.find(p => p.pane === 'w1:p3').idleMin, 300)
})

test('exclude patterns', () => {
  assert.equal(matchesAny(['billing-master'], ['Billing-master']), true)
  assert.equal(matchesAny(['/^Centium/'], ['centium-EON']), true)
  assert.equal(matchesAny(['Billing'], ['Billing-master']), false)
  assert.equal(matchesAny([], ['x']), false)
})

test('scheduled jobs are found by recent CronCreate or ScheduleWakeup calls only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-wake-'))
  const line = (name, ts) =>
    JSON.stringify({ timestamp: ts, message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input: {} }] } })
  const tools = JSON.stringify({ attachment: { type: 'deferred_tools_record', entries: [{ name: 'CronCreate' }] }, timestamp: '2026-10-13T00:00:00Z' })

  const recent = join(dir, 'recent.jsonl')
  writeFileSync(recent, [tools, line('Bash', '2026-10-13T10:00:00Z'), line('CronCreate', '2026-10-10T10:00:00Z')].join('\n'))
  assert.equal(hasSchedules(recent, now), true)

  const old = join(dir, 'old.jsonl')
  writeFileSync(old, [tools, line('ScheduleWakeup', '2026-10-01T10:00:00Z')].join('\n'))
  assert.equal(hasSchedules(old, now), false)

  const none = join(dir, 'none.jsonl')
  writeFileSync(none, tools) // the tool list mentions CronCreate, but nothing was called
  assert.equal(hasSchedules(none, now), false)
})

test('transcript path follows the cwd slug, else any project folder', () => {
  const projects = mkdtempSync(join(tmpdir(), 'herdr-wake-projects-'))
  mkdirSync(join(projects, 'C--Work-BB'))
  mkdirSync(join(projects, 'C--Elsewhere'))
  writeFileSync(join(projects, 'stray-file.txt'), '')
  writeFileSync(join(projects, 'C--Work-BB', 'abc.jsonl'), '')
  writeFileSync(join(projects, 'C--Elsewhere', 'moved.jsonl'), '')
  assert.equal(transcriptPath('abc', 'C:\\Work\\BB\\', projects), join(projects, 'C--Work-BB', 'abc.jsonl'))
  assert.equal(transcriptPath('moved', 'C:\\Work\\BB', projects), join(projects, 'C--Elsewhere', 'moved.jsonl'))
  assert.equal(transcriptPath('missing', 'C:\\Work\\BB', projects), null)
})
