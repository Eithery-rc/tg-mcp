// Reads Claude Code's input box from an ANSI screen capture (herdr agent read --ansi).
// The box is the "❯" line right under a horizontal rule, up to the next rule. Claude draws
// its placeholder and prompt suggestions dim (SGR 2), so only non-dim text is a draft.

const ESCAPES = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g
const RULE = /^\s*─{8,}/

export function stripAnsi(s) {
  return s.replace(ESCAPES, '')
}

/** The text of a line without escapes and without the parts drawn dim. */
export function nonDimText(line) {
  let dim = false
  let out = ''
  let last = 0
  for (const m of line.matchAll(ESCAPES)) {
    if (!dim) out += line.slice(last, m.index)
    last = m.index + m[0].length
    if (m[2] !== 'm') continue
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number)
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]
      if (c === 38 || c === 48 || c === 58) {
        i += codes[i + 1] === 2 ? 4 : 2 // skip the colour arguments
      } else if (c === 0 || c === 22) {
        dim = false
      } else if (c === 2) {
        dim = true
      }
    }
  }
  if (!dim) out += line.slice(last)
  return out
}

/**
 * What the user has typed into Claude Code's input box: '' when it is empty or shows only a
 * dim placeholder or suggestion, null when no input box is on screen (a dialog, a picker).
 */
export function inputDraft(ansiScreen) {
  const lines = ansiScreen.split(/\r?\n/)
  for (let i = lines.length - 1; i > 0; i--) {
    if (!stripAnsi(lines[i]).trimStart().startsWith('❯')) continue
    if (!RULE.test(stripAnsi(lines[i - 1]))) continue
    const parts = []
    for (let j = i; j < lines.length && !(j > i && RULE.test(stripAnsi(lines[j]))); j++) parts.push(nonDimText(lines[j]))
    parts[0] = parts[0].replace(/^\s*❯\s?/, '')
    return parts.join('\n').trim()
  }
  return null
}

/** /exit in a session with background shells or scheduled tasks asks whether to stop them. */
export function isExitTasksDialog(plainScreen) {
  return /will stop when you exit/.test(plainScreen)
}

/** Claude asks whether to trust a folder that has no trust recorded (or an explicit "no"). */
export function isTrustDialog(plainScreen) {
  return /Yes, I trust this folder/.test(plainScreen)
}

/** cldt starts Claude with development channels, which asks for a confirmation first. */
export function isChannelsWarning(plainScreen) {
  return /Loading development channels/.test(plainScreen) && /❯\s*1\.\s*I am using this for local development/.test(plainScreen)
}
