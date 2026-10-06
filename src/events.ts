// Bounded event store so a client that drops its SSE stream (laptop sleep, flaky
// wifi) can reconnect with Last-Event-ID and receive what it missed.
import type { EventStore } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

type Stored = { id: string; streamId: string; seq: number; message: JSONRPCMessage }

export class RingEventStore implements EventStore {
  private events: Stored[] = []
  private seq = 0

  constructor(private capacity = 200) {}

  async storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const seq = ++this.seq
    const id = `${streamId}#${seq}`
    this.events.push({ id, streamId, seq, message })
    if (this.events.length > this.capacity) this.events.shift()
    return id
  }

  async getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    const i = eventId.lastIndexOf('#')
    return i > 0 ? eventId.slice(0, i) : undefined
  }

  async replayEventsAfter(
    lastEventId: string,
    { send }: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string> {
    const streamId = await this.getStreamIdForEventId(lastEventId)
    if (!streamId) throw new Error('unknown event id')
    const after = Number(lastEventId.slice(lastEventId.lastIndexOf('#') + 1))
    for (const e of this.events) {
      if (e.streamId !== streamId || e.seq <= after) continue
      if (Object.keys(e.message).length === 0) continue // priming event, nothing to deliver
      await send(e.id, e.message)
    }
    return streamId
  }
}
