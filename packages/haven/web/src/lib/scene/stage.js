// src/stage.js — a scene's cells, claimed by the pieces placed on it
// (`FJS-D997`). `Scene.mesa` makes one and provides it as `$context.scene`;
// `<Piece>`, `<Row>`, `<Door>`, `<Pacer>` and `<Carousel>` write to it; `#paint` draws it;
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
// the screen's size at most — the terminal's, which `#paint` tells `fit()`
// (14.6), else VIEW — following the figure a scene tells it to with EDGE
// cells of slack in proportion, so it pans only when the figure nears an
// edge. It lives on the stage, so a pan or a resize tells the listeners and
// redraws like a moved piece and `#paint` has one subscription; a stage no
// bigger than the screen never pans. The editor asks for the whole stage instead.
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
// A scene with a `sight` is pitch dark: a figure sees only that radius round
// itself, and every figure standing in it sees as far, so the others are seen
// by their own. Sight is not a light -- it stops at a wall -- or a figure
// beyond a rock would light the gallery behind it.
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
//            cell under a canopy takes none. A storm adds clouds along the top
//            and a bolt on the blank cells down to the first thing it strikes;
//            a tree it strikes burns, then stands charred, then grows back.
//   steps    a footprint (7.4) on a blank cell somebody stood on in the last
//            few minutes, fading in thirds; a drop falls in front of it.
//   ground   what the weather left (7.10, `groundAt`): puddles and a snow
//            cover on blank lit cells, fewer as each dries or thaws; a drop
//            and a footprint are in front of it.
//   scorch   a bolt's `,` (9.5) on the wall it struck, fading in thirds; it
//            replaces the wall's glyph, since a wall is not blank.
//   sky      the night (7.2): every color but a light source's is shaded
//            toward moonlight, more under a full moon and less under a new
//            one (7.9), and a cell inside a light's radius keeps half the
//            day. Through full night the moon's glyph crosses MOON_ROW east
//            to west on a blank cell, so a roof, a cloud or a drop hides it.
//            The fog's SIGHT does not shrink at night.
//   lamplight a light's pool, whatever the sky: the cells within a light's
//            radius take its warm tint, strongest at the source and pulsing
//            with it -- the hearth warming a room that has no night. `#paint`
//            blooms a stage that names it.
//   fog      a cell lit once and not now is dim, one never lit is blank (6.3).
//
// Every layer is drawn by `look()`, so the figures, which are boxes a layer
// up, walk in front of all of them, and the two targets cannot disagree about
// which cell has a drop or a footprint.

import { pacerAt, pacerNow, pick } from '#shared/pacer.ts'
import { ridersAt } from '#shared/carousel.ts'
import { almanacAt, SEASONS, skyDarkness, isNight, shade, MOON_FG, SKY_MS, hash, fallAt, untilWeatherChange, FALL, STRIKE_MS, BURN_MS, CHAR_MS, FIRE_MS, strikeAt, flashAt, cloudAt, groundOn } from '#shared/sky.js'
import { fadeOf } from '#shared/memory.ts'
import { held } from '../sky/held.js'
import { pieceId } from './world.js'
import { spotsOf } from '../../pieces/index.js'

export { pacerAt }

/** Every stage made in this process, by slug — for a test or a drive to read. */
export const stages = new Map()

/** What this screen's figure wears from scene to scene: the `ink` a `dye` cell gave it, and whether its pet is out. */
export const worn = { ink: null, pet: false }

// A lamp's glow: the cells within a light's radius take a warm tint, strongest
// at the bulb and fading to the edge, scaled by how bright the bulb is this
// step (its palette color's luminance) and by how dark the sky is. A cell has
// no background of its own, and a terminal cannot blend with the one it has, so
// a tint is over NIGHT_BG: Haven's night, which is what the screen shows.
const WARM = [251, 191, 36]
const NIGHT_BG = '#122738'
const GLOW_BG = 0.3      // the most of WARM a background takes
const GLOW_FG = 0.55     // the most of WARM a glyph's color takes
const LAMP_BG = 0.16     // the same two, for a light's pool by day (`lamplight`)
const LAMP_FG = 0.35
const PULSE_LOW = 0.55   // a bulb at its dimmest still glows this much
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
const lum = (hex) => { const [r, g, b] = rgb(hex); return 0.3 * r + 0.59 * g + 0.11 * b }
const warmed = new Map()
/** `hex` (NIGHT_BG when none) moved `t` of the way to the lamp's amber. */
const warm = (hex, t) => {
  const k = hex + '/' + t
  let w = warmed.get(k)
  if (!w) {
    const from = rgb(hex ?? NIGHT_BG)
    w = '#' + from.map((v, i) => Math.round(v + (WARM[i] - v) * t).toString(16).padStart(2, '0')).join('')
    warmed.set(k, w)
  }
  return w
}

const stepOf = (style, x, y, ms) => {
  const tick = Math.floor(ms / style.ms)
  return style.flicker ? hash(tick, x, y) : style.wave ? tick + x + y : tick
}

/** The color of a glyph its palette does not color — the terminal's own ink. */
export const INK = '#c8c8c8'

/** A cell with nothing drawn on it: a `drawing()` layer's hole, shared, so never written to. */
const BLANK = Object.freeze({ ch: ' ', fg: undefined, bg: undefined })

const dims = new Map()
/** `hex` at two fifths of its light: what a remembered cell is drawn in. */
export const dim = (hex) => {
  if (!hex) return hex
  let d = dims.get(hex)
  if (!d) dims.set(hex, d = '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * 0.4).toString(16).padStart(2, '0')).join(''))
  return d
}

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]]

// The widest a stage may be: a cell's key is `y * STRIDE + x`.
const STRIDE = 4096

/** The phases of a frame, in order. */
export const PHASES = ['simulate', 'light', 'paint']

/** Every layer `look()` folds, in the order it folds them. */
export const LAYERS = ['candle', 'weather', 'steps', 'ground', 'scorch', 'sky', 'lamplight', 'fog']

/**
 * What a scene out of doors names when it names nothing. Not the fog: with
 * it off every cell is lit for every figure, and `seer` is still kept, since
 * a worker is read off where the figure stands. Name `fog` to bring it back.
 */
export const OUTDOORS = ['candle', 'weather', 'steps', 'ground', 'scorch', 'sky']

/** Under a roof: no sky, no weather and nothing it left. */
export const INDOORS = ['candle', 'steps', 'scorch']

/** The sky's row: the first inside a scene's top wall, where the moon crosses. */
export const MOON_ROW = 1

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
 * Whether a figure at `from` sees `cell` within `r` with a clear line. An
 * opaque cell is also seen when a floor cell beside it is: a line skimming
 * along a hedge meets the hedge's own nearer cells first, and a wall seen
 * that way would show two cells of it.
 */
function sees(stage, from, cell, r) {
  if (!within(from, cell, r)) return false
  if (clear(stage, from, cell)) return true
  return !stage.walkable(cell.x, cell.y) && STEPS.some(([dx, dy]) => {
    const n = { x: cell.x + dx, y: cell.y + dy }
    return stage.walkable(n.x, n.y) && within(from, n, r) && clear(stage, from, n)
  })
}

/**
 * Whether the cell `x, y` of `stage` is lit for a figure standing at `from`:
 * within SIGHT of it with a clear line (the scene's `sight` in a dark
 * scene), within another figure's sight there, or within the radius of
 * a light. Everything is lit for no figure.
 */
export function litAt(stage, x, y, from) {
  if (!from) return true
  const cell = { x, y }
  const r = stage.sight || SIGHT
  if (sees(stage, from, cell, r)) return true
  if (stage.sighted.some((l) => sees(stage, l, cell, r))) return true
  return stage.lights.some((l) => within(l, cell, l.r))
}

/**
 * What a terminal shows that is not the art: the shell's scrollbar column
 * and two spare, and the status, input and mode lines under it. Taken off
 * less than this, the input line is scrolled off the bottom of the screen.
 */
const CHROME = { w: 3, h: 4 }

/** The most cells a terminal of `cols` × `rows` shows of a scene (14.6). */
export function viewFor(cols, rows) {
  return { w: Math.max(1, cols - CHROME.w), h: Math.max(1, rows - CHROME.h) }
}

/**
 * The most cells a screen shows where its size is not known: `--frame`'s
 * and a drive's 100×30, so a test and a drive read the numbers they always
 * have. A drive that wants another size states its pty's.
 */
export const VIEW = viewFor(100, 30)

/** How near an edge the followed figure may come before a VIEW-sized view pans. */
export const EDGE = { x: 8, y: 4 }

/**
 * EDGE in proportion to a view of `size`, so a zoomed-out terminal keeps as
 * much of the scene ahead of the figure as VIEW does, and a small one is not
 * all slack.
 */
export function edgeFor(size) {
  return { x: Math.round(EDGE.x * size.w / VIEW.w), y: Math.round(EDGE.y * size.h / VIEW.h) }
}

/**
 * Where the view sits once a figure at `fig` is followed from `view`:
 * `size` cells (VIEW unless a screen said its own) or the extent where that
 * is smaller, the figure kept `edgeFor(size)` cells from each edge, and the
 * view kept inside the extent. A figure already inside the slack leaves the
 * view where it is.
 */
export function follow(view, fig, extent, size = VIEW) {
  const axis = (at, span, f, edge, whole) => {
    let v = at
    if (f - v < edge) v = f - edge
    if (v + span - 1 - f < edge) v = f + edge - span + 1
    return Math.max(0, Math.min(v, whole - span))
  }
  const edge = edgeFor(size)
  const w = Math.min(size.w, extent.width)
  const h = Math.min(size.h, extent.height)
  return { x: axis(view.x, w, fig.x, edge.x, extent.width), y: axis(view.y, h, fig.y, edge.y, extent.height), w, h }
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
 * @param {{ slug: string, palette?: object, spawn: { x: number, y: number }, season?: string }} o
 */
export function createStage({ slug, palette = {}, spawn, layers = OUTDOORS, sight = 0, manual = false, season = almanacAt(Date.now(), held).season }) {
  for (const l of layers) if (!LAYERS.includes(l)) throw new Error(`[${slug}] no layer is called ${l}; the layers are ${LAYERS.join(', ')}`)
  const has  = (name) => layers.includes(name)
  const fog  = has('fog')
  if (sight && !fog) throw new Error(`[${slug}] a dark scene's sight works only under the fog; name the fog layer`)
  const claims    = new Map()   // key(x, y) → { ch, key, name, floor, overhead, door, hidden }
  const pacers    = []
  const carousels = []
  const marks     = []          // every placed thing, in the order it was placed
  const listeners = new Set()
  let width = 0, height = 0
  let eye   = { x: 0, y: 0 }   // the view's top-left
  let fig   = null             // the figure followed, re-followed when the extent or the screen changes
  let size  = VIEW             // the most cells the screen shows, until `fit` says its own
  let whole = false
  let view  = { x: 0, y: 0, w: 0, h: 0 }   // `stage.view`, replaced only when it moves
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
    for (const m of marks) if (m.kind === 'piece') adopt(m.drawn); else if (m.kind === 'carousel') adopt(m.piece)
  }
  let lights  = null           // every cell whose palette entry has a light, with its radius; made at first use, dropped by relight
  let visible = new Set()      // key(x, y) lit for the seer now
  let seen    = new Set()      // key(x, y) lit for the seer at any time
  let occupied = new Set()     // key(x, y) a figure stands on, for what burns only while a seat is taken
  let carried  = []            // every figure's cell, each seeing `sight` round it, in a dark scene
  let burnSeats = null         // key(x, y) of every seat a `burns` cell waits on, made at the first occupy and dropped by relight
  let glow    = null           // key(x, y) → [{ l, f }], each light whose radius holds the cell and how near it is (0..1); made at the first night look, dropped by relight
  let steps   = new Map()      // key(x, y) → { at, until }, the newest footprint on the cell
  let scorches = new Map()     // key(x, y) → { at, until }, the newest scorch on the cell
  let crumbling = new Map()    // key(x, y) → { at }, a `crumbles` cell a figure has stood on: `at` is when it was left, null while it is stood on
  let spooked   = new Map()    // a pacer's name → { at, until, dir }, the bolt that scared it out of the scene and when it walks in again
  let shattered = new Map()    // key(x, y) → until, a solid cell of a piece a bolt broke, on the clock `look()` is asked at
  const tasks = []             // { key, fn, phase, every, due }, in the order each phase runs them
  let framing = false          // inside a frame: a change marks it dirty and the frame paints it
  let dirty   = true
  let lookDue = -Infinity      // when the look next changes on its own
  const bolts = new Map()      // window n → { cells: key(x, y) → glyph, hit: the tree mark struck or null }, geometry only; the weather it struck in is asked at use
  let treeCells = null         // key(x, y) → the tree mark owning that cell, made at the first storm look and dropped by relight
  let last    = 0              // the ms of the last frame, which is now for a stage stepped by hand
  let timer   = null

  // A cell's key is a number, read back by `xOf`/`yOf`: a paint asks a dozen
  // maps per cell, and a string built per ask was a fifth of a paint.
  const key = (x, y) => y * STRIDE + x
  const xOf = (k) => k % STRIDE
  const yOf = (k) => Math.floor(k / STRIDE)
  // The extent follows the claims by a count per column and row, so placing
  // or taking away a piece costs its own cells and never a sweep of the stage.
  const perCol = [], perRow = []
  let nights = 0               // claims that are a night door, which an indoor stage redraws for on the sky's step
  const settle = (k, cell) => {
    const was = claims.get(k)
    if (was?.night) nights--
    if (cell.night) nights++
    if (!was) {
      const x = xOf(k), y = yOf(k)
      perCol[x] = (perCol[x] ?? 0) + 1
      perRow[y] = (perRow[y] ?? 0) + 1
      if (x + 1 > width) width = x + 1
      if (y + 1 > height) height = y + 1
    }
    claims.set(k, cell)
  }
  const unclaim = (k) => {
    const was = claims.get(k)
    if (!was) return
    claims.delete(k)
    if (was.night) nights--
    perCol[xOf(k)]--
    perRow[yOf(k)]--
    while (width && !perCol[width - 1]) width--
    while (height && !perRow[height - 1]) height--
  }
  // What the claims light: the sources, and everything made from the claims,
  // each at first use. A step moves no claim, so it runs none of this.
  const lightUp = () => {
    lights = null
    glow = null
    burnSeats = null
    bolts.clear()
    treeCells = null
  }
  const lightsOf = () => {
    if (lights) return lights
    lights = []
    for (const [k, c] of claims) {
      const r = entryOf(c.key)?.light
      if (!r) continue
      lights.push({ x: xOf(k), y: yOf(k), r })
    }
    return lights
  }
  // What the seer sees: a sweep of the whole stage, so only under the fog.
  const fogUp = () => {
    if (!seer || !fog) return
    visible = new Set()
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (litAt(stage, x, y, seer)) { const k = key(x, y); visible.add(k); seen.add(k) }
    }
  }
  const relight = () => { lightUp(); fogUp() }
  // Every light's pool: key(x, y) → each light holding the cell and how near it is.
  const glowMap = () => {
    if (glow) return glow
    glow = new Map()
    for (const l of lightsOf()) {
      const rx = 2 * l.r
      for (let dy = -l.r; dy <= l.r; dy++) for (let dx = -rx; dx <= rx; dx++) {
        // Left of 0 a key would name a cell at the end of the row above.
        if (l.x + dx < 0 || l.y + dy < 0 || !within({ x: 0, y: 0 }, { x: dx, y: dy }, l.r)) continue
        const k = key(l.x + dx, l.y + dy)
        const near = (1 - Math.sqrt((dx / 2) ** 2 + dy ** 2) / l.r) ** 1.5
        if (glow.has(k)) glow.get(k).push({ l, f: near })
        else glow.set(k, [{ l, f: near }])
      }
    }
    return glow
  }
  // How dark a cell is under a sky `d` dark: 0 by day or with no sky, 0 on a
  // light source, half the sky inside a light's radius.
  const nightAt = (x, y, d) => {
    if (!d) return 0
    const k = key(x, y)
    if (entryOf(claims.get(k)?.key)?.light) return 0
    return glowMap().has(k) ? d / 2 : d
  }
  // How bright a bulb is at `ms`, PULSE_LOW..1: where its palette color is
  // between its dimmest and its brightest, so a flickering bulb and its glow
  // are the one thing.
  // A pool's cells ask the same bulb the same ms by the hundred, so a bulb is worked out once per ms.
  let pulses = { ms: NaN, of: new Map() }
  const pulseOf = (l, ms) => {
    if (pulses.ms !== ms) pulses = { ms, of: new Map() }
    let p = pulses.of.get(l)
    if (p === undefined) pulses.of.set(l, p = pulseNow(l, ms))
    return p
  }
  const pulseNow = (l, ms) => {
    const style = entryOf(claims.get(key(l.x, l.y))?.key)
    if (!Array.isArray(style?.fg) || !style.ms) return 1
    const range = style.fg.map(lum)
    const lo = Math.min(...range), hi = Math.max(...range)
    if (hi === lo) return 1
    return PULSE_LOW + (1 - PULSE_LOW) * (lum(pick(style.fg, stepOf(style, l.x, l.y, ms))) - lo) / (hi - lo)
  }
  // The strongest glow on a cell, in eighths so a tint is one of a few colors.
  const glowAt = (x, y, ms) => {
    let s = 0
    for (const { l, f } of glowMap().get(key(x, y)) ?? []) s = Math.max(s, f * pulseOf(l, ms))
    return Math.round(s * 8) / 8
  }
  // A painter that fails must not fail the claim it was told about: the
  // stage is right and the picture is late, which the next tick repairs.
  const changed = () => {
    if (fig) eye = follow({ ...eye }, fig, { width, height }, size)
    relight()
    tell()
  }
  // A piece taken away redraws a microtask later, once for every piece taken
  // that turn: a scene torn down takes all of them, and by then its paint is
  // gone. Its cells, its palette entries and its lights go at once.
  let settling = false
  const removed = () => {
    lightUp()
    if (settling) return
    settling = true
    queueMicrotask(() => { settling = false; changed() })
  }
  // A painter that fails must not fail the claim it was told about either.
  const notify = () => {
    for (const fn of listeners) { try { fn() } catch (e) { console.error(e) } }
  }
  const tell = () => { notify(); invalidate() }

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
      // With nobody to paint, the picture stays dirty for the first painter,
      // and a scene mounting asks no tick per piece it places.
      const painted = tasks.some((t) => t.phase === 'paint')
      for (const phase of PHASES) {
        if (phase === 'simulate' && !simulate) continue
        if (phase === 'paint' && (!dirty || !painted)) continue
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
    if (x < 0 || y < 0 || x >= STRIDE) throw new Error(`[${slug}] cell ${x},${y} of ${cell.name} is off the stage, which starts at 0,0 and is under ${STRIDE} wide`)
    const held = claims.get(key(x, y))
    if (held && !cell.door) {
      throw new Error(`[${slug}] cell ${x},${y} is claimed by both ${held.name} and ${cell.name}`)
    }
    settle(key(x, y), cell)
  }

  // A piece's cells are claimed all or none: a claim refused midway is
  // taken back before the error leaves, so a refused move leaves the piece
  // where it was.
  const putAll = (cells) => {
    const done = []
    try {
      for (const [x, y, cell] of cells) { claim(x, y, cell); done.push([x, y]) }
    } catch (e) {
      for (const [x, y] of done) unclaim(key(x, y))
      throw e
    }
  }

  // The claim on a cell as the clock has it: a night door by day is the cell it replaced.
  const cellAt = (x, y, ms) => cellOf(key(x, y), ms)
  const cellOf = (k, ms) => {
    if ((shattered.get(k) ?? 0) > ms) return undefined
    const c = claims.get(k)
    if (c?.crumbles) return crumbled(c, crumbling.get(k), ms)
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
  // ─── storm ──────────────────────────────────────────────────────────────
  // A strike is the clock's (`strikeAt`), so every screen has the same one; the
  // stage turns its seed into a column, and says what it hit from its own claims.
  const isTree = (m) => m.kind === 'piece' && m.piece.name === 'tree'
  const treeOwner = (x, y) => {
    if (!treeCells) {
      treeCells = new Map()
      for (const m of marks) if (isTree(m)) for (const c of m.drawn.cells) treeCells.set(key(m.x + c.dx, m.y + c.dy), m)
    }
    return treeCells.get(key(x, y))
  }
  // Rows 1 and down: row 0 is a framed scene's wall. Half the strikes are aimed
  // at a tree -- through the roof of the house above it, since the trees stand
  // in front of houses -- so a bolt with a tree to find does find one on screen.
  const boltOf = (n) => {
    let b = bolts.get(n)
    if (b) return b
    const s = strikeAt(n)
    const cells = new Map()
    let hit = null
    if (s && width && height > 1) {
      const jag = (y) => (hash(n, y, 13) % 3) - 1
      const trees = marks.filter(isTree)
      let x = s.seed % width
      let aim = null
      if (trees.length && hash(n, 3, 4) % 2 === 0) {
        const t = trees[hash(n, 6, 8) % trees.length]
        const top = Math.min(...t.drawn.cells.map((c) => c.dy))
        const tops = t.drawn.cells.filter((c) => c.dy === top)
        const c = tops[s.seed % tops.length]
        aim = { x: t.x + c.dx, y: t.y + c.dy, mark: t }
        let drift = 0
        for (let y = 1; y < aim.y; y++) drift += jag(y)
        x = aim.x - drift
      }
      x = Math.max(0, Math.min(width - 1, x))
      for (let y = 1; y < height; y++) {
        if (aim ? y === aim.y : claims.has(key(x, y)) && (claims.get(key(x, y)).ch !== ' ' || claims.get(key(x, y)).overhead)) {
          hit = aim ? aim.mark : (claims.get(key(x, y)).name === 'tree' ? treeOwner(x, y) : null)
          break
        }
        const dx = jag(y)
        cells.set(key(x, y), dx < 0 ? '/' : dx > 0 ? '\\' : '|')
        x = Math.max(0, Math.min(width - 1, x + dx))
      }
    }
    b = { cells, hit }
    bolts.set(n, b)
    return b
  }
  // Milliseconds since a bolt last struck tree `m` in a storm, or Infinity.
  const sinceStruck = (m, ms) => {
    const last = Math.floor(ms / STRIKE_MS)
    for (let n = last; n >= last - Math.ceil((BURN_MS + CHAR_MS) / STRIKE_MS); n--) {
      const s = strikeAt(n)
      if (s && s.at <= ms && boltOf(n).hit === m && almanacAt(s.at, held).weather === 'storm') return ms - s.at
    }
    return Infinity
  }
  const blazing = (ms) => marks.some((m) => isTree(m) && sinceStruck(m, ms) < BURN_MS)
  // A struck tree's cell: flames across its canopy, then ash-dark until it grows back.
  const burnt = (out, { x, y, ms, sky }) => {
    const m = treeOwner(x, y)
    if (!m || out.ch === ' ') return out
    let age = sky.struck.get(m)
    if (age === undefined) sky.struck.set(m, age = sinceStruck(m, ms))
    if (age >= BURN_MS + CHAR_MS) return out
    if (age >= BURN_MS) return { ...out, fg: '#3f3f46' }
    if (!out.overhead) return { ...out, fg: '#44403c' }
    const f = hash(Math.floor(ms / FIRE_MS), x, y) % 4
    return f === 3 ? { ...out, fg: '#7c2d12' } : { ...out, ch: f === 2 ? '"' : '^', fg: ['#ef4444', '#f97316', '#fde047'][f] }
  }
  // The column the moon stands over on MOON_ROW, rising inside the east wall and setting inside the west.
  const moonX = (arc) => width - 2 - Math.round(arc * (width - 3))
  // What every cell of one paint asks the clock, asked once: the almanac and
  // what follows from it, and each struck tree's age as its cells ask it.
  // Made per `look()` or per `grid()`, never kept by ms: a `hold()` between
  // two paints at one ms would draw the weather it replaced.
  const outdoors = has('weather') || has('ground') || has('sky')
  const skyAt = (ms) => {
    if (!outdoors) return { struck: new Map() }
    const almanac = almanacAt(ms, held)
    const flash = almanac.weather === 'storm' && flashAt(ms, held)
    const { moon } = almanac
    return {
      almanac,
      dark:  has('sky') ? skyDarkness(ms, held) : 0,
      bolt:  flash ? boltOf(Math.floor(ms / STRIKE_MS)).cells : null,
      moonX: moon.ch && moon.arc !== null ? moonX(moon.arc) : -1,
      struck: new Map(),
    }
  }
  // A layer: what it does to a cell's look, given `{ x, y, k, ms, c, light, sky }`.
  const blank = (out) => out.ch === ' ' && !out.bg && !out.overhead
  const fold = {
    candle(out, { c }) {
      if (!c?.burns || spotsOf(c.burns.piece, 'seat').some((s) => occupied.has(key(c.burns.x + s.dx, c.burns.y + s.dy)))) return out
      return { ch: '.', fg: '#ffffff', bg: undefined }
    },
    weather(out, at) {
      const { x, y, ms, sky } = at
      if (at.c?.name === 'tree') out = burnt(out, at)
      if (sky.bolt) {
        const bolt = sky.bolt.get(at.k)
        if (bolt) return { ch: bolt, fg: '#fef9c3', bg: undefined }
      }
      if (at.light !== 'lit' || !blank(out)) return out
      const { weather: kind, wind } = sky.almanac
      const cloud = kind === 'storm' ? cloudAt(x, y, ms, wind) : null
      if (cloud) return { ch: cloud.ch, fg: cloud.fg, bg: undefined }
      const drop = fallAt(kind, x, y, ms, wind)
      return drop ? { ch: drop.ch, fg: drop.fg, bg: undefined } : out
    },
    steps(out, { k, ms, light }) {
      if (light !== 'lit' || !blank(out)) return out
      const t = steps.get(k)
      const left = t ? fadeOf(t, ms) : 0
      return left > 0 ? { ch: '.', fg: STEP_FG[Math.ceil(left * STEP_FG.length) - 1], bg: undefined } : out
    },
    ground(out, { x, y, light, sky }) {
      if (light !== 'lit' || !blank(out)) return out
      const g = groundOn(x, y, sky.almanac.ground)
      return g ? { ch: g.ch, fg: g.fg, bg: undefined } : out
    },
    scorch(out, { k, ms }) {
      if (blank(out)) return out
      const t = scorches.get(k)
      const left = t ? fadeOf(t, ms) : 0
      return left > 0 ? { ...out, ch: ',', fg: SCORCH_FG[Math.ceil(left * SCORCH_FG.length) - 1] } : out
    },
    sky(out, { x, y, k, ms, light, sky }) {
      const d = sky.dark
      const night = nightAt(x, y, d)
      if (!night) {
        // The bulb is not shaded, but it sits in the middle of its own glow.
        const s = d && entryOf(claims.get(k)?.key)?.light ? glowAt(x, y, ms) * d : 0
        return s ? { ...out, bg: warm(out.bg, GLOW_BG * s) } : out
      }
      const { moon } = sky.almanac
      if (y === MOON_ROW && x === sky.moonX && light === 'lit' && blank(out)) return { ch: moon.ch, fg: MOON_FG, bg: undefined }
      const dark = out.ch !== ' ' ? { ...out, fg: shade(out.fg ?? INK, night, moon.light), bg: shade(out.bg, night, moon.light) } : out
      const s = glowAt(x, y, ms) * night
      if (!s) return dark
      return { ...dark, fg: dark.ch === ' ' ? dark.fg : warm(dark.fg ?? INK, GLOW_FG * s), bg: warm(dark.bg, GLOW_BG * s) }
    },
    lamplight(out, { x, y, ms }) {
      const s = glowAt(x, y, ms)
      if (!s) return out
      return { ...out, fg: out.ch === ' ' ? out.fg : warm(out.fg ?? INK, LAMP_FG * s), bg: warm(out.bg, LAMP_BG * s) }
    },
    fog(out, { light }) {
      if (light === 'dark') return { ch: ' ', fg: undefined, bg: undefined }
      return light === 'dim' && out.ch !== ' ' ? { ...out, fg: dim(out.fg ?? INK), bg: dim(out.bg) } : out
    },
  }
  // The folds this scene names, in `LAYERS` order: a cell asks only these.
  const folds = LAYERS.filter(has).map((name) => fold[name])
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
    // On the clock's own SKY_MS steps, where the moon moves and the night turns, not SKY_MS after whenever this paint was.
    sky: (ms) => [Math.max(50, SKY_MS - (((ms % SKY_MS) + SKY_MS) % SKY_MS))],
    // The ground changes only on those steps, so it waits for them as the sky does.
    ground: (ms) => [Math.max(50, SKY_MS - (((ms % SKY_MS) + SKY_MS) % SKY_MS))],
    weather(ms) {
      const kind = almanacAt(ms, held).weather
      // The edge of a spell is a step too: a screen with nothing else moving
      // would otherwise draw the rain up to a sky step late.
      const until = untilWeatherChange(ms, held)
      return [...(until < Infinity ? [Math.max(50, Math.min(SKY_MS, until))] : []), ...(FALL[kind] ? [FALL[kind].ms] : []), ...(blazing(ms) ? [FIRE_MS] : [])]
    },
    steps: (ms) => fadeTick(steps, STEP_FG.length, ms),
    scorch: (ms) => fadeTick(scorches, SCORCH_FG.length, ms),
  }

  // One cell's look, `at` its `{ x, y, k, ms, sky }` and the rest filled in
  // here: its own glyph, cycled on the clock where it is lit, through the folds.
  const lookAt = (at) => {
    const { x, y, k, ms } = at
    const light = at.light = stage.light(x, y)
    const c = at.c = cellOf(k, ms)
    const ch = c?.ch ?? ' '
    const style = c && c.key !== ' ' ? entryOf(c.key) : null
    const step = style?.ms && light === 'lit' ? stepOf(style, x, y, ms) : 0
    let out = style
      ? { ch: style.chars ? pick([...style.chars], step) : ch, fg: pick(style.fg, step), bg: pick(style.bg, step), ...(c.overhead && { overhead: true }) }
      : { ch, fg: undefined, bg: undefined, ...(c?.overhead && { overhead: true }) }
    for (const f of folds) out = f(out, at)
    return out
  }

  const doorOf = (x, y, c) => ({ x, y, to: c.door, ...(c.hidden && { hidden: true }), ...(c.night && { night: true }) })

  const stage = {
    slug,
    layers,
    palette,
    entryOf,
    /** The entries pieces bring for letters the scene's palette leaves out. */
    get defaults() { return Object.fromEntries(defaults) },
    spawn,
    pacers,
    carousels,
    marks,
    get width()  { return width },
    get height() { return height },

    /** The slice a screen draws: `{ x, y, w, h }` in the stage's cells. */
    // One object until the slice moves: a screen re-renders what a new object reaches, and every other member's step tells.
    get view() {
      const x = whole ? 0 : eye.x, y = whole ? 0 : eye.y
      const w = whole ? width : Math.min(size.w, width), h = whole ? height : Math.min(size.h, height)
      if (view.x !== x || view.y !== y || view.w !== w || view.h !== h) view = { x, y, w, h }
      return view
    },

    /** The most cells the screen shows (`viewFor`); the figure is followed again, so a resize keeps it on screen. */
    get size() { return size },
    fit({ w, h }) {
      if (w === size.w && h === size.h) return
      size = { w, h }
      if (fig) eye = follow({ ...eye }, fig, { width, height }, size)
      tell()
    },

    /** Keep this figure on screen; a pan redraws. The figure is kept, so a piece mounting later pans too. */
    follow(x, y) {
      fig = { x, y }
      const next = follow(stage.view, fig, { width, height }, size)
      if (next.x === eye.x && next.y === eye.y) return
      eye = { x: next.x, y: next.y }
      tell()
    },

    /** The whole stage as the view, for the editor's preview. */
    showAll() { whole = true; changed() },

    /** This figure sees from here: what it lights now is lit, what it lit once is dim, the rest dark. A step redraws under the fog; without it no cell's look moves. */
    see(x, y) {
      seer = { x, y }
      if (!fog) return notify()
      fogUp()
      tell()
    },

    /** Where the figure that sees stands, `{ x, y }`; null before a scene has said. */
    get seer() { return seer },

    /** Every light on the stage, `{ x, y, r }`. */
    get lights() { return lightsOf() },

    /** How far a figure sees in a dark scene, 0 in a scene that is not dark. */
    sight,

    /** The cells a figure sees from in a dark scene, `{ x, y }`; none in a scene that is not dark. */
    get sighted() { return carried },

    /** How this cell stands to the seer: `'lit'`, `'dim'` (lit once, not now) or `'dark'`; lit everywhere with no seer. */
    light(x, y) {
      if (!seer || !fog) return 'lit'
      const k = key(x, y)
      return visible.has(k) ? 'lit' : seen.has(k) ? 'dim' : 'dark'
    },

    /** Every figure's cell, `{ x, y }`: a piece's `burns` cell is lit while one of its seats is among them. A candle lit or put out, or a plank set shaking or held, redraws; nothing else a figure stands on is drawn by the stage. */
    occupy(cells) {
      const next = new Set(cells.map((c) => key(c.x, c.y)))
      if (next.size === occupied.size && [...next].every((k) => occupied.has(k))) return
      const ms = now()
      let moved = false
      // A cell stepped back onto while it still shakes holds; one already sinking is gone.
      for (const k of next) {
        if (!claims.get(k)?.crumbles) continue
        const t = crumbling.get(k)
        if (!t) crumbling.set(k, { at: null })
        else if (t.at != null && ms - t.at < CRUMBLE.wobble) { t.at = null; moved = true }
      }
      for (const k of occupied) {
        const t = crumbling.get(k)
        if (t && t.at == null && !next.has(k)) { t.at = ms; moved = true }
      }
      if (!burnSeats) {
        burnSeats = new Set()
        for (const c of claims.values()) {
          if (c.burns) for (const s of spotsOf(c.burns.piece, 'seat')) burnSeats.add(key(c.burns.x + s.dx, c.burns.y + s.dy))
        }
      }
      if (!moved) for (const k of burnSeats) if (next.has(k) !== occupied.has(k)) { moved = true; break }
      occupied = next
      if (sight) {
        carried = [...next].map((k) => ({ x: xOf(k), y: yOf(k) }))
        fogUp()
        return tell()
      }
      if (moved) invalidate()
    },

    /** A piece's cells, claimed at `x, y`; the mark moves or removes them. */
    stamp(piece, x, y) {
      const inSeason = (s) => piece.seasons?.[s] ?? piece
      adopt(inSeason(season))
      const cellsAt = (px, py, drawn = mark.drawn) => drawn.cells.map((c) => [px + c.dx, py + c.dy, { ch: c.ch, key: c.key, name: piece.name, floor: drawn.floor || c.seat, overhead: c.overhead, burns: c.burns && mark, crumbles: piece.crumbles }])
      const lift = () => {
        for (const c of mark.drawn.cells) { unclaim(key(mark.x + c.dx, mark.y + c.dy)); crumbling.delete(key(mark.x + c.dx, mark.y + c.dy)) }
      }
      const mark = {
        kind: 'piece', piece, x, y,
        /** What is drawn: the piece in the stage's season, or the piece itself. */
        drawn: inSeason(season),
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
        remove() { lift(); drop(mark); readopt(); removed() },
        /** The piece as it looks in season `s`. */
        looks: inSeason,
        /** Give up the cells of what is drawn. */
        release: lift,
        /** Claim the cells of `next` and draw it; a cell another piece holds refuses it, claiming nothing. */
        show(next) {
          putAll(cellsAt(mark.x, mark.y, next))
          mark.drawn = next
        },
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
      const under = new Map()   // key(x, y) → the cell the door replaced
      const each = (px, py, fn) => { for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) fn(px + dx, py + dy) }
      const put = (px, py) => each(px, py, (cx, cy) => {
        const was = claims.get(key(cx, cy)) ?? null
        under.set(key(cx, cy), was)
        const drawn = hidden ? { ch: was?.ch ?? ' ', key: was?.key ?? ' ' } : { ch: 'n', key: 'd' }
        claim(cx, cy, { ...drawn, name: 'door', floor: false, door: mark.to, hidden, ...(night && { night, day: was }) })
      })
      const lift = () => each(mark.x, mark.y, (cx, cy) => {
        const was = under.get(key(cx, cy))
        if (was) settle(key(cx, cy), was); else unclaim(key(cx, cy))
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
        remove() { lift(); drop(mark); removed() },
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
        remove() { const i = pacers.indexOf(spec); if (i !== -1) pacers.splice(i, 1); drop(mark); removed() },
      }
      marks.push(mark)
      changed()
      return mark
    },

    /**
     * Targets riding a loop on the clock (`shared/carousel.ts`): `of` is the
     * rider's piece, and the lane between the housings is claimed as a wall a
     * figure cannot step into, blank but for a chain down each column's middle
     * in the paint letter `rail`. The riders are drawn over it like a pacer.
     */
    carousel({ name, of, x, apart, top, bottom, ms, n, rail }) {
      adopt(of)
      const spec = { name, x, apart, top, bottom, ms, n, rail, cells: of.cells.map((c) => [c.dx, c.dy]) }
      const w = Math.max(...of.cells.map((c) => c.dx)) + 1, mid = Math.floor(w / 2)
      const laneAt = (lx, top, bottom) => {
        const out = []
        for (let y = top; y <= bottom; y++) {
          for (let dx = 0; dx < apart + w; dx++) {
            const chain = dx === mid || dx === apart + mid
            out.push([lx + dx, y, { ch: chain ? '¦' : ' ', key: chain ? rail : ' ', name }])
          }
        }
        return out
      }
      const lift = () => { for (const [lx, ly] of laneAt(spec.x, spec.top, spec.bottom)) unclaim(key(lx, ly)) }
      try { putAll(laneAt(x, top, bottom)) }
      catch (e) { readopt(); throw e }
      carousels.push(spec)
      const mark = {
        kind: 'carousel', spec, piece: of,
        get x() { return spec.x }, get y() { return spec.top },
        /** The lane's cells, for the editor to find it by. */
        get cells() { return laneAt(spec.x, spec.top, spec.bottom).map(([cx, cy]) => ({ x: cx, y: cy })) },
        /** The lane moved whole, its column at `nx` and its top row at `ny`. */
        move(nx, ny) {
          if (nx === spec.x && ny === spec.top) return
          const h = spec.bottom - spec.top
          lift()
          try { putAll(laneAt(nx, ny, ny + h)) }
          catch (e) { putAll(laneAt(spec.x, spec.top, spec.bottom)); throw e }
          spec.x = nx
          spec.top = ny
          spec.bottom = ny + h
          changed()
        },
        remove() {
          lift()
          const i = carousels.indexOf(spec); if (i !== -1) carousels.splice(i, 1)
          drop(mark); readopt(); removed()
        },
      }
      marks.push(mark)
      changed()
      return mark
    },

    /** Every rider's cell showing between its carousel's housings `ms` into the clock, `{ x, y, ch, fg }`. */
    riders(ms) {
      const out = []
      for (const m of marks) {
        if (m.kind !== 'carousel') continue
        const { spec, piece: of } = m
        for (const r of ridersAt(spec, ms)) {
          for (const c of of.cells) {
            const y = r.y + c.dy
            if (y >= spec.top && y <= spec.bottom) out.push({ x: r.x + c.dx, y, ch: c.ch, fg: pick(entryOf(c.key)?.fg, 0) })
          }
        }
      }
      return out
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

    /** The season the stage's pieces are drawn in (`SEASONS`). */
    get season() { return season },

    /**
     * Every piece that names its `seasons` drawn as it is in `s`. All or
     * none: a piece whose new look would land on another's cell refuses the
     * whole turn, naming the cell, and the stage stays in its season.
     */
    toSeason(s) {
      if (!SEASONS.includes(s)) throw new Error(`no season is called ${s}; the seasons are ${SEASONS.join(', ')}`)
      // Every look that changes gives up its cells before any takes new ones,
      // so a piece may take a cell another is leaving (the pond's ice and the
      // hole in it).
      const turning = marks.filter((m) => m.kind === 'piece' && m.piece.seasons && m.looks(s) !== m.drawn)
      const was = turning.map((m) => m.drawn)
      for (const m of turning) m.release()
      const shown = []
      try {
        for (const m of turning) { m.show(m.looks(s)); shown.push(m) }
      } catch (e) {
        for (const m of shown) m.release()
        turning.forEach((m, i) => m.show(was[i]))
        throw e
      }
      season = s
      readopt()
      changed()
    },

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
      for (const [k, c] of claims) if (c.door) out.push(doorOf(xOf(k), yOf(k), c))
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
      return lookAt({ x, y, k: key(x, y), ms, c: null, light: null, sky: skyAt(ms) })
    },

    /**
     * Every cell of `view` (`{ x, y, w, h }`) `ms` into the clock, as rows of
     * what `look()` answers: what a paint draws. The clock is asked once for
     * the whole of it, where `look()` asks it per cell.
     */
    grid(view, ms = 0) {
      const at = { x: 0, y: 0, k: 0, ms, c: null, light: null, sky: skyAt(ms) }
      const rows = new Array(view.h)
      for (let r = 0; r < view.h; r++) {
        const row = rows[r] = new Array(view.w)
        at.y = view.y + r
        for (let col = 0; col < view.w; col++) {
          at.x = view.x + col
          at.k = key(at.x, at.y)
          row[col] = lookAt(at)
        }
      }
      return rows
    },

    /**
     * What a paint draws of `view` `ms` into the clock, in two layers of
     * `grid()`'s shape: `art` under the figures, with each lit pacer and
     * rider over it, and `top`, the `overhead` cells, above them — so a cat
     * walks behind a canopy as a figure does. A pacer's spaces and a pacer on
     * a cell the seer cannot see are not drawn: the art shows through, its
     * `bg` kept under the pacer.
     */
    drawing(view, ms = 0) {
      const art = stage.grid(view, ms), top = new Array(view.h)
      for (let r = 0; r < view.h; r++) {
        const row = art[r], high = top[r] = new Array(view.w)
        for (let col = 0; col < view.w; col++) {
          if (row[col].overhead) { high[col] = row[col]; row[col] = BLANK }
          else high[col] = BLANK
        }
      }
      const over = (x, y, ch, fg) => {
        const cell = art[y - view.y]?.[x - view.x]
        if (cell && ch !== ' ' && stage.light(x, y) === 'lit') art[y - view.y][x - view.x] = { ch, fg: stage.tint(fg, x, y, ms), bg: cell.bg }
      }
      for (const p of pacers) {
        const at = stage.pacerNow(p, ms)
        if (at) [...at.text].forEach((ch, i) => over(at.x + i, at.y, ch, p.fg))
      }
      for (const { x, y, ch, fg } of stage.riders(ms)) over(x, y, ch, fg)
      return { art, top }
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
     * stood on until `until`, then is the piece again. A pickup lifted is the
     * same, its floor cells drawn as nothing. A piece this scene does
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
          if (!held || held.door || (held.floor && !m.piece.pickup) || held.overhead) continue
          shattered.set(k, Math.max(shattered.get(k) ?? 0, t.until))
          broke = true
        }
      }
      if (broke) changed()
    },

    /**
     * Scare the pacers `traces` name (`{ id, at, until, dir }`, the id a pacer's
     * name): each runs out of the scene from where it was at `at`, `dir` away from the bolt, and walks
     * in again at `until`. One this scene does not have, or that does not
     * flee, is ignored, since a trace outlives a deploy.
     */
    spook(traces) {
      let scared = false
      for (const t of traces) {
        if (!pacers.some((p) => p.name === t.id && p.flee) || !(t.until > now())) continue
        spooked.set(t.id, { at: t.at, until: t.until, dir: t.dir })
        scared = true
      }
      if (scared) changed()
    },

    /** Where a pacer is `ms` into the clock, or null once a bolt has run it out of the scene. */
    pacerNow(p, ms) {
      const s = spooked.get(p.name)
      return pacerNow(p, ms, s && s.until > ms ? { at: s.at, dir: s.dir, width } : undefined)
    },

    /** Whether a pacer stands on the cell `x, y` `ms` into the clock: a figure may not step onto it. */
    pacerOn(x, y, ms) {
      return pacers.some((p) => {
        const at = this.pacerNow(p, ms)
        return at && at.y === y && x >= at.x && x < at.x + at.text.length
      })
    },

    /** `hex`, a pacer's color, as the sky leaves it at the cell `x, y` `ms` into the clock. */
    tint(hex, x, y, ms) {
      if (!has('sky')) return hex
      const night = nightAt(x, y, skyDarkness(ms, held))
      return night ? shade(hex ?? INK, night, almanacAt(ms, held).moon.light) : hex
    },

    /** Whether this cell's glyph is changed by the clock. */
    cycles(x, y) {
      const c = claims.get(key(x, y))
      return !!(c && entryOf(c.key)?.chars)
    },

    /** The shortest step any cell, pacer, carousel or layer moves on `ms` into the clock, or 0 when none does. */
    tickOf(ms = Date.now()) {
      const steps = [...Object.values(palette), ...defaults.values(), ...pacers, ...carousels].map((s) => s.ms).filter(Boolean)
      for (const name of LAYERS) if (has(name) && ticks[name]) steps.push(...ticks[name](ms))
      // A scene with no sky has none to redraw on, and a night door in it
      // would open and shut unseen until something else moved.
      if (!has('sky') && nights) steps.push(SKY_MS)
      // A cell that is shaking or sinking is drawn again every beat.
      for (const t of crumbling.values()) if (t.at != null && ms - t.at < CRUMBLE.wobble + CRUMBLE.fall) steps.push(CRUMBLE.beat)
      // A scared pacer is on the move every `flee` ms until it is out of sight or walks in again.
      for (const [name, s] of spooked) {
        if (s.until <= ms) { spooked.delete(name); continue }
        const p = pacers.find((o) => o.name === name)
        if (p && pacerNow(p, ms, { at: s.at, dir: s.dir, width })) steps.push(p.flee)
      }
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

    /** The ink of each cell of `picture()` by day, a hex or '' — the map's colors, folded through no layer. */
    inks() {
      const rows = []
      for (let y = 0; y < height; y++) {
        const row = []
        for (let x = 0; x < width; x++) {
          const c = cellAt(x, y, 0)
          row.push((c && c.key !== ' ' ? pick(entryOf(c.key)?.fg, 0) : '') || '')
        }
        rows.push(row)
      }
      return rows
    },
  }

  stages.set(slug, stage)
  return stage
}
