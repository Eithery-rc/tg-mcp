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
