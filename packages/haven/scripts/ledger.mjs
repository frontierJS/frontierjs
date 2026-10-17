/**
 * scripts/ledger.mjs — `bun run ledger`: count the open issues in the repo's
 * `ISSUES.md` per package and severity, and write `web/src/lib/hash/ledger.data.js`,
 * the numbers the workshop piles on each bench. A snapshot on purpose: a
 * page in a browser reads no file on its machine, and a scene's picture is
 * pinned by `workshop.frame.txt`, so the register moves the picture only when
 * this is run and `bun run frames` after it. The count is `web/src/lib/hash/ledger.js`,
 * which the workshop's `/ledger` runs too.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dataFile, recount } from '../web/src/lib/hash/ledger.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
recount({ root })
console.log(`wrote ${dataFile(root)}`)
