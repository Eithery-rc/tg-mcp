// Preloaded into a node that stands in for herdr: answers `api snapshot` with FAKE_SNAPSHOT,
// `pane report-agent-session` with nothing, and writes every call to FAKE_HERDR_LOG.
import { appendFileSync } from 'node:fs'
import { basename } from 'node:path'

if (!/\.m?js$/.test(process.argv[1] ?? '')) {
  const args = [basename(process.argv[1] ?? ''), ...process.argv.slice(2)]
  if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify(args)}\n`)
  if (args[0] === 'api' && args[1] === 'snapshot') {
    console.log(JSON.stringify({ result: { snapshot: JSON.parse(process.env.FAKE_SNAPSHOT) } }))
    process.exit(0)
  }
  process.exit(args[0] === 'pane' && args[1] === 'report-agent-session' ? 0 : 1)
}
