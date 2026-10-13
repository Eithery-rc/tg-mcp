// herdr-wake: runs as the plugin's "router" pane.
//
// Router: long-polls tg-mcp's /router/wait, finds the herdr pane a message is for, resumes
// the Claude session there through cldt when it has exited, types the message in, and acks.
// Reaper: puts Claude sessions that sat idle for an hour to sleep (/exit, the pane stays,
// marked 💤) and wakes them again for a Telegram message, a SendMessage (see hook.mjs) or
// the local API.
//
//   node src/router.mjs                         the router
//   node src/router.mjs --deliver <key> <text>  route one message by hand, without the server
//   node src/router.mjs --reap-dry              show what the reaper would put to sleep now
//
// Local API on 127.0.0.1:<port>: GET /status, GET /sleeping, POST /wake {target},
// POST /sleep {target}; target is a session name, a pane id or a session id.
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { hasSchedules, liveSessions, transcriptPath } from './claude.mjs'
import { herdr, herdrText, snapshot } from './herdr.mjs'
import { reapPlan } from './reaper.mjs'
import { formatPrompt, resolve } from './route.mjs'
import { inputDraft, isChannelsWarning, isTrustDialog } from './screen.mjs'

const PLUGIN_ID = process.env.HERDR_PLUGIN_ID || 'herdr-wake'
const STATE_DIR =
  process.env.HERDR_PLUGIN_STATE_DIR || join(process.env.LOCALAPPDATA || join(homedir(), '.local', 'state'), 'herdr', 'plugins', PLUGIN_ID)
const CONFIG_DIR =
  process.env.HERDR_PLUGIN_CONFIG_DIR || join(process.env.APPDATA || join(homedir(), '.config'), 'herdr', 'plugins', 'config', PLUGIN_ID)
const LOG_FILE = join(STATE_DIR, 'router.log')
const SESSIONS_FILE = join(STATE_DIR, 'sessions.json')
// Matches the machine prefix sessions put into X-Herdr-Pane (see README).
const MACHINE = process.env.COMPUTERNAME || hostname()

mkdirSync(STATE_DIR, { recursive: true })
const cfg = loadConfig()

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

/** config.json in the plugin config dir; url and token default to the `telegram` MCP server in ~/.claude.json. */
function loadConfig() {
  const file = readJson(join(CONFIG_DIR, 'config.json'), {})
  const c = {
    server: 'telegram',
    port: 12421, // local API; also keeps the router single-instance
    wakeCommand: 'cldt --resume {session}',
    wakeTimeoutSec: 120,
    pollTimeoutSec: 25,
    ...file,
    reaper: { enabled: false, idleMinutes: 60, exclude: [], maxPerRound: 3, ...file.reaper },
  }
  if (!c.url || !c.authorization) {
    const mcp = readJson(join(homedir(), '.claude.json'), {}).mcpServers?.[c.server]
    c.url ??= mcp?.url?.replace(/\/mcp\/?$/, '')
    c.authorization ??= mcp?.headers?.Authorization
  }
  if (!c.url || !c.authorization) throw new Error(`no tg-mcp url/token: set them in ${join(CONFIG_DIR, 'config.json')}`)
  return c
}

function log(...parts) {
  const text = parts.join(' ')
  console.log(`${new Date().toLocaleTimeString('ru-RU')} ${text}`)
  try {
    if ((statSync(LOG_FILE, { throwIfNoEntry: false })?.size ?? 0) > 2_000_000) renameSync(LOG_FILE, `${LOG_FILE}.1`)
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${text}\n`)
  } catch {}
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
const wakeCommand = session => cfg.wakeCommand.replace('{session}', session)

// ───────────── sessions seen per pane ─────────────
// The last Claude session of every pane, so a session that has exited can be resumed there.
// `slept_at` marks the ones the reaper put to sleep.

const sessions = readJson(SESSIONS_FILE, {})
const save = () => writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 1))
const goingToSleep = new Set() // panes between /exit and the shell prompt

/** A snapshot with the time its request started, so a view older than a sleep is not mistaken for a wake. */
async function freshSnapshot() {
  const takenAt = Date.now()
  return Object.assign(await snapshot(), { takenAt })
}

function remember(snap, live = liveSessions()) {
  const now = Date.now()
  const panes = new Set(snap.panes.map(p => p.pane_id))
  let changed = false
  for (const p of snap.panes) {
    const id = p.agent === 'claude' ? p.agent_session?.value : undefined
    if (!id) continue
    const prev = sessions[p.pane_id]
    // Claude back in a sleeping pane: woken by hand or by herdr. Only a view taken after the
    // sleep counts; an older one still shows the session that was just put to sleep.
    if (prev?.slept_at && !goingToSleep.has(p.pane_id) && (snap.takenAt ?? 0) > prev.slept_at) markAwake(p.pane_id)
    const name = live.get(id)?.name || (prev?.session === id ? prev.name : '') || ''
    if (prev?.session === id && prev.name === name && now - prev.seen_at < 60_000) continue
    sessions[p.pane_id] = {
      session: id,
      name,
      cwd: p.cwd,
      title: p.terminal_title_stripped || prev?.title || '',
      seen_at: now,
      ...(goingToSleep.has(p.pane_id) && prev?.slept_at ? { slept_at: prev.slept_at } : {}),
    }
    changed = true
  }
  for (const [pane, s] of Object.entries(sessions)) {
    if (!panes.has(pane) && now - s.seen_at > 7 * 86_400_000) {
      delete sessions[pane]
      changed = true
    }
  }
  if (changed) save()
}

function markAwake(pane) {
  if (!sessions[pane]?.slept_at) return
  delete sessions[pane].slept_at
  save()
  herdr(['pane', 'rename', pane, '--clear']).catch(() => {})
}

/** Sessions the reaper put to sleep whose pane is still there at a shell prompt. */
function sleeping(snap) {
  const panes = new Map(snap.panes.map(p => [p.pane_id, p]))
  const labels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]))
  return Object.entries(sessions)
    .filter(([pane, s]) => s.slept_at && panes.has(pane) && !panes.get(pane).agent)
    .map(([pane, s]) => ({ name: s.name || s.title, pane, session: s.session, workspace: labels.get(panes.get(pane).workspace_id) ?? '', slept_at: new Date(s.slept_at).toISOString() }))
}

// ───────────── waking and delivering ─────────────

const paneLocks = new Map()
function withPane(pane, fn) {
  const next = (paneLocks.get(pane) ?? Promise.resolve()).then(fn)
  paneLocks.set(pane, next.catch(() => {}))
  return next
}

/**
 * Wait until the pane's Claude is ready for input: 'ready', 'trust', 'blocked' or 'timeout'.
 * Sessions started with development channels first ask for a confirmation; that one dialog
 * is answered here. The folder trust question is left to the user.
 */
async function waitReady(pane, timeoutMs) {
  let confirms = 0
  let lastConfirm = 0
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(1500)) {
    const p = (await herdr(['pane', 'get', pane])).pane
    if (p.agent !== 'claude') continue
    if (p.agent_status === 'idle' || p.agent_status === 'done') return 'ready'
    if (p.agent_status !== 'blocked' || Date.now() - lastConfirm < 5000) continue
    const screen = await herdrText(['pane', 'read', pane, '--source', 'visible'])
    if (isTrustDialog(screen)) return 'trust'
    if (confirms >= 3 || !isChannelsWarning(screen)) return 'blocked'
    log(`confirming the development channels warning in ${pane}`)
    await herdr(['pane', 'send-keys', pane, 'enter'])
    confirms++
    lastConfirm = Date.now()
  }
  return 'timeout'
}

const BLOCKED = { retry: 60, note: '⏳ Сессия ждёт решения в терминале. Доставлю, когда освободится.' }
const TRUST = { retry: 60, note: '🔐 Сессия спрашивает, доверять ли папке проекта. Ответь в терминале, и я доставлю.' }

/** Resume the pane's last session with cldt and wait until Claude is ready for input. */
async function wake(pane, session) {
  const info = (await herdr(['pane', 'process-info', '--pane', pane])).process_info
  if (info.foreground_processes.some(p => p.pid !== info.shell_pid)) {
    return { retry: 120, note: '⏳ Панель сессии занята другой программой. Доставлю, когда она освободится.' }
  }
  log(`waking ${session} in ${pane}`)
  await herdr(['pane', 'send-keys', pane, 'esc']) // clears the resume command left at the prompt
  await herdr(['pane', 'run', pane, wakeCommand(session)])
  const state = await waitReady(pane, cfg.wakeTimeoutSec * 1000)
  if (state === 'ready') {
    markAwake(pane)
    return { ok: true }
  }
  if (state === 'timeout') return { retry: 60, note: '⏳ Сессия не успела запуститься, попробую ещё раз.' }
  return state === 'trust' ? TRUST : BLOCKED
}

/** Type the prompt into a running Claude, unless it is waiting for a decision or the user is typing. */
async function deliverLive(pane, text) {
  const agent = (await herdr(['agent', 'get', pane])).agent
  if (agent.agent_status === 'blocked') {
    const state = await waitReady(pane, 30_000)
    if (state !== 'ready') return state === 'trust' ? TRUST : BLOCKED
  }
  const draft = inputDraft(await herdrText(['agent', 'read', pane, '--source', 'recent', '--lines', '40', '--ansi']))
  if (draft === null) return { retry: 30, note: '⏳ В сессии открыт диалог. Доставлю, когда закроется.' }
  if (draft) return { retry: 30, note: '✍️ В поле ввода сессии недописанный текст. Доставлю, когда оно освободится.' }
  await herdr(['agent', 'prompt', pane, text])
  return { ok: true }
}

async function route(items) {
  const snap = await freshSnapshot()
  remember(snap)
  const target = resolve(items[0], snap, sessions, MACHINE)
  if (!target) {
    return { skip: true, note: `🤷 Не нашёл в herdr сессию для «${items[0].topic}». Сообщение ждёт в очереди: агент получит его, когда подключится.` }
  }
  return withPane(target.pane, async () => {
    if (target.session) {
      const woke = await wake(target.pane, target.session)
      if (!woke.ok) return woke
    }
    const r = await deliverLive(target.pane, formatPrompt(items))
    if (r.ok) log(`delivered ${items.length} message(s) for ${items[0].key} to ${target.pane}${target.session ? ' after waking it' : ''}`)
    if (r.ok && target.session) r.note = `⏰ Разбудил сессию${target.title ? ` «${target.title}»` : ''}.`
    return r
  })
}

// ───────────── reaper ─────────────

function plan(snap, live) {
  return reapPlan(snap, live, {
    idleMinutes: cfg.reaper.idleMinutes,
    exclude: cfg.reaper.exclude,
    scheduled: s => {
      try {
        return hasSchedules(transcriptPath(s.sessionId, s.cwd))
      } catch {
        return true // cannot tell: keep it up
      }
    },
  })
}

/** /exit an idle session, leave the pane marked 💤 with the resume command typed at its prompt. */
function putToSleep(pane, p) {
  return withPane(pane, async () => {
    const cur = (await herdr(['pane', 'get', pane])).pane
    if (cur.agent !== 'claude' || cur.agent_session?.value !== p.session) return false
    if (cur.agent_status !== 'idle' && cur.agent_status !== 'done') return false
    if (inputDraft(await herdrText(['agent', 'read', pane, '--source', 'recent', '--lines', '40', '--ansi'])) !== '') return false
    const now = Date.now()
    goingToSleep.add(pane)
    try {
      sessions[pane] = { ...sessions[pane], session: p.session, name: p.name, cwd: p.cwd, seen_at: now, slept_at: now }
      save()
      await herdr(['agent', 'prompt', pane, '/exit'])
      for (const deadline = Date.now() + 30_000; Date.now() < deadline; await sleep(1000)) {
        if ((await herdr(['pane', 'get', pane])).pane.agent) continue
        sessions[pane].slept_at = Date.now() // views taken before this still show Claude
        save()
        await herdr(['pane', 'rename', pane, `💤 ${p.name}`]).catch(() => {})
        await sleep(500)
        await herdr(['pane', 'send-text', pane, wakeCommand(p.session)]).catch(() => {})
        log(`put ${p.name} to sleep in ${pane} (${p.reason})`)
        return true
      }
      delete sessions[pane].slept_at
      save()
      log(`${p.name} in ${pane} did not exit`)
      return false
    } finally {
      goingToSleep.delete(pane)
    }
  })
}

async function reapRound() {
  const snap = await freshSnapshot()
  const live = liveSessions()
  remember(snap, live)
  const due = plan(snap, live).filter(p => p.sleep).slice(0, cfg.reaper.maxPerRound)
  for (const p of due) await putToSleep(p.pane, p).catch(err => log(`sleeping ${p.name} failed: ${err.message}`))
}

// ───────────── local API ─────────────

function findSession(target, snap) {
  const t = String(target ?? '').replace(/\s*\[[0-9a-f]+\]\s*$/i, '').trim().toLowerCase()
  const panes = new Map(snap.panes.map(p => [p.pane_id, p]))
  return Object.entries(sessions)
    .filter(([pane]) => panes.has(pane))
    .map(([pane, s]) => ({ pane, ...s, live: panes.get(pane).agent === 'claude' }))
    .find(s => [s.name, s.pane, s.session].some(v => v && v.toLowerCase() === t))
}

async function wakeTarget(target) {
  const snap = await freshSnapshot()
  remember(snap)
  const s = findSession(target, snap)
  if (!s) return { ok: false, error: `no session named ${target} in herdr` }
  if (s.live) return { ok: true, pane: s.pane, name: s.name, already: true }
  const r = await withPane(s.pane, () => wake(s.pane, s.session))
  if (!r.ok) return { ok: false, error: r.note }
  // It is reachable for SendMessage once it has registered itself again.
  for (const deadline = Date.now() + 20_000; Date.now() < deadline && !liveSessions().has(s.session); ) await sleep(1000)
  log(`woke ${s.name} in ${s.pane} on request`)
  return { ok: true, pane: s.pane, name: s.name }
}

async function sleepTarget(target) {
  const snap = await freshSnapshot()
  const live = liveSessions()
  remember(snap, live)
  const s = findSession(target, snap)
  if (!s?.live) return { ok: false, error: `no running session named ${target}` }
  const entry = live.get(s.session)
  if (!entry || entry.status !== 'idle') return { ok: false, error: `${s.name} is not idle` }
  const ok = await putToSleep(s.pane, { session: s.session, name: s.name, cwd: entry.cwd, reason: 'on request' })
  return ok ? { ok: true, pane: s.pane, name: s.name } : { ok: false, error: `${s.name} did not go to sleep (busy, or text in its input box)` }
}

function readBody(req) {
  return new Promise(resolve => {
    let body = ''
    req.on('data', d => (body += d))
    req.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch {
        resolve({})
      }
    })
  })
}

const status = { pid: process.pid, started: new Date().toISOString(), lastPoll: null, lastError: null }

async function api(req) {
  const path = req.url.split('?')[0]
  if (req.method === 'GET' && path === '/status') return { ...status, reaper: cfg.reaper, sleeping: sleeping(await freshSnapshot()), sessions }
  if (req.method === 'GET' && path === '/sleeping') return sleeping(await freshSnapshot())
  if (req.method === 'POST' && path === '/wake') return wakeTarget((await readBody(req)).target)
  if (req.method === 'POST' && path === '/sleep') return sleepTarget((await readBody(req)).target)
  return null
}

// ───────────── tg-mcp ─────────────

async function ack(id, outcome, note, retrySec) {
  const res = await fetch(`${cfg.url}/router/ack`, {
    method: 'POST',
    headers: { Authorization: cfg.authorization, 'content-type': 'application/json' },
    body: JSON.stringify({ id, outcome, note, retry_sec: retrySec }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
}

const notified = new Map() // message id -> notes already posted for it, so a retry note is said once

async function handleGroup(items) {
  let r
  try {
    r = await route(items)
  } catch (err) {
    log(`routing ${items[0].key} failed: ${err.message}`)
    r = { retry: 30 }
  }
  const outcome = r.ok ? 'delivered' : r.skip ? 'skipped' : 'retry'
  if (!r.ok) log(`${outcome} ${items.length} message(s) for ${items[0].key}${r.note ? `: ${r.note}` : ''}`)
  for (const [i, it] of items.entries()) {
    let note = i === 0 ? r.note : undefined
    if (outcome === 'retry' && note) {
      const seen = notified.get(it.id) ?? new Set()
      note = seen.has(note) ? undefined : (seen.add(note), note)
      notified.set(it.id, seen)
    }
    if (outcome !== 'retry') notified.delete(it.id)
    await ack(it.id, outcome, note, r.retry).catch(err => log(`ack ${it.id} failed: ${err.message}`))
  }
}

function groupByKey(items) {
  const groups = new Map()
  for (const it of items) groups.set(it.key, [...(groups.get(it.key) ?? []), it])
  return [...groups.values()]
}

async function pollLoop() {
  let backoff = 1000
  for (;;) {
    try {
      const res = await fetch(`${cfg.url}/router/wait?timeout=${cfg.pollTimeoutSec}`, {
        headers: { Authorization: cfg.authorization },
        signal: AbortSignal.timeout((cfg.pollTimeoutSec + 20) * 1000),
      })
      if (res.status === 404) throw new Error('the server has no router endpoints (ROUTER=1 not set?)')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { items } = await res.json()
      status.lastPoll = new Date().toISOString()
      if (status.lastError) log('connected to tg-mcp again')
      status.lastError = null
      backoff = 1000
      for (const group of groupByKey(items)) handleGroup(group)
    } catch (err) {
      if (status.lastError !== err.message) log(`poll failed: ${err.message}`)
      status.lastError = err.message
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 60_000)
    }
  }
}

/** Every `ms`, forever; logs an error once until it changes. */
async function every(ms, name, fn) {
  let lastError = null
  for (;;) {
    try {
      await fn()
      lastError = null
    } catch (err) {
      if (lastError !== err.message) log(`${name} failed: ${err.message}`)
      lastError = err.message
    }
    await sleep(ms)
  }
}

// ───────────── main ─────────────

process.on('unhandledRejection', err => log(`unhandled: ${err?.stack ?? err}`))

if (process.argv[2] === '--deliver') {
  const [key, ...words] = process.argv.slice(3)
  const item = { id: 0, key, topic: key, text: words.join(' '), meta: { message_id: 'test' }, queued_at: new Date().toISOString() }
  const r = await route([item])
  console.log(JSON.stringify(r))
  process.exit(r.ok ? 0 : 1)
}

if (process.argv[2] === '--reap-dry') {
  for (const p of plan(await freshSnapshot(), liveSessions())) console.log(`${p.sleep ? 'SLEEP' : 'keep '}  ${p.pane.padEnd(7)} ${p.name.padEnd(34)} ${p.reason}`)
  process.exit(0)
}

const server = http.createServer(async (req, res) => {
  try {
    const out = await api(req)
    if (out === null) return res.writeHead(404).end()
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(out, null, 1))
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: err.message }))
  }
})
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.log(`another router already listens on 127.0.0.1:${cfg.port}, exiting`)
  else log(`local API: ${err.message}`)
  process.exit(err.code === 'EADDRINUSE' ? 0 : 1)
})
server.listen(cfg.port, '127.0.0.1', () => {
  const reaper = cfg.reaper.enabled ? `reaper on (${cfg.reaper.idleMinutes} min)` : 'reaper off'
  log(`router up: ${new URL(cfg.url).host}, ${reaper}, state ${STATE_DIR}, API http://127.0.0.1:${cfg.port}`)
  every(15_000, 'snapshot', async () => remember(await freshSnapshot()))
  if (cfg.reaper.enabled) every(60_000, 'reaper', reapRound)
  pollLoop()
})
