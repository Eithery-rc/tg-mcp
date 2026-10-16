// Preloaded into a node that stands in for herdr: answers `api snapshot` with FAKE_SNAPSHOT.
import { basename } from 'node:path'

if (!/\.m?js$/.test(process.argv[1] ?? '')) {
  if (basename(process.argv[1] ?? '') !== 'api' || process.argv[2] !== 'snapshot') process.exit(1)
  console.log(JSON.stringify({ result: { snapshot: JSON.parse(process.env.FAKE_SNAPSHOT) } }))
  process.exit(0)
}
