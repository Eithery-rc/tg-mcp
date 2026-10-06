// Minimal Telegram Bot API client: just the methods this service uses.

export class TelegramError extends Error {
  constructor(public method: string, public code: number, public description: string) {
    super(`${method}: ${code} ${description}`)
  }
}

export type TgUser = { id: number; is_bot: boolean; first_name: string; username?: string }

export type TgMessage = {
  message_id: number
  message_thread_id?: number
  is_topic_message?: boolean
  from?: TgUser
  chat: { id: number; type: string }
  date: number
  text?: string
  caption?: string
  reply_to_message?: TgMessage
  photo?: { file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }[]
  document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  voice?: { file_id: string; duration: number; mime_type?: string; file_size?: number }
  audio?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  video?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number }
  forum_topic_created?: { name: string }
}

export type TgCallbackQuery = {
  id: string
  from: TgUser
  message?: TgMessage
  data?: string
}

export type TgUpdate = {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

export type InlineKeyboard = { text: string; callback_data: string }[][]

export class Telegram {
  private base: string
  private fileBase: string

  constructor(token: string) {
    this.base = `https://api.telegram.org/bot${token}`
    this.fileBase = `https://api.telegram.org/file/bot${token}`
  }

  async call<T = any>(method: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal,
    })
    const body = (await res.json()) as { ok: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } }
    if (!body.ok) {
      // Respect flood control once instead of failing the caller.
      const retry = body.parameters?.retry_after
      if (body.error_code === 429 && retry && retry <= 30) {
        await Bun.sleep(retry * 1000)
        return this.call(method, params, signal)
      }
      throw new TelegramError(method, body.error_code ?? res.status, body.description ?? 'unknown error')
    }
    return body.result as T
  }

  async upload<T = any>(method: string, fields: Record<string, string | number | undefined>, fileField: string, file: Blob, filename: string): Promise<T> {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) if (v !== undefined) form.append(k, String(v))
    form.append(fileField, file, filename)
    const res = await fetch(`${this.base}/${method}`, { method: 'POST', body: form })
    const body = (await res.json()) as { ok: boolean; result?: T; error_code?: number; description?: string }
    if (!body.ok) throw new TelegramError(method, body.error_code ?? res.status, body.description ?? 'unknown error')
    return body.result as T
  }

  async download(fileId: string): Promise<{ bytes: Uint8Array; path: string }> {
    const file = await this.call<{ file_path?: string; file_size?: number }>('getFile', { file_id: fileId })
    if (!file.file_path) throw new Error('file is not downloadable (too large for the Bot API?)')
    const res = await fetch(`${this.fileBase}/${file.file_path}`)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    return { bytes: new Uint8Array(await res.arrayBuffer()), path: file.file_path }
  }

  /** Long-poll forever, handing each update to `onUpdate`. Errors are logged and retried. */
  async poll(onUpdate: (u: TgUpdate) => Promise<void>, signal: AbortSignal) {
    let offset = 0
    while (!signal.aborted) {
      try {
        const updates = await this.call<TgUpdate[]>(
          'getUpdates',
          { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] },
          signal,
        )
        for (const u of updates) {
          offset = u.update_id + 1
          try {
            await onUpdate(u)
          } catch (err) {
            console.error('update handler failed', u.update_id, err)
          }
        }
      } catch (err) {
        if (signal.aborted) return
        console.error('getUpdates failed, retrying in 5s:', err instanceof Error ? err.message : err)
        await Bun.sleep(5000)
      }
    }
  }
}
