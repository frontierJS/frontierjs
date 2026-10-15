// api/src/pacer.ts
// Where a pacer is on the shared clock (`web/src/stage.js` draws it, `world.ts`
// says what a bolt hits). The sprite walks a row back and forth, so its cell is
// a function of the wall clock alone and no screen is told where it is; the
// server asks the same function, which is why this is not in `web/`.

/** What a scene says of a pacer: a row, the columns it walks between, and its frames. */
export interface PacerSpec {
  y: number, from: number, to: number, ms: number, rest: number
  right: string[], left: string[], sit: string[]
}

export const pick = <T>(v: T | T[], i: number): T => (Array.isArray(v) ? v[i % v.length] : v)

/**
 * Where a pacer is `ms` into the clock: `{ x, y, text }`, `x` the sprite's
 * left edge. It walks right from `from` until its sprite ends on `to`, sits
 * `rest` steps, walks back, and sits again; `sit` frames are kept against the
 * end it walked to.
 */
export function pacerAt (p: PacerSpec, ms = 0): { x: number, y: number, text: string } {
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
