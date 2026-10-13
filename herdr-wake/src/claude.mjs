// What Claude Code itself records about running sessions: ~/.claude/sessions/<pid>.json (the
// registry ListAgents reads: name, sessionId, status idle | busy | shell, statusUpdatedAt) and
// the transcripts under ~/.claude/projects.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const CLAUDE_DIR = join(homedir(), '.claude')
const WEEK_MS = 7 * 86_400_000

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** Running interactive sessions by session id. */
export function liveSessions(dir = join(CLAUDE_DIR, 'sessions')) {
  const byId = new Map()
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const s = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      if (s.sessionId && s.kind === 'interactive' && alive(s.pid)) byId.set(s.sessionId, s)
    } catch {}
  }
  return byId
}

/** The transcript of a session: projects/<cwd with non-alphanumerics as dashes>/<id>.jsonl. */
export function transcriptPath(sessionId, cwd, projects = join(CLAUDE_DIR, 'projects')) {
  const guess = join(projects, cwd.replace(/[\\/]+$/, '').replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
  if (statSync(guess, { throwIfNoEntry: false })) return guess
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const p = join(projects, entry.name, `${sessionId}.jsonl`)
    if (statSync(p, { throwIfNoEntry: false })) return p
  }
  return null
}

const SCHEDULE_CALL = /"type":"tool_use","id":"[^"]+","name":"(CronCreate|ScheduleWakeup)"/
const scheduleCache = new Map() // transcript path -> { mtimeMs, result }

/**
 * Whether the session scheduled work for itself in the last week (CronCreate, ScheduleWakeup).
 * Such jobs live only in the session's memory and die with it, so the session must stay up.
 * Recurring cron jobs expire after 7 days, hence the window.
 */
export function hasSchedules(path, now = Date.now()) {
  if (!path) return false
  const { mtimeMs } = statSync(path)
  const cached = scheduleCache.get(path)
  if (cached?.mtimeMs === mtimeMs) return cached.result
  let result = false
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!SCHEDULE_CALL.test(line)) continue
    try {
      if (now - Date.parse(JSON.parse(line).timestamp) < WEEK_MS) result = true
    } catch {}
    if (result) break
  }
  scheduleCache.set(path, { mtimeMs, result })
  return result
}
