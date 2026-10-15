// src/townhall.js — the town hall's delegates: every open row of
// `IDEAS/overview.md`, by wave, each one a person who stands for it
// (`IDEAS/haven.md` Phase 15). Pure: `scripts/townhall.mjs` reads the file and
// writes `townhall.data.json`, which the hall's scene draws and the votes
// service checks an idea against, so a stranger's server and a checkout agree
// on who is in the hall.
//
// A row whose item or status is struck through (`~~shipped~~`) has left the
// hall. The id is the row's own number (`4.21a`), since a vote is kept against
// it and the row keeps its number while its words change.

/** The people of the town, one per delegate, picked by the idea's id so a delegate keeps a name across a recount. */
export const NAMES = [
  'Ada', 'Bram', 'Cora', 'Dov', 'Edda', 'Finn', 'Greta', 'Hal', 'Ines', 'Jory',
  'Kit', 'Lem', 'Mira', 'Ned', 'Oona', 'Pell', 'Quill', 'Rosa', 'Silas', 'Tam',
  'Uma', 'Vern', 'Wren', 'Xan', 'Yara', 'Zeb', 'Alba', 'Bo', 'Cass', 'Dell',
  'Elm', 'Fay', 'Gil', 'Hester', 'Ivo', 'Juno', 'Kai', 'Lark', 'Moss', 'Nell',
  'Otto', 'Pia', 'Rook', 'Sage', 'Tove', 'Ulf', 'Vida', 'Wade', 'Yves', 'Zola',
]

/** A delegate's name: the same id is always the same person. */
export function nameOf(id) {
  let h = 2166136261
  for (const ch of id) h = Math.imul(h ^ ch.charCodeAt(0), 16777619)
  return NAMES[(h >>> 0) % NAMES.length]
}

const ROW = /^\| (\d+\.\d+[a-z]?) \| (.*) \|$/
const WAVE = /^## Wave (\d+) — (.+)$/

// What a status cell says once its argument is cut off; a row these name has left the hall.
const SETTLED = new Set(['shipped', 'built', 'fixed', 'closed'])

const plain = (s) => s.replace(/\*\*|~~|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim()

/**
 * The open rows of an overview, by wave.
 * @param {string} text  the markdown of `IDEAS/overview.md`
 * @returns {{ n: number, name: string, ideas: { id: string, title: string, effort: string, payoff: number, edge: string, realms: string, status: string, paper: string }[] }[]}
 */
export function wavesOf(text) {
  const waves = []
  let wave = null
  for (const line of text.split('\n')) {
    const head = WAVE.exec(line)
    if (head) { waves.push(wave = { n: Number(head[1]), name: head[2].trim(), ideas: [] }); continue }
    if (line.startsWith('## ')) { wave = null; continue }
    const row = wave && ROW.exec(line)
    if (!row) continue
    const cells = row[2].split(' | ')
    // Item, Effort, Payoff, Edge, Realms, Status, Source: an item may hold a
    // ` | ` of its own, so the six after it are read from the right.
    if (cells.length < 7) continue
    const [effort, payoff, edge, realms, said, source] = cells.slice(-6)
    const item = cells.slice(0, -6).join(' | ')
    const status = plain(said).split(/ — |[;,(·]/)[0].trim()
    if (item.startsWith('~~') || said.includes('~~') || SETTLED.has(status.split(' ')[0])) continue
    wave.ideas.push({
      id:     row[1],
      title:  plain(/\*\*(.+?)\*\*/.exec(item)?.[1] ?? item.split(' — ')[0]).replace(/[.:]$/, ''),
      effort: plain(effort),
      payoff: (payoff.match(/●/g) ?? []).length,
      edge:   plain(edge),
      realms: plain(realms),
      status,
      paper:  /`([\w./-]+\.md)`/.exec(source)?.[1] ?? '',
    })
  }
  return waves.filter((w) => w.ideas.length)
}

/** Every idea's id across the waves — what a vote may name. */
export const idsOf = (waves) => new Set(waves.flatMap((w) => w.ideas.map((i) => i.id)))
