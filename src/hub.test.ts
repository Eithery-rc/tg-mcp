import { beforeEach, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store'
import type { Telegram, TgUpdate } from './telegram'

// config reads the environment on import, so set it up before loading the hub.
process.env.TELEGRAM_BOT_TOKEN ||= 'test-token'
process.env.MCP_TOKEN ||= 'x'.repeat(32)
process.env.ROUTER = '1'
const { Hub } = await import('./hub')

const OWNER = 42
const THREAD = 77
const KEY = 'topic:Billing'

let calls: { method: string; params: any }[]
let store: Store
let hub: InstanceType<typeof Hub>

beforeEach(() => {
  calls = []
  const tg = {
    call: async (method: string, params: any) => {
      calls.push({ method, params })
      return { message_id: 1000 + calls.length }
    },
  } as unknown as Telegram
  store = new Store(mkdtempSync(join(tmpdir(), 'tg-mcp-hub-')))
  store.saveTopic({ key: KEY, name: 'Billing', thread_id: THREAD })
  hub = new Hub(tg, store, OWNER, () => {
    throw new Error('no MCP sessions in these tests')
  })
})

const message = (id: number, text: string): TgUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    message_thread_id: THREAD,
    from: { id: OWNER, is_bot: false, first_name: 'R' },
    chat: { id: OWNER, type: 'private' },
    date: 1_700_000_000,
    text,
  },
})

test('with no router polling, messages are queued for the agents as before', async () => {
  await hub.handleUpdate(message(5, 'hello'))
  expect(calls.map(c => c.method)).toEqual(['sendMessage'])
  expect(calls[0]!.params.text).toStartWith('💤')
  expect(hub.pendingCount(KEY)).toBe(1)
  expect(hub.drainInbox(KEY).map(it => it.text)).toEqual(['hello'])
})

test('a polling router gets the message and its ack reacts', async () => {
  const wait = hub.routerWait(2_000, new AbortController().signal)
  await hub.handleUpdate(message(5, 'hello'))
  const items = await wait
  expect(items).toMatchObject([{ key: KEY, topic: 'Billing', text: 'hello', meta: { message_id: '5' }, pane: null, live_panes: [] }])
  expect(calls).toEqual([]) // no "nobody is connected" reply while the router handles it
  expect(hub.pendingCount(KEY)).toBe(0) // and the agents don't see it twice

  expect(await hub.routerAck(items[0]!.id, 'delivered')).toBe(true)
  expect(calls).toMatchObject([{ method: 'setMessageReaction', params: { chat_id: OWNER, message_id: 5 } }])
  expect(await hub.routerAck(items[0]!.id, 'delivered')).toBe(false)
})

test('a skipped message goes back to the agents with a note', async () => {
  const wait = hub.routerWait(2_000, new AbortController().signal)
  await hub.handleUpdate(message(6, 'are you there'))
  const [item] = await wait
  expect(await hub.routerAck(item!.id, 'skipped', 'no session for this topic')).toBe(true)
  expect(calls).toMatchObject([
    { method: 'sendMessage', params: { message_thread_id: THREAD, text: 'no session for this topic', reply_parameters: { message_id: 6 } } },
  ])
  expect(hub.drainInbox(KEY).map(it => it.text)).toEqual(['are you there'])
})

test('an empty wait times out with nothing', async () => {
  expect(await hub.routerWait(50, new AbortController().signal)).toEqual([])
  expect(hub.routerOnline()).toBe(true)
})

test('an aborted wait returns at once', async () => {
  const ctl = new AbortController()
  const wait = hub.routerWait(10_000, ctl.signal)
  ctl.abort()
  expect(await wait).toEqual([])
})


// ───────────────────────────── voice transcription ─────────────────────────────

const voice = (id: number, caption?: string): TgUpdate => ({
  update_id: id,
  message: {
    message_id: id,
    message_thread_id: THREAD,
    from: { id: OWNER, is_bot: false, first_name: 'R' },
    chat: { id: OWNER, type: 'private' },
    date: 1_700_000_000,
    voice: { file_id: 'VOICE', duration: 3, mime_type: 'audio/ogg' },
    ...(caption ? { caption } : {}),
  },
})

function voiceHub(transcribe: (audio: Uint8Array, filename: string) => Promise<string>) {
  const tg = {
    call: async (method: string, params: any) => {
      calls.push({ method, params })
      return { message_id: 1000 + calls.length }
    },
    download: async (fileId: string) => ({ bytes: new Uint8Array([1, 2, 3]), path: `voice/${fileId}.oga` }),
  } as unknown as Telegram
  return new Hub(tg, store, OWNER, () => { throw new Error('no MCP sessions in these tests') }, transcribe)
}

test('a voice note reaches the agents as its transcript, with the audio still attached', async () => {
  let sentName = ''
  const h = voiceHub(async (_audio, filename) => {
    sentName = filename
    return 'купи хлеба'
  })
  await h.handleUpdate(voice(9))
  expect(sentName).toBe('VOICE.ogg') // Telegram's .oga is renamed, OpenAI rejects it by extension
  const [item] = h.drainInbox(KEY)
  expect(item!.text).toBe('🎤 купи хлеба')
  expect(item!.meta.transcribed).toBe('true')
  expect(item!.meta.file_id).toBe('VOICE')
})

test('a caption is kept in front of the transcript', async () => {
  const h = voiceHub(async () => 'подробности')
  await h.handleUpdate(voice(9, 'к задаче'))
  expect(h.drainInbox(KEY).map(it => it.text)).toEqual(['к задаче\n🎤 подробности'])
})

test('a failed transcription is said in the topic and recorded, not dropped', async () => {
  const h = voiceHub(async () => { throw new Error('whisper-1 HTTP 429: quota') })
  await h.handleUpdate(voice(9))
  const warning = calls.find(c => c.method === 'sendMessage' && String(c.params.text).startsWith('⚠️'))
  expect(warning?.params.text).toContain('HTTP 429')
  const [item] = h.drainInbox(KEY)
  expect(item!.text).toBe('(voice attached)')
  expect(item!.meta.transcription_error).toContain('HTTP 429')
  expect(item!.meta.transcribed).toBeUndefined()
})

test('without a transcriber a voice note is passed on untouched', async () => {
  await hub.handleUpdate(voice(9))
  expect(hub.drainInbox(KEY).map(it => it.text)).toEqual(['(voice attached)'])
})
