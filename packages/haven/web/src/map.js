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

/** The glyph for the block of stage cells at block `bx, by`: a door if one is in it, else the commonest glyph drawn there, blank if none. */
function glyphOf(stage, bx, by) {
  const count = new Map()
  for (let y = by * SCALE.y; y < Math.min(stage.height, (by + 1) * SCALE.y); y++) {
    for (let x = bx * SCALE.x; x < Math.min(stage.width, (bx + 1) * SCALE.x); x++) {
      const door = stage.doorAt(x, y)
      if (door && !door.hidden) return 'n'
      const { ch } = stage.look(x, y)
      if (ch !== ' ') count.set(ch, (count.get(ch) ?? 0) + 1)
    }
  }
  let best = ' ', most = 0
  for (const [ch, n] of count) if (n > most) { best = ch; most = n }
  return best
}

/** `stage` as a snap of the scene at `route`. */
export function coarse(stage, route, now = Date.now()) {
  const rows = []
  for (let by = 0; by < blocks(stage.height, SCALE.y); by++) {
    let row = ''
    for (let bx = 0; bx < blocks(stage.width, SCALE.x); bx++) row += glyphOf(stage, bx, by)
    rows.push(row)
  }
  const doors = stage.marks.filter((m) => m.kind === 'door' && !m.hidden && !m.night).map(({ x, y, w, h, to }) => ({ x, y, w, h, to }))
  return { slug: stage.slug, route, w: stage.width, h: stage.height, rows, doors, at: new Date(now).toISOString() }
}

/** Whether `s` is a snap this file wrote: a file in another shape is no scene. */
export const valid = (s) => !!s && /^[\w-]+$/.test(s.slug) && typeof s.route === 'string'
  && Number.isInteger(s.w) && Number.isInteger(s.h) && Array.isArray(s.rows) && s.rows.every((r) => typeof r === 'string')
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

const isBorder = (d) => d.w > 1 || d.h > 1

/** Which side of its scene a border is on: a run down an edge is east or west, along one north or south. */
function sideOf(d, s) {
  if (d.h > 1 && d.w === 1) return d.x < s.w / 2 ? 'west' : 'east'
  return d.y < s.h / 2 ? 'north' : 'south'
}

/**
 * Where each snap sits, in glyph cells: `{ tiles, w, h }`, a tile
 * `{ slug, route, x, y, w, h, rows }` whose first row is its name. The root
 * `/` stays put; a scene beside it is placed by the border between, aligned
 * on the two doors; the rest stand in a row under everything.
 */
export function layoutOf(snaps) {
  const root = snaps.find((s) => s.route === '/') ?? snaps[0]
  if (!root) return { tiles: [], w: 0, h: 0 }
  const size = (s) => ({ w: blocks(s.w, SCALE.x), h: blocks(s.h, SCALE.y) + 1 })
  const tile = (s, x, y) => ({ slug: s.slug, route: s.route, x, y, ...size(s), rows: s.rows, snap: s })
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
        east:  [a.x + a.w, a.y + dy], west:  [a.x - w, a.y + dy],
        south: [a.x + dx, a.y + a.h], north: [a.x + dx, a.y - h],
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
  const y = Math.max(...tiles.map((t) => t.y + t.h))
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

/**
 * The map as rows of text: each tile under its name, and `@` on the cell of
 * `here` — `{ route, x, y }`, a stage cell of the scene at `route`. Whatever
 * falls outside `w` by `h` is cut.
 */
export function drawn(layout, here, { w = layout.w, h = layout.h } = {}) {
  const grid = Array.from({ length: layout.h }, () => Array(layout.w).fill(' '))
  for (const t of layout.tiles) {
    for (let i = 0; i < t.w; i++) grid[t.y][t.x + i] = t.slug[i] ?? ' '
    t.rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) grid[t.y + 1 + j][t.x + i] = row[i] })
  }
  const on = here && layout.tiles.find((t) => t.route === here.route)
  if (on) grid[on.y + 1 + Math.floor(here.y / SCALE.y)][on.x + Math.floor(here.x / SCALE.x)] = '@'
  return grid.slice(0, h).map((r) => r.slice(0, w).join('').trimEnd())
}
