// Telegram router: long-polls tg-mcp's /router/wait, finds the herdr pane a message is for,
// resumes the Claude session there through cldt when it has exited, types the message in,
// and acks. Runs as the plugin's "router" pane.
//
//   node src/router.mjs                         the router
//   node src/router.mjs --deliver <key> <text>  route one message by hand, without the server
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { herdr, herdrText, snapshot } from './herdr.mjs'
import { formatPrompt, resolve } from './route.mjs'
import { inputDraft, isChannelsWarning } from './screen.mjs'

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
  const c = {
    server: 'telegram',
    port: 12421, // local status endpoint; also keeps the router single-instance
    wakeCommand: 'cldt --resume {session}',
    wakeTimeoutSec: 120,
    pollTimeoutSec: 25,
    ...readJson(join(CONFIG_DIR, 'config.json'), {}),
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

// ───────────── sessions seen per pane ─────────────
// The last Claude session of every pane, so a session that has exited can be resumed there.

const sessions = readJson(SESSIONS_FILE, {})

function remember(snap) {
  const now = Date.now()
  const panes = new Set(snap.panes.map(p => p.pane_id))
  let changed = false
  for (const p of snap.panes) {
    const id = p.agent === 'claude' ? p.agent_session?.value : undefined
    if (!id) continue
    const prev = sessions[p.pane_id]
    if (prev?.session === id && now - prev.seen_at < 60_000) continue
    sessions[p.pane_id] = { session: id, cwd: p.cwd, title: p.terminal_title_stripped || prev?.title || '', seen_at: now }
    changed = true
  }
  for (const [pane, s] of Object.entries(sessions)) {
    if (!panes.has(pane) && now - s.seen_at > 7 * 86_400_000) {
      delete sessions[pane]
      changed = true
    }
  }
  if (changed) writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 1))
}

// ───────────── routing ─────────────

const paneLocks = new Map()
function withPane(pane, fn) {
  const next = (paneLocks.get(pane) ?? Promise.resolve()).then(fn)
  paneLocks.set(pane, next.catch(() => {}))
  return next
}

/**
 * Wait until the pane's Claude is ready for input: 'ready', 'blocked' or 'timeout'. cldt
 * starts Claude with development channels, which first asks for a confirmation (also after
 * a herdr restart resumes panes through cldt); that one dialog is answered here.
 */
async function waitReady(pane, timeoutMs) {
  let confirms = 0
  let lastConfirm = 0
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(1500)) {
    const p = (await herdr(['pane', 'get', pane])).pane
    if (p.agent !== 'claude') continue
    if (p.agent_status === 'idle' || p.agent_status === 'done') return 'ready'
    if (p.agent_status !== 'blocked' || Date.now() - lastConfirm < 5000) continue
    if (confirms >= 3 || !isChannelsWarning(await herdrText(['pane', 'read', pane, '--source', 'visible']))) return 'blocked'
    log(`confirming the development channels warning in ${pane}`)
    await herdr(['pane', 'send-keys', pane, 'enter'])
    confirms++
    lastConfirm = Date.now()
  }
  return 'timeout'
}

const BLOCKED = { retry: 60, note: '⏳ Сессия ждёт решения в терминале. Доставлю, когда освободится.' }

/** Resume the pane's last session with cldt and wait until Claude is ready for input. */
async function wake(pane, session) {
  const info = (await herdr(['pane', 'process-info', '--pane', pane])).process_info
  if (info.foreground_processes.some(p => p.pid !== info.shell_pid)) {
    return { retry: 120, note: '⏳ Панель сессии занята другой программой. Доставлю, когда она освободится.' }
  }
  log(`waking ${session} in ${pane}`)
  await herdr(['pane', 'run', pane, cfg.wakeCommand.replace('{session}', session)])
  const state = await waitReady(pane, cfg.wakeTimeoutSec * 1000)
  if (state === 'ready') return { ok: true }
  return state === 'blocked' ? BLOCKED : { retry: 60, note: '⏳ Сессия не успела запуститься, попробую ещё раз.' }
}

/** Type the prompt into a running Claude, unless it is waiting for a decision or the user is typing. */
async function deliverLive(pane, text) {
  const agent = (await herdr(['agent', 'get', pane])).agent
  if (agent.agent_status === 'blocked' && (await waitReady(pane, 30_000)) !== 'ready') return BLOCKED
  const draft = inputDraft(await herdrText(['agent', 'read', pane, '--source', 'recent', '--lines', '40', '--ansi']))
  if (draft === null) return { retry: 30, note: '⏳ В сессии открыт диалог. Доставлю, когда закроется.' }
  if (draft) return { retry: 30, note: '✍️ В поле ввода сессии недописанный текст. Доставлю, когда оно освободится.' }
  await herdr(['agent', 'prompt', pane, text])
  return { ok: true }
}

async function route(items) {
  const snap = await snapshot()
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

// ───────────── server ─────────────

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

const status = { pid: process.pid, started: new Date().toISOString(), lastPoll: null, lastError: null }

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

async function rememberLoop() {
  let lastError = null
  for (;;) {
    try {
      remember(await snapshot())
      lastError = null
    } catch (err) {
      if (lastError !== err.message) log(`snapshot failed: ${err.message}`)
      lastError = err.message
    }
    await sleep(15_000)
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

const server = http.createServer((req, res) => {
  if (req.url !== '/status') return res.writeHead(404).end()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ...status, sessions }, null, 1))
})
server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.log(`another router already listens on 127.0.0.1:${cfg.port}, exiting`)
  else log(`status server: ${err.message}`)
  process.exit(err.code === 'EADDRINUSE' ? 0 : 1)
})
server.listen(cfg.port, '127.0.0.1', () => {
  log(`router up: ${new URL(cfg.url).host}, state ${STATE_DIR}, status http://127.0.0.1:${cfg.port}/status`)
  rememberLoop()
  pollLoop()
})
