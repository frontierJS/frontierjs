// src/stage.js — a scene's cells, claimed by the pieces placed on it
// (`FJS-D997`). `Scene.mesa` makes one and provides it as `$context.scene`;
// `<Piece>`, `<Row>`, `<Door>` and `<Pacer>` write to it; `#paint` draws it;
// the drives and `scenes.test.js` read it by slug from `stages`; the scene
// editor moves its `marks`.
//
// A cell has one owner. A second piece on a claimed cell throws naming the
// cell and both pieces, at mount rather than at render, because the frame
// would only look wrong. A door is the one claim allowed over another: it
// replaces the wall cell under it, which is what a door in a wall is.
//
// Walkable is unclaimed, or claimed by a `floor` piece; a door is stepped
// onto only to go through, so it is not. A door with a size is a run of door
// cells along an edge — a border into the scene beside this one — and
// `arrival()` says where a figure stands having come through one: beside
// the door that leads back, at the matching row or column, so the two
// scenes agree on a crossing without naming each other's cells. A border
// whose far side has no run at that row drops the figure beside the nearest
// cell of it; `scenes.test.js` pairs every edge door with one across.
// The server bounds a move to whole
// cells and nothing finer (`api/src/rooms.ts`), so a client that walks through
// a wall walks through it on its own screen and every other one.
//
// The view is the slice of the stage a screen shows (`IDEAS/haven.md` 6.1):
// VIEW cells at most, following the figure a scene tells it to with EDGE
// cells of slack, so it pans only when the figure nears an edge. It lives
// on the stage, so a pan is a `changed()` like a moved piece and `#paint`
// has one subscription; a stage no bigger than VIEW never pans. The editor
// asks for the whole stage instead.
//
// Light and fog (`IDEAS/haven.md` 6.3). Once a scene says which figure
// SEES (`see(x, y)`), a cell is lit when it is within SIGHT of that figure
// with nothing opaque between — a claimed cell that is not floor blocks the
// line — or within the radius of a palette entry with `light: r`, which is
// seen from anywhere in the room: a lamp's halo across the square, the
// hearth from the tavern door. Light passes through walls where sight does
// not, because a hearth is ringed by its own frame cells and a fire nobody
// could see is no fire. A cell lit once and not now is dim — its glyph at
// the clock's first step in a darkened color, a memory that does not move
// — and one never lit is blank. With no seer every cell is lit: the
// picture, the editor, a test. `litAt()` is the pure answer, so a drive
// and both targets agree on which cells a screen shows.
//
// A cycling cell steps on a shared clock. `wave` offsets each cell by its
// column and row, so a row of water rolls; `flicker` draws each cell's step
// from a hash of the tick and the cell, so a fire never repeats in a pattern
// the eye can follow. The clock is the wall's, so two terminals in one room
// draw the cat on the same cell.

/** Every stage made in this process, by slug — for a test or a drive to read. */
export const stages = new Map()

const hash = (a, b, c) => {
  let h = (a * 374761393 + b * 668265263 + c * 2246822519) >>> 0
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

const stepOf = (style, x, y, ms) => {
  const tick = Math.floor(ms / style.ms)
  return style.flicker ? hash(tick, x, y) : style.wave ? tick + x + y : tick
}

const pick = (v, i) => (Array.isArray(v) ? v[i % v.length] : v)

/** The color of a glyph its palette does not color — the terminal's own ink. */
export const INK = '#c8c8c8'

const dims = new Map()
/** `hex` at two fifths of its light: what a remembered cell is drawn in. */
export const dim = (hex) => {
  if (!hex) return hex
  let d = dims.get(hex)
  if (!d) dims.set(hex, d = '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.4).toString(16).padStart(2, '0')).join(''))
  return d
}

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

/** How far a figure sees, in rows; a column counts half, since a cell is twice as tall as it is wide. */
export const SIGHT = 7

const within = (a, b, r) => ((a.x - b.x) / 2) ** 2 + (a.y - b.y) ** 2 <= r * r

/** Whether nothing opaque stands strictly between `a` and `b`: every cell the line crosses is one a figure could stand on. */
function clear(stage, a, b) {
  let { x, y } = a
  const dx = Math.abs(b.x - x), dy = Math.abs(b.y - y)
  const sx = x < b.x ? 1 : -1, sy = y < b.y ? 1 : -1
  let err = dx - dy
  for (;;) {
    const e2 = 2 * err
    if (e2 > -dy) { err -= dy; x += sx }
    if (e2 < dx)  { err += dx; y += sy }
    if (x === b.x && y === b.y) return true
    if (!stage.walkable(x, y)) return false
  }
}

/**
 * Whether the cell `x, y` of `stage` is lit for a figure standing at `from`:
 * within SIGHT of it with a clear line, or within the radius of a light.
 * Everything is lit for no figure. An opaque cell is also seen when a floor
 * cell beside it is: a line skimming along a hedge meets the hedge's own
 * nearer cells first, and a wall seen that way would show two cells of it.
 */
export function litAt(stage, x, y, from) {
  if (!from) return true
  const cell = { x, y }
  if (within(from, cell, SIGHT)) {
    if (clear(stage, from, cell)) return true
    if (!stage.walkable(x, y) && STEPS.some(([dx, dy]) => {
      const n = { x: x + dx, y: y + dy }
      return stage.walkable(n.x, n.y) && within(from, n, SIGHT) && clear(stage, from, n)
    })) return true
  }
  return stage.lights.some((l) => within(l, cell, l.r))
}

/** The most cells a screen shows: a 100×30 terminal with the status and input lines under the art. */
export const VIEW = { w: 97, h: 26 }

/** How near an edge the followed figure may come before the view pans. */
export const EDGE = { x: 8, y: 4 }

/**
 * Where the view sits once a figure at `fig` is followed from `view`:
 * VIEW cells or the extent where that is smaller, the figure kept EDGE
 * cells from each edge, and the view kept inside the extent. A figure
 * already inside the slack leaves the view where it is.
 */
export function follow(view, fig, extent) {
  const axis = (at, size, f, edge, span) => {
    let v = at
    if (f - v < edge) v = f - edge
    if (v + size - 1 - f < edge) v = f + edge - size + 1
    return Math.max(0, Math.min(v, span - size))
  }
  const w = Math.min(VIEW.w, extent.width)
  const h = Math.min(VIEW.h, extent.height)
  return { x: axis(view.x, w, fig.x, EDGE.x, extent.width), y: axis(view.y, h, fig.y, EDGE.y, extent.height), w, h }
}

/**
 * Where a figure stands on `stage` having come through a door: beside the
 * door here that leads back to `from`, the one nearest the cell `{ x, y }`
 * it stepped onto there — so a border is crossed at the matching row or
 * column, and a door is come out of rather than spawned away from. The
 * spawn when no door here leads back, or none has floor beside it.
 */
export function arrival(stage, { from, x, y } = {}) {
  const back = from ? stage.doors.filter((d) => d.to === from) : []
  if (!back.length) return { ...stage.spawn }
  const near = (d) => Math.abs(d.x - x) + Math.abs(d.y - y)
  const door = back.reduce((a, b) => (near(b) < near(a) ? b : a))
  const beside = STEPS.map(([dx, dy]) => ({ x: door.x + dx, y: door.y + dy })).find((c) => stage.walkable(c.x, c.y))
  return beside ?? { ...stage.spawn }
}

/**
 * Where a pacer is `ms` into the clock: `{ x, y, text }`, `x` the sprite's
 * left edge. It walks right from `from` until its sprite ends on `to`, sits
 * `rest` steps, walks back, and sits again; `sit` frames are kept against the
 * end it walked to.
 */
export function pacerAt(p, ms = 0) {
  const width = p.right[0].length
  const span  = p.to - p.from + 1 - width
  const leg   = span + p.rest
  const step  = Math.floor(ms / p.ms)
  const t     = step % (2 * leg)
  const out   = t < leg
  const k     = out ? t : t - leg
  if (k < span) return { x: out ? p.from + k : p.from + span - k, y: p.y, text: pick(out ? p.right : p.left, step) }
  const text = pick(p.sit, k - span)
  return { x: out ? p.from + span + width - text.length : p.from, y: p.y, text }
}

/**
 * @param {{ slug: string, palette?: object, spawn: { x: number, y: number } }} o
 */
export function createStage({ slug, palette = {}, spawn }) {
  const claims    = new Map()   // 'x,y' → { ch, key, name, floor, door }
  const pacers    = []
  const marks     = []          // every placed thing, in the order it was placed
  const listeners = new Set()
  let width = 0, height = 0
  let eye   = { x: 0, y: 0 }   // the view's top-left
  let fig   = null             // the figure followed, re-followed when the extent changes
  let whole = false
  let seer  = null             // the figure that sees; null lights every cell
  let lights  = []             // every cell whose palette entry has a light, with its radius
  let visible = new Set()      // 'x,y' lit for the seer now
  let seen    = new Set()      // 'x,y' lit for the seer at any time

  const key = (x, y) => `${x},${y}`
  const extent = () => {
    width = 0
    height = 0
    for (const k of claims.keys()) {
      const [x, y] = k.split(',').map(Number)
      if (x + 1 > width) width = x + 1
      if (y + 1 > height) height = y + 1
    }
  }
  const relight = () => {
    lights = []
    for (const [k, c] of claims) {
      const r = palette[c.key]?.light
      if (!r) continue
      const [x, y] = k.split(',').map(Number)
      lights.push({ x, y, r })
    }
    if (!seer) return
    visible = new Set()
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (litAt(stage, x, y, seer)) { const k = key(x, y); visible.add(k); seen.add(k) }
    }
  }
  // A painter that fails must not fail the claim it was told about: the
  // stage is right and the picture is late, which the next tick repairs.
  const changed = () => {
    extent()
    if (fig) eye = follow({ ...eye }, fig, { width, height })
    relight()
    for (const fn of listeners) { try { fn() } catch (e) { console.error(e) } }
  }
  const drop = (mark) => { const i = marks.indexOf(mark); if (i !== -1) marks.splice(i, 1) }

  const claim = (x, y, cell) => {
    const held = claims.get(key(x, y))
    if (held && !cell.door) {
      throw new Error(`[${slug}] cell ${x},${y} is claimed by both ${held.name} and ${cell.name}`)
    }
    claims.set(key(x, y), cell)
  }

  // A piece's cells are claimed all or none: a claim refused midway is
  // taken back before the error leaves, so a refused move leaves the piece
  // where it was.
  const putAll = (cells) => {
    const done = []
    try {
      for (const [x, y, cell] of cells) { claim(x, y, cell); done.push([x, y]) }
    } catch (e) {
      for (const [x, y] of done) claims.delete(key(x, y))
      throw e
    }
  }

  const stage = {
    slug,
    palette,
    spawn,
    pacers,
    marks,
    get width()  { return width },
    get height() { return height },

    /** The slice a screen draws: `{ x, y, w, h }` in the stage's cells. */
    get view() {
      if (whole) return { x: 0, y: 0, w: width, h: height }
      return { x: eye.x, y: eye.y, w: Math.min(VIEW.w, width), h: Math.min(VIEW.h, height) }
    },

    /** Keep this figure on screen; a pan redraws. The figure is kept, so a piece mounting later pans too. */
    follow(x, y) {
      fig = { x, y }
      const next = follow(stage.view, fig, { width, height })
      if (next.x === eye.x && next.y === eye.y) return
      eye = { x: next.x, y: next.y }
      changed()
    },

    /** The whole stage as the view, for the editor's preview. */
    showAll() { whole = true; changed() },

    /** This figure sees from here: what it lights now is lit, what it lit once is dim, the rest dark. A step redraws. */
    see(x, y) {
      seer = { x, y }
      relight()
      for (const fn of listeners) { try { fn() } catch (e) { console.error(e) } }
    },

    /** Every light on the stage, `{ x, y, r }`. */
    get lights() { return lights },

    /** How this cell stands to the seer: `'lit'`, `'dim'` (lit once, not now) or `'dark'`; lit everywhere with no seer. */
    light(x, y) {
      if (!seer) return 'lit'
      const k = key(x, y)
      return visible.has(k) ? 'lit' : seen.has(k) ? 'dim' : 'dark'
    },

    /** A piece's cells, claimed at `x, y`; the mark moves or removes them. */
    stamp(piece, x, y) {
      const cellsAt = (px, py) => piece.cells.map((c) => [px + c.dx, py + c.dy, { ch: c.ch, key: c.key, name: piece.name, floor: piece.floor }])
      const lift = () => { for (const c of piece.cells) claims.delete(key(mark.x + c.dx, mark.y + c.dy)) }
      const mark = {
        kind: 'piece', piece, x, y,
        move(nx, ny) {
          if (nx === mark.x && ny === mark.y) return
          lift()
          try { putAll(cellsAt(nx, ny)) }
          catch (e) { putAll(cellsAt(mark.x, mark.y)); throw e }
          mark.x = nx
          mark.y = ny
          changed()
        },
        remove() { lift(); drop(mark); changed() },
      }
      putAll(cellsAt(x, y))
      marks.push(mark)
      changed()
      return mark
    },

    /**
     * A door on a cell, replacing whatever is drawn there; stepping onto it
     * is `goto(to)`. With a size it is a run of door cells sharing one `to`
     * — a border along an edge (`IDEAS/haven.md` 6.2) — and one mark.
     */
    door(x, y, to, { w = 1, h = 1 } = {}) {
      const under = new Map()   // 'x,y' → the cell the door replaced
      const each = (px, py, fn) => { for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) fn(px + dx, py + dy) }
      const put = (px, py) => each(px, py, (cx, cy) => {
        under.set(key(cx, cy), claims.get(key(cx, cy)) ?? null)
        claim(cx, cy, { ch: 'n', key: 'd', name: 'door', floor: false, door: mark.to })
      })
      const lift = () => each(mark.x, mark.y, (cx, cy) => {
        const was = under.get(key(cx, cy))
        if (was) claims.set(key(cx, cy), was); else claims.delete(key(cx, cy))
      })
      const mark = {
        kind: 'door', x, y, to, w, h,
        move(nx, ny) {
          if (nx === mark.x && ny === mark.y) return
          lift()
          under.clear()
          put(nx, ny)
          mark.x = nx
          mark.y = ny
          changed()
        },
        retarget(nto) {
          mark.to = nto
          each(mark.x, mark.y, (cx, cy) => { claims.get(key(cx, cy)).door = nto })
          changed()
        },
        remove() { lift(); drop(mark); changed() },
      }
      put(x, y)
      marks.push(mark)
      changed()
      return mark
    },

    /** A sprite walking a row back and forth, drawn over the art and under every figure. */
    pace(spec) {
      pacers.push(spec)
      const mark = {
        kind: 'pacer', spec,
        get x() { return spec.from }, get y() { return spec.y },
        move(nx, ny) {
          spec.to   = nx + (spec.to - spec.from)
          spec.from = nx
          spec.y    = ny
          changed()
        },
        remove() { const i = pacers.indexOf(spec); if (i !== -1) pacers.splice(i, 1); drop(mark); changed() },
      }
      marks.push(mark)
      changed()
      return mark
    },

    /** Called after any claim changes; `#paint` redraws on it. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },

    /** Redraw now — after the palette was edited in place. */
    touch() { changed() },

    /** The door on this cell, or null. */
    doorAt(x, y) {
      const c = claims.get(key(x, y))
      return c?.door ? { x, y, to: c.door } : null
    },

    /** Every door, for a test that walks to each. */
    get doors() {
      const out = []
      for (const [k, c] of claims) if (c.door) { const [x, y] = k.split(',').map(Number); out.push({ x, y, to: c.door }) }
      return out
    },

    /** Whether a figure may stand on this cell. */
    walkable(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return false
      const c = claims.get(key(x, y))
      return !c || (c.floor && !c.door)
    },

    /**
     * How one cell looks `ms` into the clock: `{ ch, fg, bg }`, colors
     * undefined for the terminal's own. A dark cell is blank; a dim one is
     * its glyph at the clock's first step, darkened.
     */
    look(x, y, ms = 0) {
      const light = stage.light(x, y)
      if (light === 'dark') return { ch: ' ', fg: undefined, bg: undefined }
      const c = claims.get(key(x, y))
      const ch = c?.ch ?? ' '
      const style = c && c.key !== ' ' ? palette[c.key] : null
      const step = style?.ms && light === 'lit' ? stepOf(style, x, y, ms) : 0
      const out = style
        ? { ch: style.chars ? pick([...style.chars], step) : ch, fg: pick(style.fg, step), bg: pick(style.bg, step) }
        : { ch, fg: undefined, bg: undefined }
      if (light === 'dim' && ch !== ' ') { out.fg = dim(out.fg ?? INK); out.bg = dim(out.bg) }
      return out
    },

    /** Whether this cell's glyph is changed by the clock. */
    cycles(x, y) {
      const c = claims.get(key(x, y))
      return !!(c && palette[c.key]?.chars)
    },

    /** The shortest step any cell or pacer moves on, or 0 when none does. */
    tickOf() {
      const steps = [...Object.values(palette), ...pacers].map((s) => s.ms).filter(Boolean)
      return steps.length ? Math.min(...steps) : 0
    },

    /** The glyphs, one row per line — the picture `scenes/<name>.frame.txt` holds. */
    picture() {
      const rows = []
      for (let y = 0; y < height; y++) {
        let row = ''
        for (let x = 0; x < width; x++) row += claims.get(key(x, y))?.ch ?? ' '
        rows.push(row)
      }
      return rows
    },
  }

  stages.set(slug, stage)
  return stage
}
