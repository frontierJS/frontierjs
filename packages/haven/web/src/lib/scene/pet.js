// pet.js — a member's pet (`IDEAS/haven.md` 8.2): which one it is, and where it
// stands. Only `pet: true` rides presence; the place is never sent. Every
// screen walks a pet from the cells it sees its member's figure on, so two
// screens agree from the figure's next step, and one that saw no step yet --
// a joiner, a door, a knock-back -- puts it beside the figure.
import { behind, FACINGS, FIRST_FACING, STEP } from '../../../../api/src/facing.ts'
import { stepped } from '../../../../api/src/memory.ts'

// None is a letter: a figure is its initial, and sitting its lower case.
export const PETS = [
  { kind: 'dog',   ch: 'ö' },
  { kind: 'cat',   ch: 'ɷ' },
  { kind: 'snail', ch: '&' },
  { kind: 'mouse', ch: 'ε' },
]

/** The pet a member has, the same on every screen and every visit: chosen by its id. */
export function petOf(id) {
  let h = 0
  for (const c of String(id)) h = (h * 31 + c.codePointAt(0)) >>> 0
  return PETS[h % PETS.length]
}

/**
 * The trail `{ at, pet }` after the figure is seen at `at`: on a step the pet
 * takes the cell the figure left; standing still it stays; otherwise it is
 * behind the figure, else on whichever neighbor `free(x, y)` allows first,
 * else nowhere (null) until the next step.
 */
export function trail(was, at, facing, free) {
  if (was && was.at.x === at.x && was.at.y === at.y) return was
  if (was && stepped(was.at, at)) return { at, pet: was.at }
  const back = behind(at, facing ?? FIRST_FACING)
  const near = [back, ...FACINGS.map((f) => ({ x: at.x + STEP[f].dx, y: at.y + STEP[f].dy }))]
  return { at, pet: near.find((c) => free(c.x, c.y)) ?? null }
}
