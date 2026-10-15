// src/crowd.js — what the other figures in a room put on this screen: where
// each stands, who is drawn, the name under one within reach and the line over
// one that spoke. Pure over a presence snapshot (`here.get()`), a stage and the
// view, so `Scene.mesa`, `Bubbles.mesa` and `Nameplates.mesa` ask one rule and
// a test asks it without a terminal.
import { hears } from '../../api/src/hearing.ts'
import { spanOf } from '../../api/src/shape.ts'
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
export const TYPING   = '(…)'
export const THINKING = '(thinking…)'

/**
 * The newest line of each member standing here, over where they stand, in the
 * view's cells. A speaker outside the view is their line pushed to the edge
 * they are past, marked with the way to them. A speaker's `meta.hushed` is the
 * newest line they cleared (`/hush`); `mine` is this figure's own, which the
 * scene holds. That line and any before it draw nothing, and no older line
 * takes its place. Another member typing or thinking within earshot has
 * `TYPING` or `THINKING` there instead of their line, since the next one is
 * what they are on.
 */
export function bubbles(h, said, sx, sy, v, spawn, mine = null) {
  const me = h.self?.userId
  const where = new Map(h.others.map((m) => [String(m.userId), cellOf(m, spawn)]))
  const hushed = new Map(h.others.map((m) => [String(m.userId), m.meta?.hushed ?? 0]))
  if (me != null) { where.set(String(me), { x: sx, y: sy }); hushed.set(String(me), mine ?? 0) }
  const out = []
  const seen = new Set()
  const place = (key, at, text) => {
    if (!inView(at, v)) {
      if (at.x >= v.x + v.w) text = `${text}>`
      else if (at.x < v.x)   text = `<${text}`
      else if (at.y < v.y)   text = `^${text}`
      else                   text = `v${text}`
    }
    const bx = Math.max(0, Math.min(at.x - v.x, v.w - cells(text)))
    const by = Math.max(0, Math.min(at.y - v.y - 1, v.h - 1))
    out.push({ key, x: bx, y: by, text })
  }
  for (const m of h.others) {
    const busy = m.meta?.thinking ? THINKING : m.meta?.typing ? TYPING : null
    const who  = String(m.userId)
    if (!busy || seen.has(who)) continue
    const at = where.get(who)
    if (!hears({ body: '' }, [at], { x: sx, y: sy })) continue
    seen.add(who)
    place(`${who}:busy`, at, busy)
  }
  for (const line of said ?? []) {
    const who = String(line.memberId)
    if (seen.has(who) || !where.has(who)) continue
    seen.add(who)
    if (line.id <= hushed.get(who)) continue
    const at = where.get(who)
    if (!hears(line, [at], { x: sx, y: sy })) continue
    place(`${who}:${line.id}`, at, line.toId != null ? `(psst: ${line.body})` : `(${line.body})`)
  }
  return out
}
