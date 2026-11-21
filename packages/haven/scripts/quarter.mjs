/**
 * scripts/quarter.mjs — `bun run quarter`: read each quarter package's
 * `PROJECT_STATE.md` and write `web/src/lib/hash/quarter.data.json`, the words
 * on each building's wall. A snapshot taken at build, as the town hall's is:
 * a page in a browser reads no file on its machine, and `quarter.frame.txt`
 * pins the scene, so a changed state file moves a wall only when this is run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILDINGS, wallsOf } from '../web/src/lib/hash/quarter.js'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'web', 'src', 'lib', 'hash', 'quarter.data.json')
const states = Object.fromEntries(BUILDINGS.map(({ pkg }) => [pkg, readFileSync(join(here, '..', '..', pkg, 'PROJECT_STATE.md'), 'utf8')]))
const walls = wallsOf(states)
writeFileSync(out, JSON.stringify(walls, null, 2) + '\n')
console.log(`wrote ${out}: ${walls.map((w) => `${w.pkg} ${w.lines.length} rows`).join(', ')}`)
