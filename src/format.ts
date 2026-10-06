// Agents write ordinary Markdown; Telegram wants its own HTML subset.

const LIMIT = 3800 // Telegram caps messages at 4096 chars; leave room for tags added by conversion

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/** Inline formatting for a line that is not inside a code block. */
function inline(line: string): string {
  // Pull inline code out first so nothing inside it gets formatted.
  const codes: string[] = []
  let s = line.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(`<code>${escapeHtml(c)}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  const links: string[] = []
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, text, url) => {
    links.push(`<a href="${escapeAttr(url)}">${escapeHtml(text)}</a>`)
    return `\u0001${links.length - 1}\u0001`
  })
  s = escapeHtml(s)
  s = s.replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/g, '<b>$1</b>')
  s = s.replace(/__(?=\S)(.+?)(?<=\S)__/g, '<b>$1</b>')
  s = s.replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '<s>$1</s>')
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1<i>$2</i>')
  s = s.replace(/(^|[^\w])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<i>$2</i>')
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => links[Number(i)]!)
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]!)
  return s
}

export function markdownToHtml(md: string): string {
  const out: string[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let fence: { lang: string; body: string[] } | null = null
  let quote: string[] = []

  const flushQuote = () => {
    if (quote.length) out.push(`<blockquote>${quote.join('\n')}</blockquote>`)
    quote = []
  }

  for (const line of lines) {
    if (fence) {
      if (/^\s*```\s*$/.test(line)) {
        const cls = fence.lang ? ` class="language-${escapeAttr(fence.lang)}"` : ''
        out.push(`<pre><code${cls}>${escapeHtml(fence.body.join('\n'))}</code></pre>`)
        fence = null
      } else fence.body.push(line)
      continue
    }
    const open = /^\s*```\s*([\w+-]*)\s*$/.exec(line)
    if (open) {
      flushQuote()
      fence = { lang: open[1] ?? '', body: [] }
      continue
    }
    const q = /^\s*>\s?(.*)$/.exec(line)
    if (q) {
      quote.push(inline(q[1]!))
      continue
    }
    flushQuote()
    const h = /^\s*#{1,6}\s+(.*)$/.exec(line)
    if (h) {
      out.push(`<b>${inline(h[1]!)}</b>`)
      continue
    }
    const li = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (li) {
      out.push(`${li[1]}• ${inline(li[2]!)}`)
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('──────────')
      continue
    }
    out.push(inline(line))
  }
  flushQuote()
  if (fence) out.push(`<pre><code>${escapeHtml(fence.body.join('\n'))}</code></pre>`)
  return out.join('\n')
}

/**
 * Split Markdown into chunks that fit one Telegram message each, cutting on line
 * boundaries and re-opening a code fence if a chunk ends inside one.
 */
export function chunkMarkdown(md: string, limit = LIMIT): string[] {
  if (md.length <= limit) return [md]
  const chunks: string[] = []
  let cur: string[] = []
  let len = 0
  let fenceLang: string | null = null

  const push = () => {
    if (!cur.length) return
    let text = cur.join('\n')
    if (fenceLang !== null) text += '\n```'
    chunks.push(text)
    cur = fenceLang !== null ? ['```' + fenceLang] : []
    len = cur.join('\n').length
  }

  for (let line of md.split('\n')) {
    // A single line longer than the limit gets hard-wrapped.
    while (line.length > limit) {
      push()
      cur.push(line.slice(0, limit))
      len = limit
      line = line.slice(limit)
    }
    if (len + line.length + 1 > limit) push()
    cur.push(line)
    len += line.length + 1
    const f = /^\s*```\s*([\w+-]*)\s*$/.exec(line)
    if (f) fenceLang = fenceLang === null ? (f[1] ?? '') : null
  }
  if (cur.length) chunks.push(cur.join('\n'))
  return chunks
}
