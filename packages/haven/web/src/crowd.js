// src/crowd.js — what the other figures in a room put on this screen: where
// each stands, who is drawn, the name under one within reach and the line over
// one that spoke. Pure over a presence snapshot (`here.get()`), a stage and the
// view, so `Scene.mesa`, `Bubbles.mesa` and `Nameplates.mesa` ask one rule and
// a test asks it without a terminal.
import { hears } from '../../api/src/hearing.ts'
import { spanOf } from '../../api/src/shape.ts'
import { bubble } from './booth.js'
import { cells } from './cells.js'

/** A member's cell from their presence meta; one with none stands at the spawn. */
export const cellOf = (m, spawn) => ({ x: m.meta?.x ?? spawn.x, y: m.meta?.y ?? spawn.y })

/** The cells a figure drawn as `shape` stands on at `c`: two for an emoji (14.4). */
export const standsOn = (c, shape) => (spanOf(shape) > 1 ? [c, { x: c.x + 1, y: c.y }] : [c])

/**
 * An emoji figure is drawn at WIDE_LAYER, over what is overhead rather than
 * under it: the terminal's overhead buffer is transparent, and a transparent
 * cell blended over the second cell of a wide glyph blanks the whole glyph.
 * So it walks behind a canopy by not being drawn while any cell it stands on
 * is overhead. A one-cell figure is covered by the canopy as before.
 */
export const WIDE_LAYER = 12

/** Whether a figure drawn as `shape` at `c` is wide and behind something overhead. */
export const covered = (stage, c, shape) =>
  spanOf(shape) > 1 && standsOn(c, shape).some((k) => stage.look(k.x, k.y, Date.now()).overhead)

export const inView = (c, v) => c.x >= v.x && c.x < v.x + v.w && c.y >= v.y && c.y < v.y + v.h

/** The other figures on screen and in the light, each at its cell of the view. */
export const figures = (h, v, stage, spawn) => h.others
  .filter((m) => inView(cellOf(m, spawn), v) && stage.light(cellOf(m, spawn).x, cellOf(m, spawn).y) === 'lit')
  .map((m) => ({ m, x: cellOf(m, spawn).x - v.x, y: cellOf(m, spawn).y - v.y }))

// How near a figure must be to wear its full nick on the row below it: the
// initial alone cannot tell two Sams apart. Below, because a bubble takes the
// row above. Under the figures' layer, so a name never hides one.
export const NEAR = { x: 4, y: 2 }

export const plates = (h, v, names, sx, sy, stage, spawn) => figures(h, v, stage, spawn)
  .filter((f) => names[f.m.userId] && Math.abs(cellOf(f.m, spawn).x - sx) <= NEAR.x && Math.abs(cellOf(f.m, spawn).y - sy) <= NEAR.y)
  .map((f) => {
    const text = names[f.m.userId]
    return { key: f.m.connectionId, text, x: Math.max(0, Math.min(f.x, v.w - cells(text))), y: Math.min(f.y + 1, v.h - 1) }
  })

// What hangs over a figure while its next line is coming: a member's while
// their line has words, an agent's while its model answers (`thinking`).
export const TYPING   = '…'
export const THINKING = 'thinking…'

// A bubble over a figure: at most `w` cells across and `rows` rows, the rest
// of a long line read in the history. Drawn in its own ink on its own ground,
// since in the art's ink on the art's ground a line reads as more of the
// picture, and one row across the whole view cuts through a wall. A line
// older than `freshMs` is drawn in `old`, so the one just said is the one
// that stands out; a speaker's nick with no ink of their own is `nick`.
export const BUBBLE = { w: 36, rows: 5, ink: '#f4f7fa', ground: '#2c4257', old: '#7d8b99', nick: '#9cc8f0', freshMs: 8000 }

// The cell between a bubble and its speaker, hung from the bubble's middle:
// with two figures under one bubble's width, it says which spoke.
export const TAIL = '╵'

/**
 * The newest line of each member standing here, over where they stand, in the
 * view's cells: `{ key, x, y, rows, ink, tail?, name?, until? }` — the bottom
 * row two rows over the speaker and the rest above it, `tail` the cell
 * between at the speaker's column (none where the bubble would leave the
 * top of the view). A speaker outside the view is their line pushed to the
 * edge they are past, its top row marked with the way to them, and no tail.
 *
 * The line opens with the speaker's nick (`names`) where the tail cannot say
 * whose it is: a speaker outside the view, or another figure within `NEAR` of
 * the speaker. `name` is that nick's cells and its ink, the speaker's dye.
 * A line said `freshMs` ago or more is in `BUBBLE.old`; `until` is when a
 * fresh one turns, for the screen's timer. A line with no `createdAt` is fresh.
 *
 * A speaker's `meta.hushed` is the newest line they cleared (`/hush`); `mine`
 * is this figure's own, which the scene holds. That line and any before it
 * draw nothing, and no older line takes its place. Another member typing or
 * thinking within earshot has `TYPING` or `THINKING` there instead of their
 * line, since the next one is what they are on.
 */
export function bubbles(h, said, sx, sy, v, spawn, { mine = null, names = {}, now = Date.now() } = {}) {
  const me = h.self?.userId
  const where = new Map(h.others.map((m) => [String(m.userId), cellOf(m, spawn)]))
  const hushed = new Map(h.others.map((m) => [String(m.userId), m.meta?.hushed ?? 0]))
  const inks = new Map(h.others.map((m) => [String(m.userId), m.meta?.ink]))
  if (me != null) { where.set(String(me), { x: sx, y: sy }); hushed.set(String(me), mine ?? 0) }
  const crowded = (who, at) => [...where].some(([id, c]) => id !== who && id !== String(me)
    && Math.abs(c.x - at.x) <= NEAR.x && Math.abs(c.y - at.y) <= NEAR.y)
  const out = []
  const seen = new Set()
  const place = (key, who, at, words, until = null) => {
    const way = inView(at, v) ? null
      : at.x >= v.x + v.w ? '>'
      : at.x < v.x        ? '<'
      : at.y < v.y        ? '^'
      :                     'v'
    const nick = who !== String(me) && names[who] && (way || crowded(who, at)) ? `${names[who]}:` : null
    let rows = bubble(nick ? `${nick} ${words}` : words, Math.min(BUBBLE.w, v.w - (way ? 1 : 0)), { gap: '', most: BUBBLE.rows })
    if (way === '>') rows = rows.map((r, i) => `${r}${i === 0 ? way : ' '}`)
    else if (way)    rows = rows.map((r, i) => `${i === 0 ? way : ' '}${r}`)
    const fx = at.x - v.x
    const fy = at.y - v.y
    const hung = !way && fy - 1 - rows.length >= 0
    const bx = Math.max(0, Math.min(fx, v.w - cells(rows[0])))
    const by = Math.max(0, Math.min(fy - rows.length - (hung ? 1 : 0), v.h - rows.length))
    const ink = until != null && until <= now ? BUBBLE.old : BUBBLE.ink
    const b = { key, x: bx, y: by, rows, ink }
    if (hung) b.tail = { x: fx, y: fy - 1 }
    const lead = (way && way !== '>' ? 1 : 0) + 1
    if (nick && rows[0].startsWith(nick, lead)) {
      b.name = { x: bx + lead, y: by, text: nick, ink: ink === BUBBLE.old ? ink : inks.get(who) ?? BUBBLE.nick }
    }
    if (until != null && until > now) b.until = until
    out.push(b)
  }
  for (const m of h.others) {
    const busy = m.meta?.thinking ? THINKING : m.meta?.typing ? TYPING : null
    const who  = String(m.userId)
    if (!busy || seen.has(who)) continue
    const at = where.get(who)
    if (!hears({ body: '' }, [at], { x: sx, y: sy })) continue
    seen.add(who)
    place(`${who}:busy`, who, at, busy)
  }
  for (const line of said ?? []) {
    const who = String(line.memberId)
    if (seen.has(who) || !where.has(who)) continue
    seen.add(who)
    if (line.id <= hushed.get(who)) continue
    const at = where.get(who)
    if (!hears(line, [at], { x: sx, y: sy })) continue
    const when = Date.parse(line.createdAt)
    place(`${who}:${line.id}`, who, at, line.toId != null ? `psst: ${line.body}` : line.body, Number.isNaN(when) ? null : when + BUBBLE.freshMs)
  }
  return out
}
