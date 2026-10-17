// src/ledger.js — `#ledger` in the terminal: the open issues in a checkout's
// `ISSUES.md` per bench and severity, counted and written to
// `web/src/lib/hash/ledger.data.js`. `bun run ledger` (scripts/ledger.mjs) and the
// workshop's `/ledger` (`components/Ledger.mesa`) both count here, so the rule
// for which bench a row belongs to has one owner. A browser takes
// `ledger.browser.js`.
//
// An issue belongs to the FIRST package its Pkg cell names. A name that is no
// bench (`repo`, `docs`, `scripts`, `IDEAS`) is the rest of the tree, the
// `frontierjs` bench; `fli` is `cli`.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ALIAS = { fli: 'cli' }

/** Where the file the workshop imports sits, under a workspace root. */
export const dataFile = (root) => join(root, 'packages', 'haven', 'web', 'src', 'lib', 'hash', 'ledger.data.js')

/**
 * The workspace root this Haven sits in, or null when it has no `ISSUES.md` —
 * an installed Haven (`~/.fli/haven/<version>/`) counts nothing. `HAVEN_LEDGER_ROOT`
 * names another root, which is how a drive recounts without touching this tree.
 */
export function checkout({ from = HERE, env = process.env.HAVEN_LEDGER_ROOT } = {}) {
  const root = env || join(from, '..', '..', '..', '..', '..', '..')
  return existsSync(join(root, 'ISSUES.md')) && existsSync(join(root, 'packages')) ? root : null
}

/** Every bench: each package with a `package.json`, `example` and `frontierjs`, by name. */
export function benchesOf(root) {
  const packages = join(root, 'packages')
  return [...readdirSync(packages, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(packages, d.name, 'package.json')))
    .map((d) => d.name), 'example', 'frontierjs'].sort()
}

/** @returns {Record<string, { S1: number, S2: number, S3: number, S4: number }>} */
export function count(root) {
  const benches = benchesOf(root)
  const counts = Object.fromEntries(benches.map((b) => [b, { S1: 0, S2: 0, S3: 0, S4: 0 }]))
  let section = null
  for (const line of readFileSync(join(root, 'ISSUES.md'), 'utf8').split('\n')) {
    const head = /^## (S[1-4]) /.exec(line)
    if (head) section = head[1]
    else if (line.startsWith('## ')) section = null
    else if (section && line.startsWith('| <a id="fjs-')) {
      const first = /^[`*\s]*([A-Za-z][\w-]*)/.exec(line.split(' | ')[1] ?? '')?.[1] ?? ''
      const name = ALIAS[first] ?? first
      counts[benches.includes(name) ? name : 'frontierjs'][section]++
    }
  }
  return counts
}

/** Write `counts` as `ledger.data.js` at `out`. */
export function write(counts, out) {
  const body = Object.keys(counts).map((b) => {
    const c = counts[b]
    return `  ${/^[a-z]\w*$/.test(b) ? b : `'${b}'`}: { S1: ${c.S1}, S2: ${c.S2}, S3: ${c.S3}, S4: ${c.S4} },`
  }).join('\n')
  writeFileSync(out, `// web/src/lib/hash/ledger.data.js — open issues per package and severity in ISSUES.md.
// Written by \`bun run ledger\` (scripts/ledger.mjs); never by hand.
export const LEDGER = {
${body}
}
`)
}

/** Count `root`'s register and write it where the workshop imports it; the counts, for a room that redraws without a restart. */
export function recount({ root, out = dataFile(root) } = {}) {
  const counts = count(root)
  write(counts, out)
  return counts
}
