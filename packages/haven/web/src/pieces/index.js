// src/pieces/index.js — what a piece is: a small drawing and its paint, the
// same shape, placed on a stage by `<Piece of={…} x y>` (`FJS-D997`).
//
// Only its glyphs are cells, so a space inside a piece claims nothing and a
// frame is only its border. Leading and trailing newlines are dropped, so a
// piece is written as a block under its name. A `floor` piece is walked on —
// the tavern's rug — where every other piece is a wall. A piece may name its
// `spots`: cells of its own that an actor reads by name instead of by an
// offset (`IDEAS/haven.md` 12.3) -- `{ keeper: { dx, dy } }` is where the man
// at a desk stands, and a placement's `mark.spot('keeper')` is that cell on the
// stage. A spot may have a kind. A `seat` is walked onto, a stool at a table,
// and names the cell a figure stands on stepping back off (`stand`); its
// `mate` names the seat across, which is what lets a stage say who sits across
// from whom, and a `solo` seat has none, a stool at the bar, and is only sat on.
// A `burn` is drawn as its palette says only while a seat of the piece is
// taken, and as a white dot otherwise. A piece may carry the `palette` entries
// its paint letters need (the lamp's bulb and its `light`); the stage uses them
// for any letter the scene's own palette leaves out, and the scene's entry wins
// where it names one (`IDEAS/haven.md` 12.8). A floor
// piece may `crumbles` into the cell `{ ch, key }`: each of its cells that a
// figure steps onto and off again wobbles, falls and is that cell from then
// on, which is a wall (`stage.js`, the pier). A piece may name its
// `seasons`, a piece per season it looks otherwise in, each standing on the
// same wall cells: the stage draws the one for its season (`stage.toSeason`),
// and the piece itself in a season it leaves out. A floor piece may be a
// `pickup`, `{ item, n }`: stepping onto it hands the member `n` of an item
// (`api/src/inventory.ts`), and it is gone from the cell for a while after
// (`IDEAS/haven.md` 9.9). The server resolves it from `world.json`.
import { ITEMS, isItem } from '../../../api/src/inventory.ts'
import { SEASONS } from '../sky.js'

/**
 * @param {string} name
 * @param {string} art    the glyphs
 * @param {string} paint  one palette letter per glyph, a space where the art has one
 * @typedef {{ dx: number, dy: number, kind?: 'seat' | 'burn', stand?: { dx: number, dy: number }, mate?: string, solo?: boolean }} Spot
 * @param {{ pickup?: { item: string, n: number } | null, floor?: boolean, overhead?: number, crumbles?: { ch: string, key: string }, spots?: Record<string, Spot>, palette?: Record<string, object>, seasons?: Record<string, object> }} [options]
 *   `overhead`: how many rows from the top are in the air
 */
export function piece(name, art, paint, { floor = false, overhead = 0, spots = {}, crumbles = null, palette = {}, seasons = null, pickup = null } = {}) {
  checkSpots(name, spots)
  checkPickup(name, pickup, floor)
  checkPalette(name, palette)
  const named = Object.entries(spots).map(([spot, s]) => ({ name: spot, ...s }))
  const lines = (s) => s.replace(/^\n/, '').replace(/\n$/, '').split('\n')
  const a = lines(art), p = lines(paint)
  const cells = []
  a.forEach((row, dy) => [...row].forEach((ch, dx) => {
    if (ch !== ' ') cells.push({ dx, dy, ch, key: p[dy]?.[dx] ?? ' ', overhead: dy < overhead, seat: named.some((s) => s.kind === 'seat' && s.dx === dx && s.dy === dy), burns: named.some((s) => s.kind === 'burn' && s.dx === dx && s.dy === dy) })
  }))
  const shape = { name, art: a.join('\n'), paint: p.join('\n'), cells, floor, spots, crumbles, palette, seasons, pickup }
  checkSeasons(shape)
  return shape
}

// A season that claimed another wall would let a figure through a trunk in
// one season and not the next, and the server's `world.json` knows one.
function checkSeasons(shape) {
  const walls = (p) => p.cells.filter((c) => !c.overhead).map((c) => `${c.dx},${c.dy}`).sort().join(' ')
  for (const [season, other] of Object.entries(shape.seasons ?? {})) {
    if (!SEASONS.includes(season)) throw new Error(`${shape.name} has a season ${season}; the seasons are ${SEASONS.join(', ')}`)
    if (walls(other) !== walls(shape)) throw new Error(`${shape.name} in ${season} stands on other walls than it does the rest of the year`)
  }
}

// A pickup is walked onto, so it is a floor piece, and the server must know its item.
function checkPickup(piece, pickup, floor) {
  if (!pickup) return
  if (!floor) throw new Error(`${piece} is a pickup and a pickup is walked onto, so it is a floor piece`)
  if (!isItem(pickup.item)) throw new Error(`${piece} picks up ${pickup.item}, and the items are ${Object.keys(ITEMS).join(', ')}`)
  if (!Number.isInteger(pickup.n) || pickup.n < 1) throw new Error(`${piece} hands ${pickup.n} of ${pickup.item}, and a pickup hands a whole number`)
}

function checkPalette(piece, palette) {
  for (const [letter, entry] of Object.entries(palette)) {
    if ([...letter].length !== 1 || letter === ' ') throw new Error(`palette ${piece}.${letter} is not one paint letter`)
    if (!entry || typeof entry !== 'object') throw new Error(`palette ${piece}.${letter} needs an entry`)
  }
}

function checkSpots(piece, spots) {
  for (const [name, s] of Object.entries(spots)) {
    const label = `${piece}.${name}`
    if (!Number.isInteger(s?.dx) || !Number.isInteger(s?.dy)) throw new Error(`spot ${label} needs whole-number dx and dy`)
    if (s.kind !== undefined && s.kind !== 'seat' && s.kind !== 'burn') throw new Error(`spot ${label} is a ${s.kind}, and a spot is a seat or a burn`)
    if (s.kind === 'seat' && !s.stand) throw new Error(`seat ${label} needs the cell to stand up to`)
    if (s.kind === 'seat' && !s.solo && !s.mate) throw new Error(`seat ${label} needs a mate, or to be solo`)
    if (s.mate && spots[s.mate]?.kind !== 'seat') throw new Error(`seat ${label} names ${s.mate} as its mate, and that is no seat of the piece`)
  }
}

/** A piece's spots, in the order it names them: `{ name, dx, dy, … }`, only those of `kind` when one is given. */
export function spotsOf(piece, kind) {
  return Object.entries(piece.spots ?? {}).filter(([, s]) => kind === undefined || s.kind === kind).map(([name, s]) => ({ name, ...s }))
}
