// api/src/pacer.ts
// Where a pacer is on the shared clock (`web/src/stage.js` draws it, `world.ts`
// says what a bolt hits). The sprite walks a row back and forth, so its cell is
// a function of the wall clock alone and no screen is told where it is; the
// server asks the same function, which is why this is not in `web/`.

import { isNight, skyIs } from '../../web/src/sky.js'

/** What a scene says of a pacer: a row, the columns it walks between, and its frames. */
export interface PacerSpec {
  y: number, from: number, to: number, ms: number, rest: number
  right: string[], left: string[], sit: string[]
  /** ms a cell when a bolt has scared it; a pacer without it holds its ground. */
  flee?: number
  /** Whether it is there only at night (`true`) or only by day (`false`), by 6.6's `isNight`; absent, always. */
  night?: boolean
  /** A sky it keeps to, named in `SKIES` (`sky.js`): the white stag on a full-moon night in snow. Absent, any. */
  sky?: string
}

/**
 * When a bolt scared a pacer (the trace's `at`), the way it runs (`dir`, away
 * from the shooter; absent, the way it was facing) and how wide its scene is,
 * which is where it runs out.
 */
export interface Spooked { at: number, width: number, dir?: 1 | -1 }

export const pick = <T>(v: T | T[], i: number): T => (Array.isArray(v) ? v[i % v.length] : v)

/**
 * Where a pacer is `ms` into the clock: `{ x, y, text }`, `x` the sprite's
 * left edge. It walks right from `from` until its sprite ends on `to`, sits
 * `rest` steps, walks back, and sits again; `sit` frames are kept against the
 * end it walked to.
 */
export function pacerAt (p: PacerSpec, ms = 0): { x: number, y: number, text: string, dir: 1 | -1 } {
  const width = p.right[0].length
  const span  = p.to - p.from + 1 - width
  const leg   = span + p.rest
  const step  = Math.floor(ms / p.ms)
  const t     = step % (2 * leg)
  const out   = t < leg
  const k     = out ? t : t - leg
  const dir = out ? 1 : -1
  if (k < span) return { x: out ? p.from + k : p.from + span - k, y: p.y, text: pick(out ? p.right : p.left, step), dir }
  const text = pick(p.sit, k - span)
  return { x: out ? p.from + span + width - text.length : p.from, y: p.y, text, dir }
}

/**
 * `pacerAt`, or where a scared one is: from the cell it was on when the bolt
 * landed, away from where the bolt came from, a cell every `flee` ms, until it reaches the
 * scene's frame and is gone (`null`); `null` too outside its hours or its sky. Still a function of the clock and the
 * trace's `at`, so every screen and the server agree without being told.
 */
export function pacerNow (p: PacerSpec, ms = 0, spooked?: Spooked): { x: number, y: number, text: string } | null {
  if (p.night != null && p.night !== isNight(ms)) return null
  if (p.sky && !skyIs(p.sky, ms)) return null
  if (!spooked || !p.flee || ms < spooked.at) return pacerAt(p, ms)
  const from = pacerAt(p, spooked.at)
  const k = Math.floor((ms - spooked.at) / p.flee)
  const dir = spooked.dir ?? from.dir
  const x = from.x + dir * (k + 1)
  const text = pick(dir > 0 ? p.right : p.left, k)
  if (x < 2 || x + text.length > spooked.width - 2) return null
  return { x, y: p.y, text }
}
