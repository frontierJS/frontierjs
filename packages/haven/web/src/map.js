// src/map.js — the map (`IDEAS/haven.md` 6.4): every scene this machine has
// walked into, one glyph to a block of cells, with the figure marked.
//
// A scene is kept as a SNAP when it is walked into — its picture at SCALE,
// its size, its doors and the route it is — by `#seen` (`FJS-D991`), and the
// map is drawn from the snaps plus the live stage of the scene the figure is
// in. Nothing is sent. This file is target-neutral: only the keeping differs
// per target.
//
// Where a scene sits is not stored; it is derived from the doors. A border (a
// door with a `w` or an `h`, `IDEAS/haven.md` 6.2) puts the scene it leads to
// on that side, the two borders' rows or columns agreeing, so the map is the
// world as it was walked. A scene reached only by a single-cell door — a
// house — has no side, and stands in a row under the rest.
import { read, write } from '#seen'

/** Cells to a glyph: a stage cell is twice as tall as it is wide, so five by five is a glyph twice as tall as wide. */
export const SCALE = { x: 5, y: 5 }

const blocks = (n, by) => Math.ceil(n / by)

const isBorder = (d) => d.w > 1 || d.h > 1

/** What a block of the map is made of, by the hue of its ink; the glyph is the kind's, the color is the scene's own. */
export const GLYPH = { water: '≈', tree: '♣', stone: '▒', wood: '░' }
/** A door, and the ink it is drawn in whatever the cell under it was. */
export const DOOR = { ch: '▯', fg: '#fbbf24' }

function kindOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b)
  if (hi === 0 || (hi - lo) / hi < 0.18) return 'stone'
  const d = hi - lo
  const h = 60 * (hi === r ? ((g - b) / d + 6) % 6 : hi === g ? (b - r) / d + 2 : (r - g) / d + 4)
  return h >= 165 && h < 270 ? 'water' : h >= 70 && h < 165 ? 'tree' : 'wood'
}

/**
 * The glyph and ink for the block of stage cells at block `bx, by`: a door if
 * one is in it (a border is no door here: it is an opening in the frame, `painted`), else the commonest KIND of the day's `picture` there, drawn in
 * that kind's commonest ink, blank if the block is nearly empty. A kind, not a
 * character: `&`, `n` and `-` are a tree, a door and a wall only by their color.
 * The picture, not `look()`: a look folds a held `/weather` and the room's
 * footprints, and the snap is kept on disk as the scene.
 */
function glyphOf(stage, picture, inks, borders, bx, by) {
  const kinds = new Map()
  let cells = 0, filled = 0
  for (let y = by * SCALE.y; y < Math.min(stage.height, (by + 1) * SCALE.y); y++) {
    for (let x = bx * SCALE.x; x < Math.min(stage.width, (bx + 1) * SCALE.x); x++) {
      cells++
      const door = stage.doorAt(x, y)
      if (door && !door.hidden && !borders.some((m) => x >= m.x && x < m.x + m.w && y >= m.y && y < m.y + m.h)) return DOOR
      if ((picture[y][x] ?? ' ') === ' ' || !inks[y][x]) continue
      filled++
      const kind = kindOf(inks[y][x])
      const k = kinds.get(kind) ?? { n: 0, ink: new Map() }
      k.n++
      k.ink.set(inks[y][x], (k.ink.get(inks[y][x]) ?? 0) + 1)
      kinds.set(kind, k)
    }
  }
  if (filled < Math.max(1, Math.round(cells * 0.15))) return { ch: ' ', fg: '' }
  const [kind, k] = [...kinds].sort((p, q) => q[1].n - p[1].n)[0]
  return { ch: GLYPH[kind], fg: [...k.ink].sort((p, q) => q[1] - p[1])[0][0] }
}

/** `stage` as a snap of the scene at `route`: `rows` the glyphs and `fg` the ink of each. */
export function coarse(stage, route, now = Date.now()) {
  const picture = stage.picture()
  const inks = stage.inks()
  const borders = stage.marks.filter((m) => m.kind === 'door' && !m.hidden && !m.night && isBorder(m))
  const rows = [], fg = []
  for (let by = 0; by < blocks(stage.height, SCALE.y); by++) {
    let row = ''
    const ink = []
    for (let bx = 0; bx < blocks(stage.width, SCALE.x); bx++) {
      const g = glyphOf(stage, picture, inks, borders, bx, by)
      row += g.ch
      ink.push(g.fg)
    }
    rows.push(row)
    fg.push(ink)
  }
  const doors = stage.marks.filter((m) => m.kind === 'door' && !m.hidden && !m.night).map(({ x, y, w, h, to }) => ({ x, y, w, h, to }))
  return { slug: stage.slug, route, w: stage.width, h: stage.height, rows, fg, doors, at: new Date(now).toISOString() }
}

/** Whether `s` is a snap this file wrote: a file in another shape is no scene. */
export const valid = (s) => !!s && /^[\w-]+$/.test(s.slug) && typeof s.route === 'string'
  && Number.isInteger(s.w) && Number.isInteger(s.h) && Array.isArray(s.rows) && s.rows.every((r) => typeof r === 'string')
  && Array.isArray(s.fg) && s.fg.length === s.rows.length && s.fg.every((r, i) => Array.isArray(r) && r.length === [...s.rows[i]].length && r.every((c) => typeof c === 'string'))
  && Array.isArray(s.doors) && s.doors.every((d) => typeof d?.to === 'string' && [d.x, d.y, d.w, d.h].every(Number.isInteger))

/** Keep this scene as walked into. A failing store is no reason for a walk to fail. */
export async function remember(stage, route, opts) {
  try { await write(coarse(stage, route), opts) } catch (e) { console.error(e) }
}

/** Every snap this machine has kept. */
export async function recall(opts) {
  try { return (await read(opts)).filter(valid) } catch { return [] }
}

// ─── layout ───────────────────────────────────────────────────────────

/** Which side of its scene a border is on: a run down an edge is east or west, along one north or south. */
function sideOf(d, s) {
  if (d.h > 1 && d.w === 1) return d.x < s.w / 2 ? 'west' : 'east'
  return d.y < s.h / 2 ? 'north' : 'south'
}

/**
 * Where each snap sits, in glyph cells: `{ tiles, w, h }`, a tile
 * `{ slug, route, x, y, w, h, rows, fg }`, a frame around its glyphs. The root
 * `/` stays put; a scene beside it is placed by the border between, aligned
 * on the two doors, its frame sharing the edge with the neighbor's; the rest
 * stand in a row under everything, apart.
 */
export function layoutOf(snaps) {
  const root = snaps.find((s) => s.route === '/') ?? snaps[0]
  if (!root) return { tiles: [], w: 0, h: 0 }
  const size = (s) => ({ w: blocks(s.w, SCALE.x) + 2, h: blocks(s.h, SCALE.y) + 2 })
  const tile = (s, x, y) => ({ slug: s.slug, route: s.route, x, y, ...size(s), rows: s.rows, fg: s.fg, snap: s })
  const byRoute = new Map(snaps.map((s) => [s.route, s]))
  const placed = new Map([[root.route, tile(root, 0, 0)]])
  const queue = [root.route]
  while (queue.length) {
    const a = placed.get(queue.shift())
    for (const door of a.snap.doors.filter(isBorder)) {
      const b = byRoute.get(door.to)
      if (!b || placed.has(b.route)) continue
      const back = b.doors.find((d) => isBorder(d) && d.to === a.route)
      const dx = back ? Math.round((door.x - back.x) / SCALE.x) : 0
      const dy = back ? Math.round((door.y - back.y) / SCALE.y) : 0
      const { w, h } = size(b)
      const at = {
        east:  [a.x + a.w - 1, a.y + dy], west:  [a.x - w + 1, a.y + dy],
        south: [a.x + dx, a.y + a.h - 1], north: [a.x + dx, a.y - h + 1],
      }[sideOf(door, a.snap)]
      placed.set(b.route, tile(b, ...at))
      queue.push(b.route)
    }
  }
  const tiles = [...placed.values()]
  const left = Math.min(...tiles.map((t) => t.x))
  const top  = Math.min(...tiles.map((t) => t.y))
  for (const t of tiles) { t.x -= left; t.y -= top }
  let x = 0
  const y = Math.max(...tiles.map((t) => t.y + t.h)) - 1
  for (const s of snaps.filter((s) => !placed.has(s.route)).sort((p, q) => p.route.localeCompare(q.route))) {
    const t = tile(s, x, y)
    tiles.push(t)
    x += t.w + 1
  }
  return {
    tiles,
    w: Math.max(...tiles.map((t) => t.x + t.w)),
    h: Math.max(...tiles.map((t) => t.y + t.h)),
  }
}

const EDGE = { up: 1, right: 2, down: 4, left: 8 }
/** The box-drawing glyph for the edges meeting in a cell, indexed by their `EDGE` bits. */
const LINE = ' │─└││┌├─┘─┴┐┤┬┼'
const [FRAME, FRAME_HERE, NAME, NAME_HERE, YOU] = ['#475569', '#e2e8f0', '#94a3b8', '#fbbf24', { ch: '@', fg: '#0f172a', bg: '#fbbf24' }]

/**
 * The map as a grid of cells `{ ch, fg, bg }`: each tile in a frame whose top
 * edge carries its name, neighbors sharing the edge between them, and `@` on
 * the cell of `here` — `{ route, x, y }`, a stage cell of the scene at
 * `route` — with the frame of that scene bright. Whatever falls outside `w`
 * by `h` is cut.
 */
export function painted(layout, here, { w = layout.w, h = layout.h } = {}) {
  const grid = Array.from({ length: layout.h }, () => Array.from({ length: layout.w }, () => ({ ch: ' ' })))
  const bits = Array.from({ length: layout.h }, () => Array(layout.w).fill(0))
  const edge = (x, y, mask) => { bits[y][x] |= mask }
  for (const t of layout.tiles) {
    for (let i = 0; i < t.w; i++) for (const y of [t.y, t.y + t.h - 1]) edge(t.x + i, y, (i > 0 ? EDGE.left : 0) | (i < t.w - 1 ? EDGE.right : 0))
    for (let j = 0; j < t.h; j++) for (const x of [t.x, t.x + t.w - 1]) edge(x, t.y + j, (j > 0 ? EDGE.up : 0) | (j < t.h - 1 ? EDGE.down : 0))
  }
  const on = here && layout.tiles.find((t) => t.route === here.route)
  const frame = (t, fg) => {
    for (let i = 0; i < t.w; i++) for (const y of [t.y, t.y + t.h - 1]) grid[y][t.x + i] = { ch: LINE[bits[y][t.x + i]], fg }
    for (let j = 0; j < t.h; j++) for (const x of [t.x, t.x + t.w - 1]) grid[t.y + j][x] = { ch: LINE[bits[t.y + j][x]], fg }
  }
  for (const t of layout.tiles) if (t !== on) frame(t, FRAME)
  for (const t of layout.tiles) {
    t.rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) if (row[i] !== ' ') grid[t.y + 1 + j][t.x + 1 + i] = { ch: row[i], fg: t.fg[j][i] }
    })
  }
  if (on) frame(on, FRAME_HERE)
  // A border is an opening in the wall: a gap on the side it is on, left open
  // too where the scene it leads to has not been walked into.
  for (const t of layout.tiles) {
    for (const d of t.snap.doors.filter(isBorder)) {
      const side = sideOf(d, t.snap)
      const [j0, j1] = [Math.floor(d.y / SCALE.y), Math.floor((d.y + d.h - 1) / SCALE.y)]
      const [i0, i1] = [Math.floor(d.x / SCALE.x), Math.floor((d.x + d.w - 1) / SCALE.x)]
      if (side === 'east' || side === 'west') {
        for (let j = j0; j <= j1; j++) grid[t.y + 1 + j][side === 'east' ? t.x + t.w - 1 : t.x] = { ch: ' ' }
      } else {
        for (let i = i0; i <= i1; i++) grid[side === 'north' ? t.y : t.y + t.h - 1][t.x + 1 + i] = { ch: ' ' }
      }
    }
  }
  for (const t of layout.tiles) {
    const name = ` ${t.slug} `.slice(0, Math.max(0, t.w - 4))
    ;[...name].forEach((ch, i) => { grid[t.y][t.x + 2 + i] = { ch, fg: t === on ? NAME_HERE : NAME } })
  }
  if (on) grid[on.y + 1 + Math.floor(here.y / SCALE.y)][on.x + 1 + Math.floor(here.x / SCALE.x)] = YOU
  return grid.slice(0, h).map((r) => r.slice(0, w))
}

/** The same map as rows of text, the color left out. */
export const drawn = (layout, here, size) => painted(layout, here, size).map((r) => r.map((c) => c.ch).join('').trimEnd())
