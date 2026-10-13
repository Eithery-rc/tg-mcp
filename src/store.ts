// Persistent state: which topic belongs to which agent, plus messages waiting for an agent.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type Topic = { key: string; name: string; thread_id: number }
export type InboxItem = {
  id: number
  key: string
  text: string
  meta: Record<string, string>
  created_at: number
  pane: string | null
  routed: number
}

type InboxRow = Omit<InboxItem, 'meta'> & { meta: string }
const INBOX_COLUMNS = 'id, key, text, meta, created_at, pane, routed'

function toItems(rows: InboxRow[]): InboxItem[] {
  return rows.map(r => ({ ...r, meta: JSON.parse(r.meta) })).sort((a, b) => a.id - b.id)
}

export class Store {
  private db: Database

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true })
    this.db = new Database(join(dataDir, 'state.db'), { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS topics (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        thread_id INTEGER NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        text TEXT NOT NULL,
        meta TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_key ON inbox(key);
      CREATE TABLE IF NOT EXISTS panes (
        key TEXT PRIMARY KEY,
        pane TEXT NOT NULL,
        seen_at INTEGER NOT NULL
      );
    `)
    this.migrate()
  }

  // Router columns. `routed` = 0 while the message belongs to the router, 1 once it is the
  // agents' (inbox tool, channel flush). Rows queued before the router existed default to 1.
  // `lease_until` hides a message from everyone while the router works on it (or until a retry).
  private migrate() {
    const cols = new Set(this.db.query<{ name: string }, []>('PRAGMA table_info(inbox)').all().map(c => c.name))
    if (!cols.has('routed')) this.db.exec('ALTER TABLE inbox ADD COLUMN routed INTEGER NOT NULL DEFAULT 1')
    if (!cols.has('lease_until')) this.db.exec('ALTER TABLE inbox ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0')
    if (!cols.has('pane')) this.db.exec('ALTER TABLE inbox ADD COLUMN pane TEXT')
  }

  topicByKey(key: string): Topic | null {
    return this.db.query<Topic, [string]>('SELECT key, name, thread_id FROM topics WHERE key = ?').get(key)
  }

  topicByThread(threadId: number): Topic | null {
    return this.db.query<Topic, [number]>('SELECT key, name, thread_id FROM topics WHERE thread_id = ?').get(threadId)
  }

  nameTaken(name: string, exceptKey: string): boolean {
    return !!this.db.query('SELECT 1 FROM topics WHERE name = ? AND key != ?').get(name, exceptKey)
  }

  saveTopic(t: Topic) {
    this.db
      .query('INSERT OR REPLACE INTO topics (key, name, thread_id, created_at) VALUES (?, ?, ?, ?)')
      .run(t.key, t.name, t.thread_id, Date.now())
  }

  deleteTopic(key: string) {
    this.db.query('DELETE FROM topics WHERE key = ?').run(key)
  }

  /** Queue a message. `pane` is the herdr pane it is meant for, when known (router hint). */
  enqueue(key: string, text: string, meta: Record<string, string>, pane: string | null = null) {
    this.db
      .query('INSERT INTO inbox (key, text, meta, created_at, routed, pane) VALUES (?, ?, ?, ?, 0, ?)')
      .run(key, text, JSON.stringify(meta), Date.now(), pane)
  }

  /** Put back a drained message as it was (a channel push that failed half way). */
  requeue(it: InboxItem) {
    this.db
      .query('INSERT INTO inbox (key, text, meta, created_at, routed, pane) VALUES (?, ?, ?, ?, ?, ?)')
      .run(it.key, it.text, JSON.stringify(it.meta), it.created_at, it.routed, it.pane)
  }

  // What agents may take: never what the router holds a lease on, and nothing still owned
  // by the router while it is online. Without a router this is everything, as before.
  private static AGENT_VISIBLE = 'key = ?1 AND lease_until <= ?2 AND (routed = 1 OR ?3 = 0)'

  pendingCount(key: string, routerOnline = false): number {
    return (
      this.db
        .query<{ n: number }, [string, number, number]>(`SELECT COUNT(*) AS n FROM inbox WHERE ${Store.AGENT_VISIBLE}`)
        .get(key, Date.now(), routerOnline ? 1 : 0)?.n ?? 0
    )
  }

  /** Remove and return everything queued for `key` that agents may take, oldest first. */
  drain(key: string, routerOnline = false): InboxItem[] {
    const rows = this.db
      .query<InboxRow, [string, number, number]>(`DELETE FROM inbox WHERE ${Store.AGENT_VISIBLE} RETURNING ${INBOX_COLUMNS}`)
      .all(key, Date.now(), routerOnline ? 1 : 0)
    return toItems(rows)
  }

  // ───────────── router ─────────────

  /**
   * Lease router-owned messages to the router, oldest first. A key is handed out as a whole
   * and only while none of its messages is leased, so a topic's messages stay in order.
   */
  leaseForRouter(leaseMs: number, now = Date.now()): InboxItem[] {
    const rows = this.db
      .query<InboxRow, [number, number]>(
        `UPDATE inbox SET lease_until = ?1
         WHERE routed = 0 AND key IN (SELECT key FROM inbox WHERE routed = 0 GROUP BY key HAVING MAX(lease_until) <= ?2)
         RETURNING ${INBOX_COLUMNS}`,
      )
      .all(now + leaseMs, now)
    return toItems(rows)
  }

  /** The router delivered it: remove. Null when it is no longer the router's. */
  routerDelivered(id: number): InboxItem | null {
    const row = this.db.query<InboxRow, [number]>(`DELETE FROM inbox WHERE id = ? AND routed = 0 RETURNING ${INBOX_COLUMNS}`).get(id)
    return row ? toItems([row])[0]! : null
  }

  /** The router gave up on it: leave it queued for the agents. */
  routerSkipped(id: number): InboxItem | null {
    const row = this.db
      .query<InboxRow, [number]>(`UPDATE inbox SET routed = 1, lease_until = 0 WHERE id = ? AND routed = 0 RETURNING ${INBOX_COLUMNS}`)
      .get(id)
    return row ? toItems([row])[0]! : null
  }

  /** The router will try again later: keep it (and the rest of its topic) hidden until `until`. */
  routerRetry(id: number, until: number): InboxItem | null {
    const row = this.db
      .query<InboxRow, [number, number]>(`UPDATE inbox SET lease_until = ? WHERE id = ? AND routed = 0 RETURNING ${INBOX_COLUMNS}`)
      .get(until, id)
    return row ? toItems([row])[0]! : null
  }

  /** Remember the herdr pane a key's session runs in, so the router can find it after it exits. */
  savePane(key: string, pane: string) {
    this.db.query('INSERT OR REPLACE INTO panes (key, pane, seen_at) VALUES (?, ?, ?)').run(key, pane, Date.now())
  }

  paneFor(key: string): string | null {
    return this.db.query<{ pane: string }, [string]>('SELECT pane FROM panes WHERE key = ?').get(key)?.pane ?? null
  }
}
