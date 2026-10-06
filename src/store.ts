// Persistent state: which topic belongs to which agent, plus messages waiting for an agent.
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type Topic = { key: string; name: string; thread_id: number }
export type InboxItem = { id: number; key: string; text: string; meta: Record<string, string>; created_at: number }

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
    `)
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

  enqueue(key: string, text: string, meta: Record<string, string>) {
    this.db
      .query('INSERT INTO inbox (key, text, meta, created_at) VALUES (?, ?, ?, ?)')
      .run(key, text, JSON.stringify(meta), Date.now())
  }

  pendingCount(key: string): number {
    return this.db.query<{ n: number }, [string]>('SELECT COUNT(*) AS n FROM inbox WHERE key = ?').get(key)?.n ?? 0
  }

  /** Remove and return everything queued for `key`, oldest first. */
  drain(key: string): InboxItem[] {
    const rows = this.db
      .query<{ id: number; key: string; text: string; meta: string; created_at: number }, [string]>(
        'DELETE FROM inbox WHERE key = ? RETURNING id, key, text, meta, created_at',
      )
      .all(key)
    return rows.map(r => ({ ...r, meta: JSON.parse(r.meta) })).sort((a, b) => a.id - b.id)
  }
}
