// api/test/memory.test.ts
// The room's memory (`FJS-D993`): footprints, a struck piece, a scorch and
// chalk as traces that last a while, capped per room and per member, wiped by
// a bolt, forgotten by a ban. The clock is handed in, so a fade is a number.

import { test, expect, describe } from 'bun:test'

import { TRACES, createRoomMemory, fadeOf, stepped } from '../src/memory.ts'

const clock = () => {
  const c = { t: 1_000_000, now: () => c.t }
  return c
}

describe('a trace', () => {
  test('lasts its kind\'s time and is gone after', () => {
    const c = clock()
    const mem = createRoomMemory({ now: c.now })
    mem.add('square', { kind: 'chalk', x: 3, y: 4, by: 1, ch: 'X' })
    mem.add('square', { kind: 'scorch', x: 9, y: 2 })
    c.t += TRACES.scorch.ms
    expect(mem.live('square').map(t => t.kind)).toEqual(['chalk'])
    c.t += TRACES.chalk.ms - TRACES.scorch.ms - 1
    expect(mem.live('square', 'chalk').length).toBe(1)
    c.t += 1
    expect(mem.live('square')).toEqual([])
  })

  test('fades from whole to nothing over its time', () => {
    const t = { at: 0, until: 100 }
    expect([-5, 0, 25, 50, 100, 200].map(n => fadeOf(t, n))).toEqual([1, 1, 0.75, 0.5, 0, 0])
  })

  test('a kind the store does not keep is refused by name', () => {
    const mem = createRoomMemory()
    expect(() => mem.add('square', { kind: 'graffiti' as any, x: 0, y: 0 })).toThrow(/graffiti/)
  })

  test('rooms keep their own', () => {
    const mem = createRoomMemory()
    mem.add('square', { kind: 'step', x: 1, y: 1 })
    mem.add(7, { kind: 'step', x: 2, y: 2 })
    expect(mem.live('square').map(t => t.x)).toEqual([1])
    expect(mem.live('7').map(t => t.x)).toEqual([2])
    expect(mem.live('tavern')).toEqual([])
  })

  test('what live returns is a copy, so a caller cannot edit the store', () => {
    const mem = createRoomMemory()
    mem.add('square', { kind: 'step', x: 1, y: 1 })
    mem.live('square').pop()
    expect(mem.live('square').length).toBe(1)
  })
})

describe('the caps', () => {
  test('a room keeps its newest footprints and drops the oldest', () => {
    const mem = createRoomMemory()
    for (let i = 0; i < TRACES.step.room + 3; i++) mem.add('square', { kind: 'step', x: i % 200, y: Math.floor(i / 200) })
    const steps = mem.live('square', 'step')
    expect(steps.length).toBe(TRACES.step.room)
    expect(steps[0]).toMatchObject({ x: 3, y: 0 })
  })

  test('a member\'s chalk past their cap drops their oldest, and nobody else\'s', () => {
    const mem = createRoomMemory()
    mem.add('square', { kind: 'chalk', x: 0, y: 9, by: 2, ch: 'o' })
    for (let i = 0; i < TRACES.chalk.each + 1; i++) mem.add('square', { kind: 'chalk', x: i, y: 0, by: 1, ch: '>' })
    const chalk = mem.live('square', 'chalk')
    expect(chalk.filter(t => t.by === 1).length).toBe(TRACES.chalk.each)
    expect(chalk.filter(t => t.by === 1)[0].x).toBe(1)
    expect(chalk.filter(t => t.by === 2).length).toBe(1)
  })

  test('the cap of one kind never drops another', () => {
    const mem = createRoomMemory()
    mem.add('square', { kind: 'struck', x: 5, y: 5 })
    for (let i = 0; i < TRACES.step.room + 1; i++) mem.add('square', { kind: 'step', x: 0, y: 0 })
    expect(mem.live('square', 'struck').length).toBe(1)
  })
})

describe('taking traces out', () => {
  test('a wipe takes what it names in one room and answers with it', () => {
    const mem = createRoomMemory()
    mem.add('square', { kind: 'chalk', x: 1, y: 0, by: 1, ch: 'a' })
    mem.add('square', { kind: 'chalk', x: 2, y: 0, by: 1, ch: 'b' })
    mem.add('tavern', { kind: 'chalk', x: 1, y: 0, by: 1, ch: 'c' })
    const taken = mem.wipe('square', t => t.kind === 'chalk' && t.x === 1)
    expect(taken.map(t => t.ch)).toEqual(['a'])
    expect(mem.live('square').map(t => t.ch)).toEqual(['b'])
    expect(mem.live('tavern').map(t => t.ch)).toEqual(['c'])
  })

  test('forget takes one member\'s traces of the kinds named, in every room, and leaves the rest', () => {
    const mem = createRoomMemory()
    mem.add('square', { kind: 'chalk', x: 1, y: 0, by: 1, ch: 'a' })
    mem.add('tavern', { kind: 'chalk', x: 1, y: 0, by: 1, ch: 'b' })
    mem.add('square', { kind: 'step',  x: 1, y: 0, by: 1 })
    mem.add('square', { kind: 'chalk', x: 2, y: 0, by: 2, ch: 'c' })
    expect(mem.forget(1, ['chalk'])).toBe(2)
    expect(mem.live('square').map(t => [t.kind, t.by])).toEqual([['step', 1], ['chalk', 2]])
    expect(mem.live('tavern')).toEqual([])
    expect(mem.forget(1)).toBe(1)
  })
})

describe('a step (7.4)', () => {
  test('is one cell over, up or down from where the figure stood, and a join, a jump or a diagonal is none', () => {
    expect([[1, 0], [-1, 0], [0, 1], [0, -1]].every(([dx, dy]) => stepped({ x: 5, y: 5 }, { x: 5 + dx, y: 5 + dy }))).toBe(true)
    expect(stepped(undefined, { x: 5, y: 5 })).toBe(false)
    expect(stepped({}, { x: 5, y: 5 })).toBe(false)
    expect(stepped({ x: 5, y: 5 }, { x: 5, y: 5 })).toBe(false)
    expect(stepped({ x: 5, y: 5 }, { x: 6, y: 6 })).toBe(false)
    expect(stepped({ x: 5, y: 5 }, { x: 40, y: 20 })).toBe(false)
  })
})
