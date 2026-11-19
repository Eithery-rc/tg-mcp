import { afterEach, expect, test } from 'bun:test'
import { openAiTranscriber, sttFilename } from './stt'

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

const opts = { apiKey: 'k', baseUrl: 'https://stt.example/v1/', model: 'whisper-1', timeoutMs: 1000, language: 'ru' }

test('posts the audio as multipart and returns the trimmed text', async () => {
  let seen: { url: string; auth: string | null; form: FormData } | undefined
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url, auth: new Headers(init.headers).get('authorization'), form: init.body as FormData }
    return new Response('  привет \n')
  }) as typeof fetch
  expect(await openAiTranscriber(opts)(new Uint8Array([1]), 'a.ogg')).toBe('привет')
  expect(seen!.url).toBe('https://stt.example/v1/audio/transcriptions')
  expect(seen!.auth).toBe('Bearer k')
  expect(seen!.form.get('model')).toBe('whisper-1')
  expect(seen!.form.get('language')).toBe('ru')
  expect((seen!.form.get('file') as File).name).toBe('a.ogg')
})

test('an HTTP error carries the status and the start of the body', async () => {
  globalThis.fetch = (async () => new Response('bad key', { status: 401 })) as unknown as typeof fetch
  await expect(openAiTranscriber(opts)(new Uint8Array([1]), 'a.ogg')).rejects.toThrow('whisper-1 HTTP 401: bad key')
})

test('an empty transcript is an error, not an empty message', async () => {
  globalThis.fetch = (async () => new Response('   ')) as unknown as typeof fetch
  await expect(openAiTranscriber(opts)(new Uint8Array([1]), 'a.ogg')).rejects.toThrow('empty transcript')
})

test('our own timeout is named as ours', async () => {
  globalThis.fetch = ((_: string, init: RequestInit) =>
    new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))) as unknown as typeof fetch
  await expect(openAiTranscriber({ ...opts, timeoutMs: 20 })(new Uint8Array([1]), 'a.ogg')).rejects.toThrow('no answer within 0.02s')
})

test('telegram .oga becomes .ogg, other names are kept', () => {
  expect(sttFilename('voice/file_12.oga')).toBe('file_12.ogg')
  expect(sttFilename('music/song.mp3')).toBe('song.mp3')
})
