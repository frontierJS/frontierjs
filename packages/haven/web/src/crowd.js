// src/crowd.js — what the other figures in a room put on this screen: where
// each stands, who is drawn, the name under one within reach and the line over
// one that spoke. Pure over a presence snapshot (`here.get()`), a stage and the
// view, so `Scene.mesa`, `Bubbles.mesa` and `Nameplates.mesa` ask one rule and
// a test asks it without a terminal.
import { hears } from '../../api/src/hearing.ts'

/** A member's cell from their presence meta; one with none stands at the spawn. */
export const cellOf = (m, spawn) => ({ x: m.meta?.x ?? spawn.x, y: m.meta?.y ?? spawn.y })

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
    return { key: f.m.connectionId, text, x: Math.max(0, Math.min(f.x, v.w - text.length)), y: Math.min(f.y + 1, v.h - 1) }
  })

/**
 * The newest line of each member standing here, over where they stand, in the
 * view's cells. A speaker outside the view is their line pushed to the edge
 * they are past, marked with the way to them.
 */
export function bubbles(h, said, sx, sy, v, spawn) {
  const me = h.self?.userId
  const where = new Map(h.others.map((m) => [String(m.userId), cellOf(m, spawn)]))
  if (me != null) where.set(String(me), { x: sx, y: sy })
  const out = []
  const seen = new Set()
  for (const line of said ?? []) {
    const who = String(line.memberId)
    if (seen.has(who) || !where.has(who)) continue
    seen.add(who)
    const at = where.get(who)
    if (!hears(line, [at], { x: sx, y: sy })) continue
    let text = line.toId != null ? `(psst: ${line.body})` : `(${line.body})`
    if (!inView(at, v)) {
      if (at.x >= v.x + v.w) text = `${text}>`
      else if (at.x < v.x)   text = `<${text}`
      else if (at.y < v.y)   text = `^${text}`
      else                   text = `v${text}`
    }
    const bx = Math.max(0, Math.min(at.x - v.x, v.w - text.length))
    const by = Math.max(0, Math.min(at.y - v.y - 1, v.h - 1))
    out.push({ key: `${who}:${line.id}`, x: bx, y: by, text })
  }
  return out
}
