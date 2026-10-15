// src/world.js — a scene as the SERVER reads it (`IDEAS/haven.md` 12.2): which
// cells can be walked, where the doors are, and what stands on the rest. The
// art is the client's and a bolt is resolved by the server, so the stage is
// written once to `scenes/<slug>.world.json` (`bun run frames`) and
// `api/src/world.ts` reads that — one answer for every screen, and the file
// is pinned the way a `.frame.txt` is.
//
// A row is one character a cell: `.` walkable, `+` a door, `#` anything else
// — a wall, a piece, a cell off the stage. A `#` that belongs to a placed
// piece is named by `pieces`, so a bolt can say what it hit. A carousel's
// riders are `carousels`, which the server scores a bolt on. A floor piece that
// is a pickup (`pieces/index.js`) is named by `pickups`, its cells all `.`.

/** Pieces a bolt shatters; every other solid piece is a wall, which takes a scorch. */
export const FRAGILE = new Set(['barrel', 'crate', 'crates', 'log', 'stump', 'shroom', 'chest', 'bollard'])

/** The name a bolt, and the room's memory, call a placed piece by. */
export const pieceId = (m) => `${m.piece.name}@${m.x},${m.y}`

export function worldOf(stage) {
  const doors = stage.doors.map(({ x, y, to, hidden, night }) => ({ x, y, to, ...(hidden && { hidden }), ...(night && { night }) }))
  const door = new Set(doors.map((d) => `${d.x},${d.y}`))
  const rows = []
  for (let y = 0; y < stage.height; y++) {
    let row = ''
    for (let x = 0; x < stage.width; x++) row += door.has(`${x},${y}`) ? '+' : stage.walkable(x, y) ? '.' : '#'
    rows.push(row)
  }
  const pieces = []
  for (const m of stage.marks) {
    if (m.kind !== 'piece') continue
    const cells = m.piece.cells.map((c) => [m.x + c.dx, m.y + c.dy]).filter(([x, y]) => rows[y]?.[x] === '#')
    if (cells.length) pieces.push({ id: pieceId(m), name: m.piece.name, ...(FRAGILE.has(m.piece.name) && { fragile: true }), cells })
  }
  const pickups = []
  for (const m of stage.marks) {
    if (m.kind !== 'piece' || !m.piece.pickup) continue
    const cells = m.piece.cells.map((c) => [m.x + c.dx, m.y + c.dy]).filter(([x, y]) => rows[y]?.[x] === '.')
    if (cells.length) pickups.push({ id: pieceId(m), item: m.piece.pickup.item, n: m.piece.pickup.n, cells })
  }
  const pacers = stage.marks.filter((m) => m.kind === 'pacer')
    .map(({ spec: { name, y, from, to, ms, rest, right, left, sit, flee, night } }) => ({ name, y, from, to, ms, rest, right, left, sit, ...(flee && { flee }), ...(night != null && { night }) }))
  const carousels = stage.carousels.map(({ name, x, apart, top, bottom, ms, n, cells }) => ({ name, x, apart, top, bottom, ms, n, cells }))
  return { slug: stage.slug, width: stage.width, height: stage.height, spawn: stage.spawn, rows, doors, pieces, pickups, pacers, carousels }
}

/** The file's text: a row, a piece, a door on a line each, so a diff of a moved piece is one line. */
export function worldJson(world) {
  const field = ([k, v]) => Array.isArray(v)
    ? `"${k}": [${v.length ? '\n' + v.map((i) => ' ' + JSON.stringify(i)).join(',\n') + '\n' : ''}]`
    : `"${k}": ${JSON.stringify(v)}`
  return `{\n${Object.entries(world).map(field).join(',\n')}\n}\n`
}
