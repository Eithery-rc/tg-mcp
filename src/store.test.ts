import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store'

const tempDir = () => mkdtempSync(join(tmpdir(), 'tg-mcp-test-'))
const meta = (id: number) => ({ message_id: String(id) })

test('without a router the inbox works as before', () => {
  const store = new Store(tempDir())
  store.enqueue('a', 'one', meta(1))
  store.enqueue('a', 'two', meta(2))
  store.enqueue('b', 'other', meta(3))
  expect(store.pendingCount('a')).toBe(2)
  expect(store.drain('a').map(it => it.text)).toEqual(['one', 'two'])
  expect(store.pendingCount('a')).toBe(0)
  expect(store.pendingCount('b')).toBe(1)
})

test('rows queued before the upgrade stay with the agents', () => {
  const dir = tempDir()
  const old = new Database(join(dir, 'state.db'), { create: true })
  old.exec(`CREATE TABLE inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, text TEXT NOT NULL,
            meta TEXT NOT NULL, created_at INTEGER NOT NULL)`)
  old.query('INSERT INTO inbox (key, text, meta, created_at) VALUES (?, ?, ?, ?)').run('a', 'legacy', '{}', 1)
  old.close()

  const store = new Store(dir)
  expect(store.leaseForRouter(60_000)).toEqual([])
  expect(store.pendingCount('a', true)).toBe(1)
  expect(store.drain('a', true).map(it => it.text)).toEqual(['legacy'])
})

test('while the router is online its messages are hidden from agents', () => {
  const store = new Store(tempDir())
  store.enqueue('a', 'one', meta(1), 'w1:p1')
  expect(store.pendingCount('a', true)).toBe(0)
  expect(store.drain('a', true)).toEqual([])
  const [it] = store.leaseForRouter(60_000)
  expect(it).toMatchObject({ key: 'a', text: 'one', pane: 'w1:p1', routed: 0 })
})

test('a topic is leased as a whole and stays in order', () => {
  const store = new Store(tempDir())
  const now = Date.now()
  store.enqueue('a', 'a1', meta(1))
  store.enqueue('b', 'b1', meta(2))
  store.enqueue('a', 'a2', meta(3))
  expect(store.leaseForRouter(60_000, now).map(it => it.text)).toEqual(['a1', 'b1', 'a2'])

  // Nothing is handed out twice, and a new message waits behind its topic's lease.
  store.enqueue('a', 'a3', meta(4))
  store.enqueue('c', 'c1', meta(5))
  expect(store.leaseForRouter(60_000, now).map(it => it.text)).toEqual(['c1'])

  // After the leases run out everything comes back, oldest first.
  expect(store.leaseForRouter(60_000, now + 61_000).map(it => it.text)).toEqual(['a1', 'b1', 'a2', 'a3', 'c1'])
})

test('router outcomes', () => {
  const store = new Store(tempDir())
  const now = Date.now()
  store.enqueue('a', 'delivered', meta(1))
  store.enqueue('b', 'skipped', meta(2))
  store.enqueue('c', 'retried', meta(3))
  const [a, b, c] = store.leaseForRouter(60_000, now)

  expect(store.routerDelivered(a!.id)?.text).toBe('delivered')
  expect(store.routerDelivered(a!.id)).toBeNull()
  expect(store.pendingCount('a', true)).toBe(0)

  expect(store.routerSkipped(b!.id)?.text).toBe('skipped')
  expect(store.pendingCount('b', true)).toBe(1) // back with the agents
  expect(store.routerDelivered(b!.id)).toBeNull() // no longer the router's

  expect(store.routerRetry(c!.id, now + 5_000)?.text).toBe('retried')
  expect(store.leaseForRouter(60_000, now + 1_000)).toEqual([])
  expect(store.leaseForRouter(60_000, now + 6_000).map(it => it.text)).toEqual(['retried'])
})

test('a leased message is not drained even when the router went away', () => {
  const store = new Store(tempDir())
  store.enqueue('a', 'one', meta(1))
  store.leaseForRouter(60_000)
  expect(store.pendingCount('a', false)).toBe(0)
  expect(store.drain('a', false)).toEqual([])
})

test('requeue keeps who owns the message', () => {
  const store = new Store(tempDir())
  store.enqueue('a', 'one', meta(1), 'w1:p1')
  const [it] = store.drain('a')
  store.requeue(it!)
  expect(store.leaseForRouter(60_000)).toMatchObject([{ text: 'one', pane: 'w1:p1', routed: 0 }])
})

test('panes are remembered per key', () => {
  const store = new Store(tempDir())
  expect(store.paneFor('a')).toBeNull()
  store.savePane('a', 'w1:p1')
  store.savePane('a', 'w2:p3')
  expect(store.paneFor('a')).toBe('w2:p3')
})
