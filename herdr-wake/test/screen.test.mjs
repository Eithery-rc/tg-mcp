import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inputDraft, isChannelsWarning, isExitTasksDialog, isTrustDialog, nonDimText } from '../src/screen.mjs'

const E = '\x1b'
const rule = `${E}[0m${E}[38;2;136;136;136m${'─'.repeat(60)} Billing-master ─${E}[0m`
const bottom = `${E}[0m${E}[38;2;136;136;136m${'─'.repeat(70)}${E}[0m`
const footer = `  ${E}[0m${E}[38;2;255;107;128m⏵⏵ bypass permissions on${E}[0m`
const screen = input => ['● earlier answer', '', rule, input, bottom, footer].join('\n')

test('a dim suggestion is not a draft (captured from a live pane)', () => {
  assert.equal(inputDraft(screen(`❯ ${E}[0m${E}[2mзаводи сансиповские 3 часа${E}[0m`)), '')
})

test('an empty box is empty', () => {
  assert.equal(inputDraft(screen('❯ ')), '')
})

test('typed text is a draft', () => {
  assert.equal(inputDraft(screen(`❯ ${E}[0mпроверь счёт`)), 'проверь счёт')
})

test('a multi-line draft is read up to the closing rule', () => {
  const s = ['x', rule, '❯ first line', '  second line', bottom, footer].join('\n')
  assert.equal(inputDraft(s), 'first line\n  second line')
})

test('no input box on screen (a dialog) gives null', () => {
  assert.equal(inputDraft('Do you want to proceed?\n❯ 1. Yes\n  2. No'), null)
})

test('a previous prompt in the transcript is not the input box', () => {
  const s = ['❯ old prompt', '● answer', rule, '❯ ', bottom].join('\n')
  assert.equal(inputDraft(s), '')
})

test('colour arguments are not mistaken for dim', () => {
  // 38;2;2;... has a 2 inside the colour, which must not switch dim on
  assert.equal(nonDimText(`${E}[38;2;2;2;2mvisible${E}[0m`), 'visible')
})

test('the development channels warning is recognised', () => {
  const s = `  WARNING: Loading development channels\n\n  Channels: server:telegram\n\n  ❯ 1. I am using this for local development\n    2. Exit`
  assert.equal(isChannelsWarning(s), true)
  assert.equal(isChannelsWarning('Do you trust the files in this folder?\n❯ 1. Yes, proceed'), false)
})

test('the folder trust question is recognised and is not the channels warning', () => {
  const s = ' Accessing workspace:\n\n C:/Work/Personal/herdr-wake\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel'
  assert.equal(isTrustDialog(s), true)
  assert.equal(isChannelsWarning(s), false)
})

test('the exit dialog for background tasks is recognised', () => {
  const s = '   The following will stop when you exit:\n\n   shell · node watch-wait\n\n   ❯ 1. Exit and stop tasks\n     2. Move to background and exit\n     3. Stay'
  assert.equal(isExitTasksDialog(s), true)
  assert.equal(isExitTasksDialog('Resume this session with:'), false)
})
