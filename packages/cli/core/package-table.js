// ─── package-table.js — the root CLAUDE.md package table, one reader ─────────
//
// The table sits in an HTML comment in the root `CLAUDE.md`: a block comment
// costs the reader no context, and it is parsed rather than restated. Two
// callers need it -- `repo-map.js` for each package's realm, state and ring, and
// the `package-row` check for a member the table forgot -- and a leaf is how
// they share one parse without `checks.js` and `repo-map.js` importing each
// other. No separator row (a comment holds no double dash).

import { join } from 'node:path'
import { read } from './fs.js'
import { splitRow, plain } from './registers.js'

/**
 * The rows under the `| Package | Realm ...` header, as `{ name, cells }`.
 * `name` is the first cell with its parenthetical dropped (`cli (\`fli\`)` is
 * the folder `cli`); `cells` are the raw cells. `[]` where the file or the table
 * is absent, which is correct for any project that is not this one.
 */
export function packageTable(root) {
  const src = read(join(root, 'CLAUDE.md'))
  if (!src) return []

  const rows = []
  let inTable = false

  for (const line of src.split('\n')) {
    if (/^\|\s*Package\s*\|\s*Realm/i.test(line)) { inTable = true; continue }
    if (inTable && !line.startsWith('|')) { inTable = false; continue }
    if (!inTable || /^\|\s*-+/.test(line)) continue

    const cells = splitRow(line)
    if (cells.length < 4) continue

    const name = plain(cells[0]).replace(/\s*\(.*\)$/, '').trim()
    if (name) rows.push({ name, cells })
  }

  return rows
}
