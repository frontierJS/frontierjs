// api/src/hearing.ts
// Who hears a line (`IDEAS/haven.md` 7.1, `FJS-D992`). The server filters a
// line's fan-out by the speaker's cell and each listener's, and the client
// asks the same question of the lines it loaded, so one rule lives here and
// both import it.
//
//   said      heard within EARSHOT of the speaker's cell
//   `!said`   a shout: heard by the whole room
//   whisper   a Message with a `toId` — not a distance at all. Who may read it
//             is the Message read policy, so the row is private in `find` as
//             well as in the fan-out.
//
// A cell is whole numbers, the same as a move (`rooms.ts`). A LISTENER with no
// cell is nowhere and nowhere hears nothing: a client that withholds its
// position must not be the one that hears the whole square. A SPEAKER with no
// cell is heard by the room, which is what a booth is (nobody there sends a
// cell) and costs a withholding client nothing it could not do with `!`.

import type { Position } from './rooms.ts'

/** How far a said line carries, in cells. A cell is about twice as tall as wide. */
export const EARSHOT = { x: 16, y: 6 } as const

/** A line that begins with this is a shout. */
export const SHOUT = '!'

export const isShout = (body: string): boolean => body.startsWith(SHOUT)

export type Cell = Partial<Position> | null | undefined

const known = (c: Cell): c is Position => Number.isInteger(c?.x) && Number.isInteger(c?.y)

/** Is `listener` within earshot of `speaker`. */
export function withinEarshot (speaker: Cell, listener: Cell): boolean {
  if (!known(speaker) || !known(listener)) return false
  return Math.abs(speaker.x - listener.x) <= EARSHOT.x && Math.abs(speaker.y - listener.y) <= EARSHOT.y
}

/**
 * Does a listener at `listener` hear a line said by someone standing at any of
 * `speaker` — one cell per connection the speaker holds. A whisper is graded
 * by the row's read policy before this is asked, so it hears as a shout does.
 */
export function hears (line: { body: string, toId?: number | null }, speaker: Cell[], listener: Cell): boolean {
  if (line.toId != null || isShout(line.body)) return true
  const placed = speaker.filter(known)
  return placed.length === 0 || placed.some(s => withinEarshot(s, listener))
}
