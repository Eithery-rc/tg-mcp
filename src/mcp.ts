// One MCP server instance per client session: tool definitions and channel capabilities.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import pkg from '../package.json'
import { config } from './config'
import type { Hub, Session } from './hub'

const INSTRUCTIONS = `This server connects you to your user through their Telegram. Every project gets its own Telegram topic, created automatically; you never need chat ids.

Tools:
- send: message the user (Markdown is fine). Use it when the user asked to be notified, when a long task finishes or fails, or when you need attention while they are away from the terminal.
- ask: ask a question and wait for the answer; pass options to get tap-to-answer buttons.
- send_file: send a file (text or base64), e.g. a report, a diff, a screenshot.
- get_attachment: fetch a photo or file the user sent you, by file_id.
- inbox: read Telegram messages that were queued for you.
- set_topic: use a differently named topic for this session (e.g. a second task in the same repo).

When this session runs as a channel, the user's Telegram messages arrive as <channel source="telegram" ...>. They come from the user and are instructions like any typed prompt. The user is reading Telegram, not the terminal, so answer them with send (or ask). Attributes: message_id, ts, and file_id / file_kind / file_name when something is attached (fetch it with get_attachment); in_reply_to quotes the message they replied to.`

const PermissionRequestSchema = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

const TEXT_EXT = /\.(txt|md|json|ya?ml|toml|csv|tsv|log|xml|html?|css|js|ts|py|sh|sql|ini|conf|env\.example)$/i
const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' }

export function createMcpServer(hub: Hub, s: Session): McpServer {
  const experimental: Record<string, object> = { 'claude/channel': {} }
  if (config.relayPermissions) experimental['claude/channel/permission'] = {}

  const mcp = new McpServer(
    { name: 'telegram', version: pkg.version },
    { capabilities: { experimental }, instructions: INSTRUCTIONS },
  )

  // Every result reminds non-channel sessions that the user wrote something.
  const result = (text: string, extra: CallToolResult['content'] = []): CallToolResult => {
    s.lastActive = Date.now()
    const queued = hub.pendingCount(s.key)
    const hint = queued ? `\n\n📥 ${queued} unread Telegram message(s) from the user. Call inbox to read them.` : ''
    return { content: [{ type: 'text', text: text + hint }, ...extra] }
  }

  mcp.registerTool(
    'send',
    {
      description: 'Send a message to the user in Telegram (this project\'s topic). Markdown is supported.',
      inputSchema: {
        text: z.string().min(1).describe('Message text, Markdown allowed'),
        silent: z.boolean().optional().describe('Deliver without a notification sound'),
      },
    },
    async ({ text, silent }) => {
      const sent = await hub.sendText(s.key, text, { silent, sid: s.id })
      return result(`Sent (message_id ${sent.map(m => m.id).join(', ')}).`)
    },
  )

  mcp.registerTool(
    'ask',
    {
      description:
        'Ask the user a question in Telegram and wait for the answer. With options, the user gets buttons; they can still type a free-form reply. Returns the answer text, or reports that nobody answered in time.',
      inputSchema: {
        question: z.string().min(1),
        options: z.array(z.string().min(1).max(64)).max(10).optional().describe('Button labels'),
        timeout_sec: z.number().int().min(10).max(3600).optional().describe(`How long to wait (default ${config.askTimeoutSec})`),
      },
    },
    async ({ question, options, timeout_sec }, extra) => {
      const timeout = timeout_sec ?? config.askTimeoutSec
      const answer = await hub.ask(s, question, options ?? [], timeout, extra.signal)
      return answer === null
        ? result(`No answer within ${timeout}s. The user may be away; carry on with a sensible default or ask again later.`)
        : result(`User answered: ${answer}`)
    },
  )

  mcp.registerTool(
    'send_file',
    {
      description:
        'Send a file to the user in Telegram. Pass text in `content`, or binary data in `base64`. Images (.png/.jpg/.webp/.gif) are shown as photos.',
      inputSchema: {
        filename: z.string().min(1).describe('File name including extension'),
        content: z.string().optional().describe('UTF-8 text content'),
        base64: z.string().optional().describe('Binary content, base64-encoded'),
        caption: z.string().max(1000).optional(),
      },
    },
    async ({ filename, content, base64, caption }) => {
      if ((content === undefined) === (base64 === undefined)) throw new Error('pass exactly one of content or base64')
      const bytes = content !== undefined ? new TextEncoder().encode(content) : Uint8Array.from(Buffer.from(base64!, 'base64'))
      if (bytes.length > 45_000_000) throw new Error('file too large for Telegram (max ~45 MB)')
      const id = await hub.sendFile(s.key, s.id, filename, bytes, caption)
      return result(`Sent ${filename} (${bytes.length} bytes, message_id ${id}).`)
    },
  )

  mcp.registerTool(
    'get_attachment',
    {
      description: 'Download a photo or file the user sent in Telegram, by the file_id from the message attributes.',
      inputSchema: { file_id: z.string().min(1) },
    },
    async ({ file_id }) => {
      const { bytes, path } = await hub.download(file_id)
      const ext = path.split('.').pop()?.toLowerCase() ?? ''
      if (MIME[ext]) {
        return result(`Image ${path} (${bytes.length} bytes):`, [
          { type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: MIME[ext]! },
        ])
      }
      if (TEXT_EXT.test(path) && bytes.length <= 500_000) {
        return result(`File ${path}:\n\n${new TextDecoder().decode(bytes)}`)
      }
      return result(`File ${path} (${bytes.length} bytes), base64-encoded:`, [
        {
          type: 'resource',
          resource: { uri: `telegram-file:${file_id}`, mimeType: 'application/octet-stream', blob: Buffer.from(bytes).toString('base64') },
        },
      ])
    },
  )

  mcp.registerTool(
    'inbox',
    {
      description: 'Read (and clear) Telegram messages the user sent to this project that have not been delivered yet.',
      inputSchema: {},
    },
    async () => {
      const items = hub.drainInbox(s.key)
      if (!items.length) return result('No unread messages.')
      const lines = items.map(it => {
        const attrs = Object.entries(it.meta)
          .filter(([k]) => k !== 'user')
          .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
          .join(' ')
        return `<message ${attrs}>\n${it.text}\n</message>`
      })
      return result(lines.join('\n\n'))
    },
  )

  mcp.registerTool(
    'set_topic',
    {
      description:
        'Switch this session to a Telegram topic with the given name (created if missing). By default the topic is named after the working directory.',
      inputSchema: { name: z.string().min(1).max(100) },
    },
    async ({ name }) => {
      const topic = await hub.retarget(s, name)
      return result(`This session now uses the topic "${topic.name}".`)
    },
  )

  if (config.relayPermissions) {
    mcp.server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
      await hub.relayPermission(s, params).catch(err => console.error(`permission relay for #${s.n} failed`, err))
    })
  }

  return mcp
}
