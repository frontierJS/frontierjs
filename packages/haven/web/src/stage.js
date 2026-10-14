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
// onto only to go through, so it is not. The server bounds a move to whole
// cells and nothing finer (`api/src/rooms.ts`), so a client that walks through
// a wall walks through it on its own screen and every other one.
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
  // A painter that fails must not fail the claim it was told about: the
  // stage is right and the picture is late, which the next tick repairs.
  const changed = () => {
    extent()
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

    /** A door on a cell, replacing whatever is drawn there; stepping onto it is `goto(to)`. */
    door(x, y, to) {
      let under = null
      const put = (px, py) => { under = claims.get(key(px, py)) ?? null; claim(px, py, { ch: 'n', key: 'd', name: 'door', floor: false, door: mark.to }) }
      const lift = () => { if (under) claims.set(key(mark.x, mark.y), under); else claims.delete(key(mark.x, mark.y)) }
      const mark = {
        kind: 'door', x, y, to,
        move(nx, ny) {
          if (nx === mark.x && ny === mark.y) return
          lift()
          put(nx, ny)
          mark.x = nx
          mark.y = ny
          changed()
        },
        retarget(nto) {
          mark.to = nto
          claims.get(key(mark.x, mark.y)).door = nto
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

    /** How one cell looks `ms` into the clock: `{ ch, fg, bg }`, colors undefined for the terminal's own. */
    look(x, y, ms = 0) {
      const c = claims.get(key(x, y))
      const ch = c?.ch ?? ' '
      const style = c && c.key !== ' ' ? palette[c.key] : null
      if (!style) return { ch, fg: undefined, bg: undefined }
      const step = style.ms ? stepOf(style, x, y, ms) : 0
      return {
        ch: style.chars ? pick([...style.chars], step) : ch,
        fg: pick(style.fg, step),
        bg: pick(style.bg, step),
      }
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
