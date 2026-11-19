// Optional speech-to-text for voice messages: any OpenAI-compatible `/audio/transcriptions`
// endpoint (OpenAI Whisper, Groq, a local whisper server).

export type Transcriber = (audio: Uint8Array, filename: string) => Promise<string>

export type SttOptions = { apiKey: string; baseUrl: string; model: string; timeoutMs: number; language?: string }

export function openAiTranscriber(opts: SttOptions): Transcriber {
  const url = `${opts.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`
  return async (audio, filename) => {
    const form = new FormData()
    form.append('file', new Blob([audio]), filename)
    form.append('model', opts.model)
    form.append('response_format', 'text')
    if (opts.language) form.append('language', opts.language)
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(opts.timeoutMs),
      })
    } catch (err) {
      // Name our own budget, so a too-short timeout doesn't read as a provider failure.
      if (err instanceof DOMException && err.name === 'TimeoutError') throw new Error(`no answer within ${opts.timeoutMs / 1000}s`)
      throw err
    }
    if (!res.ok) throw new Error(`${opts.model} HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    const text = (await res.text()).trim()
    if (!text) throw new Error('empty transcript')
    return text
  }
}

/** Telegram stores voice notes as `.oga`, which OpenAI rejects by extension; it is Ogg/Opus. */
export function sttFilename(telegramPath: string): string {
  const name = telegramPath.split('/').pop() || 'voice.ogg'
  return name.replace(/\.oga$/i, '.ogg')
}
