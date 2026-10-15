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
// Walkable is unclaimed, or claimed by a `floor` piece, or claimed by a cell
// of a piece that is `overhead` — in the air, a canopy a figure walks under; a
// door is stepped onto only to go through, so it is not. A door with a size
// is a run of door cells along an edge — a border into the scene beside this one — and
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
// One clock (`IDEAS/haven.md` 12.7). Whatever moves on a scene is a task on
// its stage -- `task(key, fn, { phase, every, after })` -- and a FRAME runs the
// tasks due, phase by phase: `simulate` moves things (the runner, a poll),
// `light` works out what is lit, `paint` draws. Paint runs only when something
// invalidated the picture: a claim, a step, a footprint, or the look reaching
// its next tick (`tickOf`). A change outside a frame paints at once, as it
// always has, so a drive reads a step the moment it is taken. `every` is
// on the wall's clock, not the mount's, so two screens poll and the runner
// steps on the same beat. A `manual` stage keeps no timer at all: a test
// calls `frame(ms)` and pins a scene with state at tick N, the way `look(x,
// y, ms)` pins one without.
//
// A cycling cell steps on a shared clock. `wave` offsets each cell by its
// column and row, so a row of water rolls; `flicker` draws each cell's step
// from a hash of the tick and the cell, so a fire never repeats in a pattern
// the eye can follow. The clock is the wall's, so two terminals in one room
// draw the cat on the same cell.
//
// What a cell looks like past its own glyph is a fold over the LAYERS a scene
// names (`IDEAS/haven.md` 12.6), always in LAYERS' order whatever order they
// are named in, and a layer not named is not there: a roof is a scene that
// names no sky and no weather (INDOORS), and the fog is off by being named by
// no scene. Each layer is one rule:
//
//   candle   a piece's `burns` cell is an unlit `.` until one of its seats is taken.
//   weather  rain or snow (7.3, `sky.js`) on a blank cell -- the air between
//            the art -- so a drop never hides a wall, a door or a piece, and a
//            cell under a canopy takes none.
//   steps    a footprint (7.4) on a blank cell somebody stood on in the last
//            few minutes, fading in thirds; a drop falls in front of it.
//   scorch   a bolt's `,` (9.5) on the wall it struck, fading in thirds; it
//            replaces the wall's glyph, since a wall is not blank.
//   sky      the night (7.2): every color but a light source's is shaded
//            toward moonlight, and a cell inside a light's radius keeps half
//            the day. The fog's SIGHT does not shrink at night.
//   fog      a cell lit once and not now is dim, one never lit is blank (6.3).
//
// Every layer is drawn by `look()`, so the figures, which are boxes a layer
// up, walk in front of all of them, and the two targets cannot disagree about
// which cell has a drop or a footprint.

import { pacerAt, pick } from '../../api/src/pacer.ts'
import { darkness, isNight, shade, SKY_MS, hash, weatherAt, fallAt, untilWeatherChange, FALL } from './sky.js'
import { fadeOf } from '../../api/src/memory.ts'
import { pieceId } from './world.js'
import { spotsOf } from './pieces/index.js'

export { pacerAt }

/** Every stage made in this process, by slug — for a test or a drive to read. */
export const stages = new Map()

/** What this screen's figure wears from scene to scene: the `ink` a `dye` cell gave it. */
export const worn = { ink: null }

const stepOf = (style, x, y, ms) => {
  const tick = Math.floor(ms / style.ms)
  return style.flicker ? hash(tick, x, y) : style.wave ? tick + x + y : tick
}

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

/** The phases of a frame, in order. */
export const PHASES = ['simulate', 'light', 'paint']

/** Every layer `look()` folds, in the order it folds them. */
export const LAYERS = ['candle', 'weather', 'steps', 'scorch', 'sky', 'fog']

/**
 * What a scene out of doors names when it names nothing. Not the fog: with
 * it off every cell is lit for every figure, and `seer` is still kept, since
 * a worker is read off where the figure stands. Name `fog` to bring it back.
 */
export const OUTDOORS = ['candle', 'weather', 'steps', 'scorch', 'sky']

/** Under a roof: no sky and no weather. */
export const INDOORS = ['candle', 'steps', 'scorch']

/** A footprint's ink as it fades, faintest first: a third of its life each. */
export const STEP_FG = ['#4a4236', '#6b604e', '#968669']

/** A scorch's ink as it fades, faintest first: a third of its life each. */
export const SCORCH_FG = ['#4a3a30', '#7a5030', '#c2703a']

/**
 * A `crumbles` cell once a figure has stepped off it: it shakes for `wobble`
 * ms, sinks for `fall` more, and is its `into` cell after that. `shake` and
 * `sink` are the glyphs it cycles through, at `beat` ms a glyph.
 */
export const CRUMBLE = { wobble: 900, fall: 450, beat: 150, shake: ['=', '-'], sink: ['_', ',', '.'] }

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
 * spawn when no door here leads back, or none has floor beside it. A
 * figure that `stand`s up from a booth is where it says, on any floor.
 */
export function arrival(stage, { from, x, y, stand } = {}) {
  // Come back from a booth: stood up beside the seat, which the booth was told.
  if (stand && stage.walkable(Number(x), Number(y))) return { x: Number(x), y: Number(y) }
  const back = from ? stage.doors.filter((d) => d.to === from) : []
  if (!back.length) return { ...stage.spawn }
  const near = (d) => Math.abs(d.x - x) + Math.abs(d.y - y)
  const door = back.reduce((a, b) => (near(b) < near(a) ? b : a))
  const beside = STEPS.map(([dx, dy]) => ({ x: door.x + dx, y: door.y + dy })).find((c) => stage.walkable(c.x, c.y))
  return beside ?? { ...stage.spawn }
}

/**
 * @param {{ slug: string, palette?: object, spawn: { x: number, y: number } }} o
 */
export function createStage({ slug, palette = {}, spawn, layers = OUTDOORS, manual = false }) {
  for (const l of layers) if (!LAYERS.includes(l)) throw new Error(`[${slug}] no layer is called ${l}; the layers are ${LAYERS.join(', ')}`)
  const has  = (name) => layers.includes(name)
  const fog  = has('fog')
  const claims    = new Map()   // 'x,y' → { ch, key, name, floor, overhead, door, hidden }
  const pacers    = []
  const marks     = []          // every placed thing, in the order it was placed
  const listeners = new Set()
  let width = 0, height = 0
  let eye   = { x: 0, y: 0 }   // the view's top-left
  let fig   = null             // the figure followed, re-followed when the extent changes
  let whole = false
  let seer  = null             // the figure that sees; null lights every cell
  // A piece's own palette entries, for the letters the scene's palette leaves out
  // (`pieces/index.js`); the scene's entry for a letter wins.
  const defaults = new Map()
  const defaultFrom = new Map()
  const entryOf = (k) => palette[k] ?? defaults.get(k)
  // A piece's entries join the defaults, unless the scene names the letter
  // itself; two pieces that give one letter different entries, with nothing
  // from the scene to settle it, are refused naming both.
  const adopt = (piece) => {
    for (const [k, entry] of Object.entries(piece.palette ?? {})) {
      if (k in palette) continue
      const have = defaults.get(k)
      if (have && JSON.stringify(have) !== JSON.stringify(entry)) {
        throw new Error(`paint letter ${k} is ${defaultFrom.get(k)}'s one way and ${piece.name}'s another, and the scene's palette does not say which`)
      }
      defaults.set(k, entry)
      defaultFrom.set(k, piece.name)
    }
  }
  const readopt = () => {
    defaults.clear()
    defaultFrom.clear()
    for (const m of marks) if (m.kind === 'piece') adopt(m.piece)
  }
  let lights  = []             // every cell whose palette entry has a light, with its radius
  let visible = new Set()      // 'x,y' lit for the seer now
  let seen    = new Set()      // 'x,y' lit for the seer at any time
  let occupied = new Set()     // 'x,y' a figure stands on, for what burns only while a seat is taken
  let glow    = null           // 'x,y' within some light's radius; made at the first night look, dropped by relight
  let steps   = new Map()      // 'x,y' → { at, until }, the newest footprint on the cell
  let scorches = new Map()     // 'x,y' → { at, until }, the newest scorch on the cell
  let crumbling = new Map()    // 'x,y' → { at }, a `crumbles` cell a figure has stood on: `at` is when it was left, null while it is stood on
  let shattered = new Map()    // 'x,y' → until, a solid cell of a piece a bolt broke, on the clock `look()` is asked at
  const tasks = []             // { key, fn, phase, every, due }, in the order each phase runs them
  let framing = false          // inside a frame: a change marks it dirty and the frame paints it
  let dirty   = true
  let lookDue = -Infinity      // when the look next changes on its own
  let last    = 0              // the ms of the last frame, which is now for a stage stepped by hand
  let timer   = null

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
    glow = null
    for (const [k, c] of claims) {
      const r = entryOf(c.key)?.light
      if (!r) continue
      const [x, y] = k.split(',').map(Number)
      lights.push({ x, y, r })
    }
    if (!seer || !fog) return
    visible = new Set()
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (litAt(stage, x, y, seer)) { const k = key(x, y); visible.add(k); seen.add(k) }
    }
  }
  // How dark a cell is `ms` into the clock: 0 by day or with no sky, 0 on a
  // light source, half the sky inside a light's radius.
  const nightAt = (x, y, ms) => {
    const d = has('sky') ? darkness(ms) : 0
    if (!d) return 0
    if (entryOf(claims.get(key(x, y))?.key)?.light) return 0
    if (!glow) {
      glow = new Set()
      for (const l of lights) {
        const rx = 2 * l.r
        for (let dy = -l.r; dy <= l.r; dy++) for (let dx = -rx; dx <= rx; dx++) {
          if (within({ x: 0, y: 0 }, { x: dx, y: dy }, l.r)) glow.add(key(l.x + dx, l.y + dy))
        }
      }
    }
    return glow.has(key(x, y)) ? d / 2 : d
  }
  // A painter that fails must not fail the claim it was told about: the
  // stage is right and the picture is late, which the next tick repairs.
  const changed = () => {
    extent()
    if (fig) eye = follow({ ...eye }, fig, { width, height })
    relight()
    tell()
  }
  // A painter that fails must not fail the claim it was told about either.
  const tell = () => {
    for (const fn of listeners) { try { fn() } catch (e) { console.error(e) } }
    invalidate()
  }

  const now = () => (manual ? last : Date.now())
  const invalidate = () => {
    dirty = true
    if (!framing) frame(now(), false)
  }
  // One frame at `ms`: the tasks due in each phase in order, the paint only
  // when the picture changed. `simulate` is false for a frame a change asked
  // for, which moves nothing.
  const frame = (ms, simulate = true) => {
    framing = true
    last = ms
    try {
      if (ms >= lookDue) dirty = true
      for (const phase of PHASES) {
        if (phase === 'simulate' && !simulate) continue
        if (phase === 'paint' && !dirty) continue
        if (phase === 'paint') {
          // The look's next change is counted from this paint, not from
          // whichever frame ran last, or a poll every second would keep
          // pushing the water's next step out of reach.
          dirty = false
          const tick = stage.tickOf(ms)
          lookDue = tick ? ms + tick : Infinity
        }
        for (const t of [...tasks]) {
          if (t.phase !== phase || !tasks.includes(t)) continue
          if (t.every) { if (ms < t.due) continue; t.due = (Math.floor(ms / t.every) + 1) * t.every }
          try { t.fn(ms) } catch (e) { console.error(e) }
        }
      }
    } finally { framing = false }
    schedule()
  }
  // The wall's timer, at the next due task or the look's next tick; none
  // while nothing would run. Unref'd, so a terminal's `--frame` render exits
  // when its work is done rather than when the water stops.
  const schedule = () => {
    if (manual) return
    if (timer) clearTimeout(timer)
    timer = null
    const painted = tasks.some((t) => t.phase === 'paint')
    const at = Math.min(...tasks.filter((t) => t.every).map((t) => t.due), painted ? lookDue : Infinity)
    if (at === Infinity) return
    timer = setTimeout(() => { timer = null; frame(Date.now()) }, Math.max(0, at - Date.now()))
    timer?.unref?.()
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

  // The claim on a cell as the clock has it: a night door by day is the cell it replaced.
  const cellAt = (x, y, ms) => {
    if ((shattered.get(key(x, y)) ?? 0) > ms) return undefined
    const c = claims.get(key(x, y))
    if (c?.crumbles) return crumbled(c, crumbling.get(key(x, y)), ms)
    return c?.night && !isNight(ms) ? c.day : c
  }
  // A `crumbles` cell as the clock has it: whole, shaking, sinking, or the cell it fell into.
  const crumbled = (c, t, ms) => {
    if (t?.at == null) return c
    const age = ms - t.at
    const { wobble, fall, beat, shake, sink } = CRUMBLE
    if (age < wobble) return { ...c, ch: pick(shake, Math.floor(age / beat)) }
    if (age < wobble + fall) return { ...c, ch: pick(sink, Math.floor((age - wobble) * sink.length / fall)), floor: false }
    return { ...c, ...c.crumbles, floor: false, name: 'fallen' }
  }
  // A layer: what it does to a cell's look, given `{ x, y, ms, c, light }`.
  const blank = (out) => out.ch === ' ' && !out.bg && !out.overhead
  const fold = {
    candle(out, { c }) {
      if (!c?.burns || spotsOf(c.burns.piece, 'seat').some((s) => occupied.has(key(c.burns.x + s.dx, c.burns.y + s.dy)))) return out
      return { ch: '.', fg: '#ffffff', bg: undefined }
    },
    weather(out, { x, y, ms, light }) {
      if (light !== 'lit' || !blank(out)) return out
      const drop = fallAt(weatherAt(ms), x, y, ms)
      return drop ? { ch: drop.ch, fg: drop.fg, bg: undefined } : out
    },
    steps(out, { x, y, ms, light }) {
      if (light !== 'lit' || !blank(out)) return out
      const t = steps.get(key(x, y))
      const left = t ? fadeOf(t, ms) : 0
      return left > 0 ? { ch: '.', fg: STEP_FG[Math.ceil(left * STEP_FG.length) - 1], bg: undefined } : out
    },
    scorch(out, { x, y, ms }) {
      if (blank(out)) return out
      const t = scorches.get(key(x, y))
      const left = t ? fadeOf(t, ms) : 0
      return left > 0 ? { ...out, ch: ',', fg: SCORCH_FG[Math.ceil(left * SCORCH_FG.length) - 1] } : out
    },
    sky(out, { x, y, ms }) {
      const night = nightAt(x, y, ms)
      return night && out.ch !== ' ' ? { ...out, fg: shade(out.fg ?? INK, night), bg: shade(out.bg, night) } : out
    },
    fog(out, { light }) {
      if (light === 'dark') return { ch: ' ', fg: undefined, bg: undefined }
      return light === 'dim' && out.ch !== ' ' ? { ...out, fg: dim(out.fg ?? INK), bg: dim(out.bg) } : out
    },
  }
  // The next time a trace in `traces` drops a third or goes; the gone are let go.
  const fadeTick = (traces, thirds, ms) => {
    let next = Infinity
    for (const [k, t] of traces) {
      if (t.until <= ms) { traces.delete(k); continue }
      const third = (t.until - t.at) / thirds
      const edge = t.until - (Math.ceil((t.until - ms) / third) - 1) * third
      next = Math.min(next, Math.max(50, Math.ceil(edge - ms)))
    }
    return next < Infinity ? [next] : []
  }
  // A layer's steps on the clock, in ms from `ms`: where `tickOf` wakes a screen.
  const ticks = {
    sky: () => [SKY_MS],
    weather(ms) {
      const kind = weatherAt(ms)
      // The edge of a spell is a step too: a screen with nothing else moving
      // would otherwise draw the rain up to a sky step late.
      const until = untilWeatherChange(ms)
      return [...(until < Infinity ? [Math.max(50, Math.min(SKY_MS, until))] : []), ...(FALL[kind] ? [FALL[kind].ms] : [])]
    },
    steps: (ms) => fadeTick(steps, STEP_FG.length, ms),
    scorch: (ms) => fadeTick(scorches, SCORCH_FG.length, ms),
  }

  const doorOf = (x, y, c) => ({ x, y, to: c.door, ...(c.hidden && { hidden: true }), ...(c.night && { night: true }) })

  const stage = {
    slug,
    palette,
    entryOf,
    /** The entries pieces bring for letters the scene's palette leaves out. */
    get defaults() { return Object.fromEntries(defaults) },
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
      tell()
    },

    /** Where the figure that sees stands, `{ x, y }`; null before a scene has said. */
    get seer() { return seer },

    /** Every light on the stage, `{ x, y, r }`. */
    get lights() { return lights },

    /** How this cell stands to the seer: `'lit'`, `'dim'` (lit once, not now) or `'dark'`; lit everywhere with no seer. */
    light(x, y) {
      if (!seer || !fog) return 'lit'
      const k = key(x, y)
      return visible.has(k) ? 'lit' : seen.has(k) ? 'dim' : 'dark'
    },

    /** Every figure's cell, `{ x, y }`: a piece's `burns` cell is lit while one of its seats is among them. A change redraws. */
    occupy(cells) {
      const next = new Set(cells.map((c) => key(c.x, c.y)))
      if (next.size === occupied.size && [...next].every((k) => occupied.has(k))) return
      const ms = now()
      // A cell stepped back onto while it still shakes holds; one already sinking is gone.
      for (const k of next) {
        if (!claims.get(k)?.crumbles) continue
        const t = crumbling.get(k)
        if (!t) crumbling.set(k, { at: null })
        else if (t.at != null && ms - t.at < CRUMBLE.wobble) t.at = null
      }
      for (const k of occupied) {
        const t = crumbling.get(k)
        if (t && t.at == null && !next.has(k)) t.at = ms
      }
      occupied = next
      tell()
    },

    /** A piece's cells, claimed at `x, y`; the mark moves or removes them. */
    stamp(piece, x, y) {
      adopt(piece)
      const cellsAt = (px, py) => piece.cells.map((c) => [px + c.dx, py + c.dy, { ch: c.ch, key: c.key, name: piece.name, floor: piece.floor || c.seat, overhead: c.overhead, burns: c.burns && mark, crumbles: piece.crumbles }])
      const lift = () => {
        for (const c of piece.cells) { claims.delete(key(mark.x + c.dx, mark.y + c.dy)); crumbling.delete(key(mark.x + c.dx, mark.y + c.dy)) }
      }
      const mark = {
        kind: 'piece', piece, x, y,
        /** A spot of the piece (`pieces/index.js`) as a cell of the stage. */
        spot(name) {
          const s = piece.spots?.[name]
          if (!s) throw new Error(`${piece.name} has no spot ${name}`)
          return { x: mark.x + s.dx, y: mark.y + s.dy }
        },
        move(nx, ny) {
          if (nx === mark.x && ny === mark.y) return
          lift()
          try { putAll(cellsAt(nx, ny)) }
          catch (e) { putAll(cellsAt(mark.x, mark.y)); throw e }
          mark.x = nx
          mark.y = ny
          changed()
        },
        remove() { lift(); drop(mark); readopt(); changed() },
      }
      try { putAll(cellsAt(x, y)) }
      catch (e) { readopt(); throw e }
      marks.push(mark)
      changed()
      return mark
    },

    /**
     * A door on a cell, replacing whatever is drawn there; stepping onto it
     * is `goto(to)`. With a size it is a run of door cells sharing one `to`
     * — a border along an edge (`IDEAS/haven.md` 6.2) — and one mark. A
     * hidden door keeps the glyph and paint under it, so nothing drawn says
     * it is there (6.5). A `night` door is a door only at full night
     * (`isNight`, 6.6): by day its cell is the one under it, drawn and
     * stepped against as that, so a door the clock shuts lets nobody through.
     */
    door(x, y, to, { w = 1, h = 1, hidden = false, night = false } = {}) {
      const under = new Map()   // 'x,y' → the cell the door replaced
      const each = (px, py, fn) => { for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) fn(px + dx, py + dy) }
      const put = (px, py) => each(px, py, (cx, cy) => {
        const was = claims.get(key(cx, cy)) ?? null
        under.set(key(cx, cy), was)
        const drawn = hidden ? { ch: was?.ch ?? ' ', key: was?.key ?? ' ' } : { ch: 'n', key: 'd' }
        claim(cx, cy, { ...drawn, name: 'door', floor: false, door: mark.to, hidden, ...(night && { night, day: was }) })
      })
      const lift = () => each(mark.x, mark.y, (cx, cy) => {
        const was = under.get(key(cx, cy))
        if (was) claims.set(key(cx, cy), was); else claims.delete(key(cx, cy))
      })
      const mark = {
        kind: 'door', x, y, to, w, h, hidden, night,
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

    /** Called after any claim, the view, the light or a footprint changes. */
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },

    /**
     * Run `fn(ms)` on this stage's clock until the returned function is
     * called: every frame, or with `every` once each `every` ms of the wall's
     * clock, in its `phase` (`simulate`, `light` or `paint` -- a paint task
     * runs only when the picture changed) and, with `after`, right after the
     * task of that key. A second task of one key replaces the first.
     */
    task(key, fn, { phase = 'simulate', every = 0, after } = {}) {
      if (!PHASES.includes(phase)) throw new Error(`[${slug}] no phase is called ${phase}; the phases are ${PHASES.join(', ')}`)
      const held = tasks.findIndex((t) => t.key === key)
      if (held !== -1) tasks.splice(held, 1)
      const t = { key, fn, phase, every, due: every ? (Math.floor(now() / every) + 1) * every : 0 }
      const before = after == null ? -1 : tasks.findIndex((o) => o.key === after)
      if (after != null && before === -1) throw new Error(`[${slug}] task ${key} is after ${after}, which is not a task`)
      // After its target and after anything already after that target.
      let i = before === -1 ? tasks.length : before + 1
      while (before !== -1 && i < tasks.length && tasks[i].after === after) i++
      t.after = after
      tasks.splice(i, 0, t)
      if (phase === 'paint') invalidate()
      else schedule()
      return () => {
        const at = tasks.indexOf(t)
        if (at === -1) return
        tasks.splice(at, 1)
        schedule()
      }
    },

    /** One frame at `ms`, as the clock would run it: what a `manual` stage is stepped with. */
    frame(ms) { frame(ms) },

    /** The ms of the frame last run: the clock a `manual` stage is at. */
    get now() { return now() },

    /** Redraw now — after the palette was edited in place. */
    touch() { changed() },

    /** The placements of this piece, found by the piece itself and never by its name. */
    placed(piece) {
      return marks.filter((m) => m.kind === 'piece' && m.piece === piece)
    },

    /**
     * The seat on this cell, or null: `{ mate, stand }`, the cell of the seat
     * across and the cell a figure stands on stepping back off this one. A
     * seat's mate is the seat it names.
     */
    seatAt(x, y) {
      for (const m of marks) {
        if (m.kind !== 'piece') continue
        const seat = spotsOf(m.piece, 'seat').find((s) => m.x + s.dx === x && m.y + s.dy === y)
        if (!seat) continue
        if (seat.solo) return null
        return { mate: m.spot(seat.mate), stand: { x: m.x + seat.stand.dx, y: m.y + seat.stand.dy } }
      }
      return null
    },

    /** The door on this cell `ms` into the clock, or null — a night door is none by day. */
    doorAt(x, y, ms = 0) {
      const c = cellAt(x, y, ms)
      return c?.door ? doorOf(x, y, c) : null
    },

    /** Every door, a night door whatever the clock, for a test that walks to each and for `arrival()`. */
    get doors() {
      const out = []
      for (const [k, c] of claims) if (c.door) { const [x, y] = k.split(',').map(Number); out.push(doorOf(x, y, c)) }
      return out
    },

    /** Whether a figure may stand on this cell. */
    walkable(x, y) {
      if (x < 0 || y < 0 || x >= width || y >= height) return false
      if ((shattered.get(key(x, y)) ?? 0) > now()) return true
      const c = claims.get(key(x, y))
      if (c?.crumbles && !cellAt(x, y, now()).floor) return false
      return !c || (!!(c.floor || c.overhead) && !c.door)
    },

    /**
     * How one cell looks `ms` into the clock: `{ ch, fg, bg }`, colors
     * undefined for the terminal's own, and `overhead` when the cell is drawn
     * above the figures. The cell's own glyph, cycled on the clock where it is
     * lit, folded through the layers this scene names.
     */
    look(x, y, ms = 0) {
      const light = stage.light(x, y)
      const c = cellAt(x, y, ms)
      const ch = c?.ch ?? ' '
      const style = c && c.key !== ' ' ? entryOf(c.key) : null
      const step = style?.ms && light === 'lit' ? stepOf(style, x, y, ms) : 0
      let out = style
        ? { ch: style.chars ? pick([...style.chars], step) : ch, fg: pick(style.fg, step), bg: pick(style.bg, step), ...(c.overhead && { overhead: true }) }
        : { ch, fg: undefined, bg: undefined, ...(c?.overhead && { overhead: true }) }
      const at = { x, y, ms, c, light }
      for (const name of LAYERS) if (has(name)) out = fold[name](out, at)
      return out
    },

    /**
     * The color a figure stepping onto this cell `ms` into the clock takes,
     * when its palette entry says `dye`, else null: the step `look()` draws,
     * before the sky, so a flower picked at night is its daytime color.
     */
    dyeAt(x, y, ms = 0) {
      const c = cellAt(x, y, ms)
      const style = c && c.key !== ' ' ? entryOf(c.key) : null
      if (!style?.dye) return null
      const step = style.ms && stage.light(x, y) === 'lit' ? stepOf(style, x, y, ms) : 0
      return pick(style.fg, step) ?? null
    },

    /** Lay footprints, `{ x, y, at, until }` on the clock `look()` is asked at; the newest on a cell is the one drawn. A change redraws. */
    tread(traces) {
      let laid = false
      for (const t of traces) {
        const k = key(t.x, t.y)
        if ((steps.get(k)?.at ?? -Infinity) >= t.at) continue
        steps.set(k, { at: t.at, until: t.until })
        laid = true
      }
      if (laid) tell()
    },

    /** Lay scorches, `{ x, y, at, until }` like footprints; the newest on a cell is the one drawn. */
    scorch(traces) {
      let laid = false
      for (const t of traces) {
        const k = key(t.x, t.y)
        if ((scorches.get(k)?.at ?? -Infinity) >= t.at) continue
        scorches.set(k, { at: t.at, until: t.until })
        laid = true
      }
      if (laid) tell()
    },

    /**
     * Break the pieces `traces` name, `{ id, until }` with an id as `world.js`
     * spells it: each solid cell of the piece draws as nothing and can be
     * stood on until `until`, then is the piece again. A piece this scene does
     * not place is ignored, since a trace outlives a deploy.
     */
    shatter(traces) {
      let broke = false
      for (const t of traces) {
        const m = marks.find((o) => o.kind === 'piece' && pieceId(o) === t.id)
        if (!m || !(t.until > now())) continue
        for (const c of m.piece.cells) {
          const k = key(m.x + c.dx, m.y + c.dy)
          const held = claims.get(k)
          if (!held || held.door || held.floor || held.overhead) continue
          shattered.set(k, Math.max(shattered.get(k) ?? 0, t.until))
          broke = true
        }
      }
      if (broke) changed()
    },

    /** `hex`, a pacer's color, as the sky leaves it at the cell `x, y` `ms` into the clock. */
    tint(hex, x, y, ms) {
      if (!has('sky')) return hex
      const night = nightAt(x, y, ms)
      return night ? shade(hex ?? INK, night) : hex
    },

    /** Whether this cell's glyph is changed by the clock. */
    cycles(x, y) {
      const c = claims.get(key(x, y))
      return !!(c && entryOf(c.key)?.chars)
    },

    /** The shortest step any cell, pacer or layer moves on `ms` into the clock, or 0 when none does. */
    tickOf(ms = Date.now()) {
      const steps = [...Object.values(palette), ...defaults.values(), ...pacers].map((s) => s.ms).filter(Boolean)
      for (const name of LAYERS) if (has(name) && ticks[name]) steps.push(...ticks[name](ms))
      // A scene with no sky has none to redraw on, and a night door in it
      // would open and shut unseen until something else moved.
      if (!has('sky') && [...claims.values()].some((c) => c.night)) steps.push(SKY_MS)
      // A cell that is shaking or sinking is drawn again every beat.
      for (const t of crumbling.values()) if (t.at != null && ms - t.at < CRUMBLE.wobble + CRUMBLE.fall) steps.push(CRUMBLE.beat)
      // A broken piece grows back on its own: the look is asked again at that ms.
      let grew = false
      for (const [k, until] of shattered) {
        if (until <= ms) { shattered.delete(k); grew = true; continue }
        steps.push(Math.max(50, Math.ceil(until - ms)))
      }
      if (grew) relight()
      return steps.length ? Math.min(...steps) : 0
    },

    /** The glyphs by day, one row per line — the picture `scenes/<name>.frame.txt` holds. */
    picture() {
      const rows = []
      for (let y = 0; y < height; y++) {
        let row = ''
        for (let x = 0; x < width; x++) row += cellAt(x, y, 0)?.ch ?? ' '
        rows.push(row)
      }
      return rows
    },
  }

  stages.set(slug, stage)
  return stage
}
