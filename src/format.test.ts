import { expect, test } from 'bun:test'
import { chunkMarkdown, markdownToHtml } from './format'

test('basic inline formatting', () => {
  expect(markdownToHtml('**bold** and *it* and `a<b`')).toBe('<b>bold</b> and <i>it</i> and <code>a&lt;b</code>')
})

test('snake_case and globs are left alone', () => {
  expect(markdownToHtml('run my_long_name and rm *.log *.tmp')).toBe('run my_long_name and rm *.log *.tmp')
})

test('html is escaped outside code', () => {
  expect(markdownToHtml('if a < b && c > d')).toBe('if a &lt; b &amp;&amp; c &gt; d')
})

test('fenced code keeps content verbatim', () => {
  expect(markdownToHtml('```ts\nconst x = a**b < 1\n```')).toBe(
    '<pre><code class="language-ts">const x = a**b &lt; 1</code></pre>',
  )
})

test('links, headings, lists, quotes', () => {
  const md = '# Title\n- item [docs](https://x.dev/a?b=1&c=2)\n> quoted'
  expect(markdownToHtml(md)).toBe(
    '<b>Title</b>\n• item <a href="https://x.dev/a?b=1&amp;c=2">docs</a>\n<blockquote>quoted</blockquote>',
  )
})

test('unclosed fence still renders', () => {
  expect(markdownToHtml('```\nx')).toBe('<pre><code>x</code></pre>')
})

test('short text is one chunk', () => {
  expect(chunkMarkdown('hello')).toEqual(['hello'])
})

test('long text splits on lines and reopens code fences', () => {
  const body = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n')
  const chunks = chunkMarkdown('```py\n' + body + '\n```', 400)
  expect(chunks.length).toBeGreaterThan(3)
  for (const c of chunks) {
    expect(c.length).toBeLessThanOrEqual(420)
    expect(c.startsWith('```')).toBe(true)
    expect(c.trimEnd().endsWith('```')).toBe(true)
  }
})

test('very long single line is hard-wrapped', () => {
  const chunks = chunkMarkdown('y'.repeat(1000), 300)
  expect(chunks.every(c => c.length <= 300)).toBe(true)
  expect(chunks.join('')).toBe('y'.repeat(1000))
})
