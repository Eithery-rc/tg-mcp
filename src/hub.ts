// The hub owns every live MCP session and the Telegram side, and routes between them.
//
// Routing model: each agent is identified by a "key" (its working directory, sent by
// the client in the X-Cwd header). Each key gets one forum topic in the private chat
// with the bot. Owner messages in a topic go to the most recently active session for
// that key, pushed as a Claude Code channel event when the session runs as a channel,
// otherwise queued until the agent calls `inbox`.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { basename, dirname } from 'node:path'
import { RingEventStore } from './events'
import { chunkMarkdown, escapeHtml, markdownToHtml } from './format'
import type { Store, Topic } from './store'
import { Telegram, TelegramError, type InlineKeyboard, type TgCallbackQuery, type TgMessage, type TgUpdate } from './telegram'

export type Session = {
  id: string
  n: number // short number used in callback data and logs
  cwd: string
  key: string
  channel: boolean
  mcp: McpServer
  transport: WebStandardStreamableHTTPServerTransport
  lastSeen: number // last HTTP request of any kind
  lastActive: number // last tool call or delivered message; decides routing
  perms: Map<string, { messageId: number; html: string }>
}

type PendingAsk = {
  id: string
  sid: string
  key: string
  messageId: number
  html: string
  options: string[]
  resolve: (answer: string | null) => void
}

export type PermissionRequest = { request_id: string; tool_name: string; description: string; input_preview: string }

const TOPIC_GONE = /thread not found|TOPIC_DELETED|TOPIC_CLOSED|TOPIC_ID_INVALID/i
const VERDICT_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
const STALE_SESSION_MS = 30 * 60_000

function hasLiveStream(t: WebStandardStreamableHTTPServerTransport): boolean {
  // The SDK keeps the standalone GET stream under this key; there is no public accessor.
  const mapping = (t as unknown as { _streamMapping?: Map<string, unknown> })._streamMapping
  return mapping ? mapping.has('_GET_stream') : true
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 8)
}

export class Hub {
  private sessions = new Map<string, Session>()
  private byNumber = new Map<number, Session>()
  private nextNumber = 1
  private topicCreation = new Map<string, Promise<Topic>>()
  private sentBy = new Map<number, string>() // telegram message id -> session id
  private asks = new Map<string, PendingAsk>()
  private lastChannelSeen = new Map<string, number>()
  private startedAt = Date.now()

  constructor(
    private tg: Telegram,
    private store: Store,
    private ownerId: number | undefined,
    private makeServer: (hub: Hub, s: Session) => McpServer,
  ) {
    setInterval(() => this.collectStale(), 5 * 60_000).unref()
  }

  // ───────────────────────────── MCP sessions ─────────────────────────────

  async handleMcp(req: Request): Promise<Response> {
    const sid = req.headers.get('mcp-session-id')
    if (!sid) {
      if (req.method !== 'POST') return rpcError(400, -32000, 'Bad Request: no session')
      return this.openSession(req)
    }
    const s = this.sessions.get(sid)
    // 404 makes Claude Code re-initialize transparently, e.g. after a server restart.
    if (!s) return rpcError(404, -32001, 'Session not found')
    s.lastSeen = Date.now()
    const res = await s.transport.handleRequest(req)
    if (req.method === 'GET' && s.channel) {
      this.lastChannelSeen.set(s.key, Date.now())
      // Give the stream a moment to open, then hand over anything queued while away.
      setTimeout(() => this.flushInbox(s).catch(err => console.error('flush failed', err)), 1500)
    }
    return res
  }

  private async openSession(req: Request): Promise<Response> {
    const cwd = req.headers.get('x-cwd')?.trim() ?? ''
    const now = Date.now()
    const s = {
      id: '',
      n: this.nextNumber++,
      cwd,
      key: cwd || 'unknown',
      channel: /^(1|true|yes|on)$/i.test(req.headers.get('x-channel')?.trim() ?? ''),
      lastSeen: now,
      lastActive: now,
      perms: new Map(),
    } as unknown as Session
    s.mcp = this.makeServer(this, s)
    s.transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      eventStore: new RingEventStore(200),
      onsessioninitialized: id => {
        s.id = id
        this.sessions.set(id, s)
        this.byNumber.set(s.n, s)
      },
      onsessionclosed: id => this.closeSession(id, 'client closed'),
    })
    s.mcp.server.oninitialized = () => {
      this.onInitialized(s).catch(err => console.error(`session #${s.n} init hook failed`, err))
    }
    await s.mcp.connect(s.transport)
    return s.transport.handleRequest(req)
  }

  private async onInitialized(s: Session) {
    if (!s.cwd) {
      // No X-Cwd header configured: fall back to the client's workspace root.
      try {
        const { roots } = await s.mcp.server.listRoots()
        const uri = roots[0]?.uri
        if (uri?.startsWith('file://')) s.cwd = s.key = decodeURIComponent(new URL(uri).pathname)
      } catch {}
    }
    const client = s.mcp.server.getClientVersion()
    console.log(`session #${s.n} up: ${s.key} channel=${s.channel} client=${client?.name}/${client?.version}`)
    if (!s.channel || this.ownerId === undefined) return

    const recentlySeen = (this.lastChannelSeen.get(s.key) ?? 0) > Date.now() - 10 * 60_000
    const justBooted = Date.now() - this.startedAt < 60_000 // clients reconnecting after a deploy
    this.lastChannelSeen.set(s.key, Date.now())
    await this.ensureTopic(s.key)
    if (!recentlySeen && !justBooted) {
      await this.sendText(s.key, `🟢 Сессия подключена — пиши сюда, сообщения уйдут агенту.`, { silent: true })
    }
  }

  private closeSession(id: string, reason: string) {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    this.byNumber.delete(s.n)
    for (const a of this.asks.values()) if (a.sid === id) this.finishAsk(a.id, null, '✖️ сессия закрыта')
    console.log(`session #${s.n} down (${reason}): ${s.key}`)
  }

  private collectStale() {
    const cutoff = Date.now() - STALE_SESSION_MS
    for (const s of this.sessions.values()) {
      if (!hasLiveStream(s.transport) && s.lastSeen < cutoff) {
        this.closeSession(s.id, 'stale')
        s.transport.close().catch(() => {})
      }
    }
  }

  private liveSessions(key: string): Session[] {
    return [...this.sessions.values()].filter(s => s.key === key).sort((a, b) => b.lastActive - a.lastActive)
  }

  /** Re-point a session at a named topic instead of its working directory. */
  async retarget(s: Session, name: string): Promise<Topic> {
    s.key = `topic:${name}`
    return this.ensureTopic(s.key)
  }

  // ───────────────────────────── topics & sending ─────────────────────────────

  private owner(): number {
    if (this.ownerId === undefined) throw new Error('OWNER_ID is not configured: send /start to the bot and put your id into .env')
    return this.ownerId
  }

  async ensureTopic(key: string): Promise<Topic> {
    const existing = this.store.topicByKey(key)
    if (existing) return existing
    let pending = this.topicCreation.get(key)
    if (!pending) {
      pending = this.createTopic(key).finally(() => this.topicCreation.delete(key))
      this.topicCreation.set(key, pending)
    }
    return pending
  }

  private async createTopic(key: string): Promise<Topic> {
    let name = key.startsWith('topic:') ? key.slice(6) : basename(key) || key
    if (this.store.nameTaken(name, key) && !key.startsWith('topic:')) {
      const parent = basename(dirname(key))
      if (parent) name = `${parent}/${name}`
    }
    if (this.store.nameTaken(name, key)) name = `${name} · ${Bun.hash(key).toString(36).slice(0, 4)}`
    name = name.slice(0, 128)
    const t = await this.tg.call<{ message_thread_id: number }>('createForumTopic', { chat_id: this.owner(), name })
    const topic = { key, name, thread_id: t.message_thread_id }
    this.store.saveTopic(topic)
    console.log(`topic created: ${name} (${t.message_thread_id}) for ${key}`)
    return topic
  }

  /** Run a Telegram call inside the key's topic, recreating the topic if the owner deleted it. */
  private async inTopic<T>(key: string, fn: (threadId: number) => Promise<T>): Promise<T> {
    const topic = await this.ensureTopic(key)
    try {
      return await fn(topic.thread_id)
    } catch (err) {
      if (!(err instanceof TelegramError) || !TOPIC_GONE.test(err.description)) throw err
      this.store.deleteTopic(key)
      return fn((await this.ensureTopic(key)).thread_id)
    }
  }

  private remember(messageId: number, sid: string | undefined) {
    if (!sid) return
    this.sentBy.set(messageId, sid)
    if (this.sentBy.size > 5000) this.sentBy.delete(this.sentBy.keys().next().value!)
  }

  /** Send Markdown to a topic, split as needed. Returns the sent messages (last one carries the keyboard). */
  async sendText(
    key: string,
    markdown: string,
    opts: { silent?: boolean; keyboard?: InlineKeyboard; sid?: string } = {},
  ): Promise<{ id: number; html: string }[]> {
    const chunks = chunkMarkdown(markdown)
    const sent: { id: number; html: string }[] = []
    for (const [i, chunk] of chunks.entries()) {
      const last = i === chunks.length - 1
      const html = markdownToHtml(chunk)
      const base = {
        chat_id: this.owner(),
        disable_notification: opts.silent || i > 0,
        link_preview_options: { is_disabled: true },
        reply_markup: last && opts.keyboard ? { inline_keyboard: opts.keyboard } : undefined,
      }
      const msg = await this.inTopic(key, async thread => {
        try {
          return await this.tg.call<TgMessage>('sendMessage', { ...base, message_thread_id: thread, text: html, parse_mode: 'HTML' })
        } catch (err) {
          if (!(err instanceof TelegramError) || !/can't parse entities/i.test(err.description)) throw err
          return this.tg.call<TgMessage>('sendMessage', { ...base, message_thread_id: thread, text: chunk })
        }
      })
      this.remember(msg.message_id, opts.sid)
      sent.push({ id: msg.message_id, html })
    }
    return sent
  }

  async sendFile(key: string, sid: string, filename: string, bytes: Uint8Array, caption?: string): Promise<number> {
    const isImage = /\.(png|jpe?g|webp|gif)$/i.test(filename) && bytes.length <= 10_000_000
    const fields = (thread: number) => ({
      chat_id: this.owner(),
      message_thread_id: thread,
      caption: caption ? markdownToHtml(caption).slice(0, 1024) : undefined,
      parse_mode: caption ? 'HTML' : undefined,
    })
    const msg = await this.inTopic(key, async thread => {
      if (isImage) {
        try {
          return await this.tg.upload<TgMessage>('sendPhoto', fields(thread), 'photo', new Blob([bytes]), filename)
        } catch (err) {
          if (!(err instanceof TelegramError) || TOPIC_GONE.test(err.description)) throw err
        }
      }
      return this.tg.upload<TgMessage>('sendDocument', fields(thread), 'document', new Blob([bytes]), filename)
    })
    this.remember(msg.message_id, sid)
    return msg.message_id
  }

  async download(fileId: string) {
    return this.tg.download(fileId)
  }

  // ───────────────────────────── ask ─────────────────────────────

  async ask(s: Session, question: string, options: string[], timeoutSec: number, signal: AbortSignal): Promise<string | null> {
    const id = shortId()
    const keyboard = options.length
      ? options.map((o, i) => [{ text: o.slice(0, 64), callback_data: `a:${id}:${i}` }])
      : undefined
    const sent = await this.sendText(s.key, `❓ ${question}`, { keyboard, sid: s.id })
    const last = sent[sent.length - 1]!
    return new Promise(resolve => {
      const timer = setTimeout(() => this.finishAsk(id, null, '⌛ без ответа'), timeoutSec * 1000)
      const onAbort = () => this.finishAsk(id, null, '✖️ отменено')
      signal.addEventListener('abort', onAbort, { once: true })
      this.asks.set(id, {
        id,
        sid: s.id,
        key: s.key,
        messageId: last.id,
        html: last.html,
        options,
        resolve: answer => {
          clearTimeout(timer)
          signal.removeEventListener('abort', onAbort)
          resolve(answer)
        },
      })
    })
  }

  private finishAsk(id: string, answer: string | null, note: string) {
    const a = this.asks.get(id)
    if (!a) return
    this.asks.delete(id)
    this.tg
      .call('editMessageText', {
        chat_id: this.ownerId,
        message_id: a.messageId,
        text: `${a.html}\n\n${escapeHtml(note)}`,
        parse_mode: 'HTML',
      })
      .catch(() => {})
    a.resolve(answer)
  }

  // ───────────────────────────── permission relay ─────────────────────────────

  async relayPermission(s: Session, p: PermissionRequest) {
    const preview = p.input_preview.length > 1500 ? `${p.input_preview.slice(0, 1500)}…` : p.input_preview
    const html =
      `🔐 <b>${escapeHtml(p.tool_name)}</b>: ${escapeHtml(p.description)}` +
      (preview ? `\n<pre>${escapeHtml(preview)}</pre>` : '') +
      `\n<i>или ответь: yes ${p.request_id} / no ${p.request_id}</i>`
    const msg = await this.inTopic(s.key, thread =>
      this.tg.call<TgMessage>('sendMessage', {
        chat_id: this.owner(),
        message_thread_id: thread,
        text: html,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Разрешить', callback_data: `p:${s.n}:${p.request_id}:y` },
            { text: '❌ Запретить', callback_data: `p:${s.n}:${p.request_id}:n` },
          ]],
        },
      }),
    )
    s.perms.set(p.request_id, { messageId: msg.message_id, html })
  }

  private async verdict(s: Session, requestId: string, allow: boolean) {
    await s.mcp.server.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: requestId, behavior: allow ? 'allow' : 'deny' },
    })
    const p = s.perms.get(requestId)
    s.perms.delete(requestId)
    if (p) {
      await this.tg
        .call('editMessageText', {
          chat_id: this.ownerId,
          message_id: p.messageId,
          text: `${p.html}\n\n${allow ? '✅ разрешено' : '❌ запрещено'}`,
          parse_mode: 'HTML',
        })
        .catch(() => {})
    }
  }

  // ───────────────────────────── inbound ─────────────────────────────

  /** Push one event into a session. False when it can't be delivered right now. */
  private async push(s: Session, content: string, meta: Record<string, string>): Promise<boolean> {
    if (!s.channel || !this.sessions.has(s.id) || !hasLiveStream(s.transport)) return false
    try {
      await s.mcp.server.notification({ method: 'notifications/claude/channel', params: { content, meta } })
      s.lastActive = Date.now()
      return true
    } catch (err) {
      console.error(`push to #${s.n} failed`, err)
      return false
    }
  }

  async flushInbox(s: Session) {
    if (!s.channel || this.store.pendingCount(s.key) === 0) return
    const items = this.store.drain(s.key)
    for (const [i, it] of items.entries()) {
      const meta = { ...it.meta, queued_at: new Date(it.created_at).toISOString() }
      if (!(await this.push(s, it.text, meta))) {
        for (const rest of items.slice(i)) this.store.enqueue(rest.key, rest.text, rest.meta)
        return
      }
    }
    console.log(`flushed ${items.length} queued message(s) to #${s.n}`)
  }

  pendingCount(key: string) {
    return this.store.pendingCount(key)
  }

  drainInbox(key: string) {
    return this.store.drain(key)
  }

  async handleUpdate(u: TgUpdate) {
    if (u.callback_query) return this.onCallback(u.callback_query)
    const msg = u.message
    if (!msg || msg.chat.type !== 'private' || !msg.from || msg.forum_topic_created) return

    if (this.ownerId === undefined) {
      console.log(`pairing: message from ${msg.from.id} (@${msg.from.username ?? '-'})`)
      await this.tg.call('sendMessage', {
        chat_id: msg.chat.id,
        text: `Твой Telegram id: <code>${msg.from.id}</code>\nПропиши <code>OWNER_ID=${msg.from.id}</code> в .env и перезапусти сервис.`,
        parse_mode: 'HTML',
      })
      return
    }
    if (msg.from.id !== this.ownerId) {
      console.log(`ignored message from non-owner ${msg.from.id} (@${msg.from.username ?? '-'})`)
      return
    }

    const text = msg.text ?? msg.caption ?? ''
    if (/^\/(start|help)\b/.test(text)) return this.reply(msg, HELP)
    if (/^\/status\b/.test(text)) return this.reply(msg, this.status())

    const topic = msg.message_thread_id ? this.store.topicByThread(msg.message_thread_id) : null
    if (!topic) {
      return this.reply(msg, 'Этот топик не привязан к агенту. Агенты создают свои топики сами при подключении. /status — кто сейчас на связи.')
    }

    const v = VERDICT_RE.exec(text)
    if (v) {
      const rid = v[2]!.toLowerCase()
      const s = [...this.sessions.values()].find(x => x.perms.has(rid))
      if (s) return this.verdict(s, rid, v[1]!.toLowerCase().startsWith('y'))
    }

    const { content, meta } = describe(msg)

    // An open question in this topic takes the answer before anything else.
    const replyTo = msg.reply_to_message?.message_id
    const asks = [...this.asks.values()].filter(a => a.key === topic.key)
    const ask = asks.find(a => a.messageId === replyTo) ?? asks[asks.length - 1]
    if (ask) {
      const answer = meta.file_id ? `${content}\n[attachment file_id=${meta.file_id} kind=${meta.file_kind}]` : content
      return this.finishAsk(ask.id, answer, `✅ ${text || `(${meta.file_kind})`}`)
    }

    // Replying to a specific bot message targets the session that sent it.
    const preferred = replyTo ? this.sessions.get(this.sentBy.get(replyTo) ?? '') : undefined
    const candidates = this.liveSessions(topic.key).filter(s => s.channel)
    if (preferred?.channel && preferred.key === topic.key) candidates.unshift(preferred)
    for (const s of candidates) {
      if (await this.push(s, content, meta)) {
        await this.react(msg, '👀')
        return
      }
    }

    this.store.enqueue(topic.key, content, meta)
    const live = this.liveSessions(topic.key).length > 0
    await this.reply(
      msg,
      live
        ? '📥 Сессия запущена без канала: агент увидит сообщение при следующем вызове инструмента.'
        : '💤 Сейчас никто не подключён. Доставлю, когда агент подключится с каналом.',
      true,
    )
  }

  private async onCallback(q: TgCallbackQuery) {
    const answer = (text?: string) => this.tg.call('answerCallbackQuery', { callback_query_id: q.id, text }).catch(() => {})
    if (q.from.id !== this.ownerId) return answer('Not allowed')
    const [kind, a, b, c] = (q.data ?? '').split(':')
    if (kind === 'a') {
      const ask = this.asks.get(a!)
      if (!ask) return answer('Вопрос уже закрыт')
      const choice = ask.options[Number(b)] ?? ''
      this.finishAsk(ask.id, choice, `✅ ${choice}`)
      return answer()
    }
    if (kind === 'p') {
      const s = this.byNumber.get(Number(a))
      if (!s) return answer('Сессия уже закрыта')
      await this.verdict(s, b!, c === 'y')
      return answer(c === 'y' ? 'Разрешено' : 'Запрещено')
    }
    return answer()
  }

  private async reply(msg: TgMessage, text: string, silent = false) {
    await this.tg.call('sendMessage', {
      chat_id: msg.chat.id,
      message_thread_id: msg.message_thread_id,
      text,
      disable_notification: silent,
      reply_parameters: { message_id: msg.message_id, allow_sending_without_reply: true },
    })
  }

  private async react(msg: TgMessage, emoji: string) {
    await this.tg
      .call('setMessageReaction', { chat_id: msg.chat.id, message_id: msg.message_id, reaction: [{ type: 'emoji', emoji }] })
      .catch(() => {})
  }

  status(): string {
    const sessions = [...this.sessions.values()]
    if (!sessions.length) return 'Сейчас нет подключённых сессий.'
    const now = Date.now()
    return sessions
      .sort((a, b) => b.lastActive - a.lastActive)
      .map(s => {
        const name = this.store.topicByKey(s.key)?.name ?? basename(s.key)
        const mins = Math.round((now - s.lastActive) / 60_000)
        const queued = this.store.pendingCount(s.key)
        return `${s.channel ? '🟢' : '🔌'} ${name} — #${s.n}, активность ${mins} мин назад${queued ? `, в очереди ${queued}` : ''}`
      })
      .join('\n')
  }

  get sessionCount() {
    return this.sessions.size
  }

  /** Plain notification for scripts and hooks (POST /notify). */
  async notify(key: string, text: string, silent = false) {
    return this.sendText(key, text, { silent })
  }
}

const HELP = `Я мост между агентами Claude Code и тобой.

• Каждый проект получает свой топик автоматически.
• Пиши в топик — сообщение уйдёт агенту этого проекта.
• Ответ реплаем на сообщение агента адресует конкретную сессию.
• /status — кто сейчас на связи.`

function describe(msg: TgMessage): { content: string; meta: Record<string, string> } {
  const meta: Record<string, string> = {
    message_id: String(msg.message_id),
    user: msg.from?.first_name ?? '',
    ts: new Date(msg.date * 1000).toISOString(),
  }
  let content = msg.text ?? msg.caption ?? ''
  const att = attachmentOf(msg)
  if (att) {
    meta.file_id = att.fileId
    meta.file_kind = att.kind
    if (att.name) meta.file_name = att.name
    if (!content) content = `(${att.kind} attached)`
  }
  const quoted = msg.reply_to_message?.text ?? msg.reply_to_message?.caption
  if (quoted) meta.in_reply_to = quoted.slice(0, 300)
  return { content, meta }
}

function attachmentOf(msg: TgMessage): { fileId: string; kind: string; name?: string } | null {
  if (msg.photo?.length) return { fileId: msg.photo[msg.photo.length - 1]!.file_id, kind: 'photo' }
  if (msg.document) return { fileId: msg.document.file_id, kind: 'document', name: msg.document.file_name }
  if (msg.voice) return { fileId: msg.voice.file_id, kind: 'voice' }
  if (msg.audio) return { fileId: msg.audio.file_id, kind: 'audio', name: msg.audio.file_name }
  if (msg.video) return { fileId: msg.video.file_id, kind: 'video', name: msg.video.file_name }
  return null
}

function rpcError(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: '2.0', error: { code, message }, id: null }, { status })
}
