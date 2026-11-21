// src/quarter.js — the framework quarter's buildings and what their walls say
// (`IDEAS/haven.md` 9.2). Pure: `scripts/quarter.mjs` reads each package's
// `PROJECT_STATE.md` and writes `quarter.data.json`, which the scene draws and
// `Wall.mesa` reads aloud, so a page in a browser, which reads no file on its
// machine, and a stranger's server see the same wall.

/** The quarter's buildings: the package, the name over its door, and the pitch of its roof. */
export const BUILDINGS = [
  { pkg: 'litestone', sign: 'LITESTONE QUARRY',    roof: 'a' },
  { pkg: 'junction',  sign: 'JUNCTION CROSSROADS', roof: 'b' },
  { pkg: 'mesa',      sign: 'MESA WORKSHOP',       roof: 'c' },
  { pkg: 'caravan',   sign: 'CARAVAN STABLES',     roof: 'd' },
]

/** The columns a wall's text is wrapped to, and the most rows it takes. */
export const WALL_COLS = 78
export const WALL_ROWS = 4

const plain = (s) => s.replace(/\*\*|__|~~|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim()

// A paragraph that is bookkeeping about the file rather than about the package.
const NOT_PROSE = /^(#|\||-|\d+\.|>|```|_?\*{0,2}(Header|Last verified|Verified|Tests?)\b)/i

/**
 * The words a package's `PROJECT_STATE.md` leads with: its `**Status:**` line
 * where it has one, else the first paragraph that is prose. The files share no
 * headline convention, so this is a reading of each, not a field.
 * @param {string} markdown
 * @returns {string}
 */
export function headlineOf(markdown) {
  const text = markdown.replace(/\r/g, '')
  const status = text.split('\n').find((l) => /^\*\*Status:?\*\*:?/i.test(l))
  if (status) return plain(status.replace(/^\*\*Status:?\*\*:?/i, ''))
  for (const p of text.split(/\n\s*\n/)) {
    const t = p.trim()
    if (t.length >= 40 && !NOT_PROSE.test(t)) return plain(t)
  }
  return ''
}

/**
 * `words` broken at spaces into rows of at most `cols`, at most `rows` of them,
 * the last cut with an ellipsis when there was more.
 * @param {string} words
 * @returns {string[]}
 */
export function wrapWall(words, cols = WALL_COLS, rows = WALL_ROWS) {
  const out = []
  let row = ''
  for (const w of words.split(' ').filter(Boolean)) {
    const next = row ? `${row} ${w}` : w
    if (next.length <= cols) { row = next; continue }
    if (row) out.push(row)
    row = w.slice(0, cols)
  }
  if (row) out.push(row)
  if (out.length <= rows) return out
  const kept = out.slice(0, rows)
  kept[rows - 1] = `${kept[rows - 1].slice(0, cols - 1).replace(/\s+\S*$/, '')}…`
  return kept
}

/**
 * Each building's wall, from the files' text by package.
 * @param {Record<string, string>} states  `PROJECT_STATE.md` by package name
 * @returns {{ pkg: string, sign: string, lines: string[] }[]}
 */
export const wallsOf = (states) => BUILDINGS.map(({ pkg, sign }) => ({
  pkg,
  sign,
  lines: wrapWall(headlineOf(states[pkg] ?? '')),
}))
