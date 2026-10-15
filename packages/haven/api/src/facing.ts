// api/src/facing.ts
// The way a figure faces (`IDEAS/haven.md` 9.4): the way it last stepped. A
// bolt flies it (9.5) and chalk lands behind it (9.8), so the server and the
// client must agree on it, and both import it from here as they do
// `hearing.ts`. It rides presence as one more key beside `{ x, y }`.

import type { Position } from './rooms.ts'

/** The four ways, as compass letters — one byte each in a presence frame capped at 64. */
export type Facing = 'n' | 'e' | 's' | 'w'

export const FACINGS: readonly Facing[] = ['n', 'e', 's', 'w']

/** One cell the way it names. `y` grows downward, as a scene's rows do. */
export const STEP: Record<Facing, { dx: number, dy: number }> = {
  n: { dx: 0, dy: -1 },
  e: { dx: 1, dy: 0 },
  s: { dx: 0, dy: 1 },
  w: { dx: -1, dy: 0 },
}

/** Where a figure faces before it has stepped. */
export const FIRST_FACING: Facing = 's'

export const isFacing = (v: unknown): v is Facing => typeof v === 'string' && (FACINGS as readonly string[]).includes(v)

/**
 * The way a step from `from` to `to` went, or null for no step. A door or a
 * knock-back moves a figure more than one cell, so the larger axis wins, and a
 * tie (never a walk, which is one axis at a time) goes to the row.
 */
export function facingOf (from: Position, to: Position): Facing | null {
  const dx = to.x - from.x, dy = to.y - from.y
  if (dx === 0 && dy === 0) return null
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'e' : 'w'
  return dy > 0 ? 's' : 'n'
}

/** The way opposite `f`. */
export const opposite = (f: Facing): Facing => FACINGS[(FACINGS.indexOf(f) + 2) % 4]

/** The cell `n` steps from `at` the way `f` names. */
export const ahead = (at: Position, f: Facing, n = 1): Position => ({ x: at.x + STEP[f].dx * n, y: at.y + STEP[f].dy * n })

/** The cell a figure just left — where its chalk goes. */
export const behind = (at: Position, f: Facing): Position => ahead(at, opposite(f))
