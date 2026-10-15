// api/test/bolt.test.ts
// A bolt (`IDEAS/haven.md` 9.5) and the facing it flies (9.4), over a world
// drawn as text so each case reads as the room it is: `#` a wall, `P` a piece,
// `c` the cat, a letter a member (its id the letter's place in `MEMBERS`), and
// `@` the shooter. A member is knocked back and never removed, and every
// refusal sits beside the same move admitted.

import { test, expect, describe } from 'bun:test'

import { BOLT_MS, KNOCK, RANGE, VOLLEY_MS, createCooldowns, crosses, fly, knockBack, volley, type Figure, type World } from '../src/bolt.ts'
import { FIRST_FACING, ahead, behind, facingOf, isFacing, opposite } from '../src/facing.ts'
import { SHAPE_MS, glyphOf } from '../src/shape.ts'

const MEMBERS = 'abcdefghijklmnopqrstuvwxyz'
const SHOOTER = 0

function world (rows: string[]): { world: World, me: Figure } {
  const members: Figure[] = []
  let me: Figure | null = null
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch === '@') { me = { id: SHOOTER, x, y }; members.push(me) }
    else if (/[a-z]/.test(ch) && ch !== 'c') members.push({ id: MEMBERS.indexOf(ch) + 1, x, y })
  }))
  const at = (x: number, y: number) => {
    const ch = rows[y]?.[x]
    if (ch == null || ch === '#') return { kind: 'wall' as const }
    if (ch === 'P') return { kind: 'piece' as const, id: `piece@${x},${y}` }
    if (ch === 'c') return { kind: 'pacer' as const, id: 'cat' }
    return null
  }
  if (!me) throw new Error('a world needs an @')
  return { world: { at, members }, me }
}

describe('facing', () => {
  test('is the way a figure last stepped, the larger axis for a jump, and nothing for no step', () => {
    expect(facingOf({ x: 5, y: 5 }, { x: 6, y: 5 })).toBe('e')
    expect(facingOf({ x: 5, y: 5 }, { x: 4, y: 5 })).toBe('w')
    expect(facingOf({ x: 5, y: 5 }, { x: 5, y: 4 })).toBe('n')
    expect(facingOf({ x: 5, y: 5 }, { x: 5, y: 6 })).toBe('s')
    expect(facingOf({ x: 5, y: 5 }, { x: 9, y: 4 })).toBe('e')
    expect(facingOf({ x: 5, y: 5 }, { x: 5, y: 5 })).toBeNull()
  })

  test('ahead, behind and the opposite way', () => {
    expect(ahead({ x: 5, y: 5 }, 'e', 3)).toEqual({ x: 8, y: 5 })
    expect(behind({ x: 5, y: 5 }, 'n')).toEqual({ x: 5, y: 6 })
    expect(['n', 'e', 's', 'w'].map(f => opposite(f as any))).toEqual(['s', 'w', 'n', 'e'])
  })

  test('only the four compass letters are a facing', () => {
    expect(isFacing(FIRST_FACING)).toBe(true)
    expect(['left', 'N', '', null, 1].some(isFacing)).toBe(false)
  })
})

describe('a glyph a stranger may draw', () => {
  test('is one printable ASCII character, never a space, a control byte or a wide glyph', () => {
    expect(['T', 'x', '>', '~', '!'].map(glyphOf)).toEqual(['T', 'x', '>', '~', '!'])
    expect([' ', '\x1b', '\x7f', 'TT', '', 'é', '木', '🙂', null, 7].map(glyphOf)).toEqual(Array(10).fill(null))
  })

  test('a shapeshift lasts a minute', () => {
    expect(SHAPE_MS).toBe(60_000)
  })
})

describe('a bolt', () => {
  test('flies its range over open floor and hits nothing', () => {
    const { world: w, me } = world(['@............'])
    const f = fly(w, me, 'e')
    expect(f.hit).toBeNull()
    expect(f.path.length).toBe(RANGE)
    expect(f.path.at(-1)).toEqual({ x: RANGE, y: 0 })
  })

  test('stops at a wall, short of it, and says where it struck', () => {
    const { world: w, me } = world(['@...#....'])
    const f = fly(w, me, 'e')
    expect(f.hit).toEqual({ kind: 'wall', at: { x: 4, y: 0 } })
    expect(f.path).toEqual([{ x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }])
  })

  test('names the piece and the pacer it struck, for the screens that draw them', () => {
    const { world: w, me } = world(['..P..', '.....', 'c.@..'])
    expect(fly(w, me, 'n').hit).toEqual({ kind: 'piece', id: 'piece@2,0', at: { x: 2, y: 0 } })
    expect(fly(w, me, 'w').hit).toEqual({ kind: 'pacer', id: 'cat', at: { x: 0, y: 2 } })
  })

  test('the edge of the scene is a wall', () => {
    const { world: w, me } = world(['@..'])
    expect(fly(w, me, 'w').hit).toEqual({ kind: 'wall', at: { x: -1, y: 0 } })
    expect(fly(w, me, 'w').path).toEqual([])
  })

  test('knocks a member back two cells the way it flew, and the member is still in the room', () => {
    const { world: w, me } = world(['@..a.........'])
    const f = fly(w, me, 'e')
    expect(f.hit).toEqual({ kind: 'member', id: 1, at: { x: 3, y: 0 }, to: { x: 3 + KNOCK, y: 0 } })
    expect(f.path.at(-1)).toEqual({ x: 3, y: 0 })
    expect(w.members.map(m => m.id)).toEqual([SHOOTER, 1])
  })

  test('a knock-back stops short of a wall and of another figure, and never moves through one', () => {
    expect((fly(world(['@.a#']).world, world(['@.a#']).me, 'e').hit as any).to).toEqual({ x: 2, y: 0 })
    const wall = world(['@.a.#'])
    expect((fly(wall.world, wall.me, 'e').hit as any).to).toEqual({ x: 3, y: 0 })
    const crowd = world(['@.ab..'])
    expect((fly(crowd.world, crowd.me, 'e').hit as any).to).toEqual({ x: 2, y: 0 })
    const open = world(['@.a...'])
    expect((fly(open.world, open.me, 'e').hit as any).to).toEqual({ x: 4, y: 0 })
  })

  test('a member past its range is not hit, and one at its range is', () => {
    const at  = world(['@' + '.'.repeat(RANGE - 1) + 'a'])
    const out = world(['@' + '.'.repeat(RANGE) + 'a'])
    expect(fly(at.world, at.me, 'e').hit?.kind).toBe('member')
    expect(fly(out.world, out.me, 'e').hit).toBeNull()
  })

  test('the shooter is not their own target, even sharing a cell', () => {
    const { world: w, me } = world(['@' + '.'.repeat(RANGE)])
    w.members.push({ id: 9, x: me.x, y: me.y })
    expect(fly(w, me, 'e').hit).toBeNull()
  })

  test('knockBack on its own is the same rule', () => {
    const { world: w } = world(['@.a....'])
    expect(knockBack(w, w.members[1], 'w')).toEqual({ x: 1, y: 0 })
  })
})

describe('a volley', () => {
  test('is a bolt each way, each against the room as it stood', () => {
    const { world: w, me } = world([
      '...#...',
      '.......',
      'a..@..P',
      '.......',
      '.......',
    ])
    const flights = volley(w, me)
    expect(flights.map(f => [f.facing, f.hit?.kind ?? null])).toEqual([['n', 'wall'], ['e', 'piece'], ['s', 'wall'], ['w', 'member']])
  })

  test('crosses the cells it flew through and not the ones it stopped at', () => {
    const { world: w, me } = world(['@..#'])
    const flights = [fly(w, me, 'e')]
    expect(crosses(flights, { x: 2, y: 0 })).toBe(true)
    expect(crosses(flights, { x: 3, y: 0 })).toBe(false)
    expect(crosses(flights, { x: 0, y: 0 })).toBe(false)
  })
})

describe('the cooldown', () => {
  test('a second bolt inside BOLT_MS is refused with the wait, and admitted after it', () => {
    let t = 1_000
    const cd = createCooldowns({ now: () => t })
    expect(cd.fire(1)).toBe(0)
    t += BOLT_MS - 1
    expect(cd.fire(1)).toBe(1)
    t += 1
    expect(cd.fire(1)).toBe(0)
  })

  test('a volley waits longer, and one member waiting holds nobody else', () => {
    let t = 0
    const cd = createCooldowns({ now: () => t })
    expect(cd.fire(1, true)).toBe(0)
    expect(cd.fire(2)).toBe(0)
    t += BOLT_MS
    expect(cd.fire(1)).toBe(VOLLEY_MS - BOLT_MS)
    expect(cd.fire(2)).toBe(0)
  })

  test('a refused bolt does not push the wait out', () => {
    let t = 0
    const cd = createCooldowns({ now: () => t })
    cd.fire(1)
    t += 1_000
    cd.fire(1)
    t = BOLT_MS
    expect(cd.fire(1)).toBe(0)
  })
})
