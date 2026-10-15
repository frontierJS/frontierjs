// src/pieces/home.js — the lane's cottages and what stands inside one. A home
// is a member's own room (`scenes/Lane.mesa`, `Jordan.mesa` and its two
// neighbors), and its board is drawn over these pieces by
// `components/HomeBoard.mesa`, which finds each by its name.
//
// A piece the board writes on carries `inner`, the cells inside its frame the
// writing goes in, `{ dx, dy, w, h }` from the piece's corner. Those cells are
// spaces in the art, so a visitor, whose screen has no board, sees an empty
// frame — a cork board with nothing pinned, a dark screen.
import { piece } from './index.js'

// ─── the lane ────────────────────────────────────────────────────────────────

/** The width of every cottage, eave to eave. */
export const COTTAGE_WIDTH = 26

/** The cell of a cottage's door, from its corner: where the lane places its `<Door>`. */
export const COTTAGE_DOOR = { dx: 12, dy: 9 }

/**
 * A cottage with `name` on the sign over its windows. The roof is painted
 * `roof` (a palette letter), so three cottages in one row tell apart at a
 * glance; the sign is `s`, the windows `y` — a light, as the square's are.
 */
export function cottage(name, roof = 'r') {
  const inner = COTTAGE_WIDTH - 4
  const sign = `[ ${name.toUpperCase()} ]`
  if (sign.length > inner - 2) throw new Error(`cottage: "${name}" is longer than a sign`)
  const left = Math.floor((inner - sign.length) / 2)
  const body = (s) => ` |${s.padEnd(inner)}|`
  const art = [
    `   ~'`,
    `   ||`,
    `  _||${'_'.repeat(COTTAGE_WIDTH - 7)}`,
    ` //${'\\/'.repeat((COTTAGE_WIDTH - 6) / 2)}\\\\`,
    `/${'_'.repeat(COTTAGE_WIDTH - 2)}\\`,
    body(`${' '.repeat(left)}${sign}`),
    body('  []     []      []'),
    body(''),
    body('  []     .-.     []'),
    ` |${'_'.repeat(9)}|n|${'_'.repeat(inner - 12)}|`,
  ]
  const R = roof.toUpperCase()
  const paint = art.map((row, dy) => [...row].map((ch, dx) => {
    if (ch === ' ') return ' '
    if (dy === 0) return 'k'
    if (dy === 1) return 'c'
    if (dy === 2) return dx === 3 || dx === 4 ? 'c' : roof
    if (dy === 3) return dx < 3 || dx >= COTTAGE_WIDTH - 3 ? roof : R
    if (dy === 4) return roof
    if (ch === '|' && (dx === 1 || dx === COTTAGE_WIDTH - 2)) return 'w'
    if (dy === 5) return ch === '[' || ch === ']' ? 'S' : 's'
    if (ch === '[' || ch === ']') return 'y'
    if (dx >= COTTAGE_DOOR.dx - 1 && dx <= COTTAGE_DOOR.dx + 1 && dy >= 8) return 'd'
    return 'w'
  }).join(''))
  return { ...piece('cottage', art.join('\n'), paint.join('\n')), home: name.toLowerCase() }
}

/** A mailbox on its post. `HomeBoard.mesa` raises a flag beside the one nearest its home's door. */
export const mailbox = piece('mailbox', String.raw`
[=]
 |
`, String.raw`
qeq
 u
`)

export const pond = piece('pond', String.raw`
  .--~~~~--.
 (~~~~~~~~~~)
  '--------'
`, String.raw`
  qqbbbbbbqq
 qbbbbbbbbbbq
  qqqqqqqqqq
`)

// ─── the board's furniture ───────────────────────────────────────────────────

/** The pinned projects, two to a row. */
export const corkboard = { ...piece('corkboard', [
  `.${'-'.repeat(15)}[ pinned ]${'-'.repeat(17)}.`,
  ...Array(8).fill(`|${' '.repeat(42)}|`),
  `'${'-'.repeat(42)}'`,
].join('\n'), [
  `w${'w'.repeat(15)}SssssssssS${'w'.repeat(17)}w`,
  ...Array(8).fill(`w${' '.repeat(42)}w`),
  `w${'w'.repeat(42)}w`,
].join('\n')), inner: { dx: 2, dy: 1, w: 40, h: 8 } }

/** The screen over the desk: the inbox, read from the chair. */
export const screen = { ...piece('screen', [
  `.${'-'.repeat(16)}[ inbox ]${'-'.repeat(17)}.`,
  ...Array(7).fill(`|${' '.repeat(42)}|`),
  `'${'-'.repeat(42)}'`,
].join('\n'), [
  `l${'l'.repeat(16)}SsssssssS${'l'.repeat(17)}l`,
  ...Array(7).fill(`l${' '.repeat(42)}l`),
  `l${'l'.repeat(42)}l`,
].join('\n')), inner: { dx: 2, dy: 1, w: 40, h: 7 } }

/** The desk under the screen, its chair a solo seat — sat on, and paired with nobody. */
export const desk = piece('desk', String.raw`
 ____________________________
|____________________________|
 ||                        ||
              o
`, String.raw`
 wwwwwwwwwwwwwwwwwwwwwwwwwwww
wWWWWWWWWWWWWWWWWWWWWWWWWWWWWw
 ww                        ww
              u
`, { spots: { chair: { kind: 'seat', dx: 14, dy: 3, stand: { dx: 14, dy: 4 }, solo: true } } })

/** What is due, by the month. */
export const calendar = { ...piece('calendar', String.raw`
.----------------.
|o  o  o  o  o  o|
|                |
|                |
|                |
|                |
'----------------'
`, String.raw`
qqqqqqqqqqqqqqqqqq
qe  e  e  e  e  eq
q                q
q                q
q                q
q                q
qqqqqqqqqqqqqqqqqq
`), inner: { dx: 2, dy: 2, w: 14, h: 4 } }

/** The bell by the door, rung by a ping. */
export const bell = piece('bell', String.raw`
 _|_
/   \
\___/
  o
`, String.raw`
 BBB
BBBBB
BBBBB
  u
`)

/** The mat inside the door, where the post lands. */
export const doormat = { ...piece('doormat', '[:::::::]', 'mMMMMMMMm', { floor: true }), inner: { dx: 1, dy: 0, w: 7, h: 1 } }

// ─── what makes one home not another ─────────────────────────────────────────

export const bed = piece('bed', String.raw`
.--.______________
|()|~~~~~~~~~~~~~|
|  |~~~~~~~~~~~~~|
'--'-------------'
`, String.raw`
wwwwwwwwwwwwwwwwww
wqqwQQQQQQQQQQQQQw
w  wQQQQQQQQQQQQQw
wwwwwwwwwwwwwwwwww
`)

export const bookshelf = piece('bookshelf', String.raw`
.--------------.
|][]|[][]|][|[]|
|[]|][]|[][]|][|
'--------------'
`, String.raw`
wwwwwwwwwwwwwwww
wcpeewceepweecpw
wepwcepweecpwcpw
wwwwwwwwwwwwwwww
`)

/** A server rack, its lights blinking `L`. */
export const rack = piece('rack', String.raw`
.-----.
|===o |
|===o |
|===o |
'-----'
`, String.raw`
lllllll
lqqqL l
lqqqL l
lqqqL l
lllllll
`)

/** An easel with a chart that climbs. */
export const easel = piece('easel', String.raw`
.--------.
|     _/ |
|  _/'   |
|_/      |
'--------'
 /  ||  \
`, String.raw`
wwwwwwwwww
w     ee w
w  eee   w
wee      w
wwwwwwwwww
 u  uu  u
`)

export const armchair = piece('armchair', String.raw`
 .----.
(|    |)
(|____|)
 '    '
`, String.raw`
 MMMMMM
MMMMMMMM
MMMMMMMM
 u    u
`)

/** A record player, its record turning `V`. */
export const gramophone = piece('gramophone', String.raw`
 __
\  )
 ||
[@@]
`, String.raw`
 ee
eeee
 uu
wVVw
`)

export const plant = piece('plant', String.raw`
\|/
(_)
`, String.raw`
TTT
uuu
`)

/** A stove, its fire a light. */
export const stove = piece('stove', String.raw`
 _||_
|^^^^|
|____|
`, String.raw`
 qqqq
qhhhhq
qqqqqq
`)

export const rug = piece('rug', String.raw`
;;;;;;;;;;;;;;;;;;;;;;;;
;::::::::::::::::::::::;
;::::::::::::::::::::::;
;;;;;;;;;;;;;;;;;;;;;;;;
`, String.raw`
mmmmmmmmmmmmmmmmmmmmmmmm
mMMMMMMMMMMMMMMMMMMMMMMm
mMMMMMMMMMMMMMMMMMMMMMMm
mmmmmmmmmmmmmmmmmmmmmmmm
`, { floor: true })
