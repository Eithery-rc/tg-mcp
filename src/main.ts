import { timingSafeEqual } from 'node:crypto'
import { config } from './config'
import { Hub } from './hub'
import { createMcpServer } from './mcp'
import { Store } from './store'
import { Telegram } from './telegram'

const tg = new Telegram(config.botToken)
const store = new Store(config.dataDir)
const hub = new Hub(tg, store, config.ownerId, createMcpServer)

const expected = Buffer.from(`Bearer ${config.mcpToken}`)
function authorized(req: Request): boolean {
  const got = Buffer.from(req.headers.get('authorization') ?? '')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

const server = Bun.serve({
  hostname: config.host,
  port: config.port,
  idleTimeout: 0, // SSE streams stay open indefinitely
  async fetch(req) {
    const { pathname } = new URL(req.url)
    if (pathname === '/health') return Response.json({ ok: true, sessions: hub.sessionCount })
    if (!authorized(req)) return new Response('unauthorized', { status: 401 })

    if (pathname === '/mcp') return hub.handleMcp(req)

    if (pathname === '/notify' && req.method === 'POST') {
      // For scripts and hooks: {"text": "...", "cwd"?: "/path" | "topic"?: "name", "silent"?: true}
      const body = (await req.json().catch(() => null)) as { text?: string; cwd?: string; topic?: string; silent?: boolean } | null
      if (!body?.text) return Response.json({ error: 'text is required' }, { status: 400 })
      const key = body.cwd ? body.cwd : `topic:${body.topic || 'notifications'}`
      const sent = await hub.notify(key, body.text, body.silent)
      return Response.json({ ok: true, message_ids: sent.map(m => m.id) })
    }
    return new Response('not found', { status: 404 })
  },
  error(err) {
    console.error('request failed', err)
    return Response.json({ error: err.message }, { status: 500 })
  },
})

const abort = new AbortController()
tg.poll(u => hub.handleUpdate(u), abort.signal)

if (config.ownerId === undefined) {
  console.log('OWNER_ID is not set: pairing mode. Send /start to the bot to learn your id.')
}
console.log(`tg-mcp listening on http://${server.hostname}:${server.port}`)

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    abort.abort()
    server.stop(true)
    process.exit(0)
  })
}
