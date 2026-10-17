/**
 * scripts/townhall.mjs — `bun run townhall`: read the repo's
 * `IDEAS/overview.md` and write `web/src/lib/hash/townhall.data.json`, the open rows by
 * wave that stand in the town hall as delegates. A snapshot, as the ledger is:
 * a page in a browser reads no file on its machine, the votes service checks
 * an idea against the same file, and `townhall.frame.txt` pins the hall, so a
 * changed overview moves the hall only when this and `bun run frames` are run.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wavesOf } from '../web/src/lib/hash/townhall.js'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..', 'web', 'src', 'lib', 'hash', 'townhall.data.json')
const waves = wavesOf(readFileSync(join(here, '..', '..', '..', 'IDEAS', 'overview.md'), 'utf8'))
writeFileSync(out, JSON.stringify(waves, null, 2) + '\n')
console.log(`wrote ${out}: ${waves.reduce((n, w) => n + w.ideas.length, 0)} delegates in ${waves.length} waves`)
