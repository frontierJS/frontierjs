// web/test/paths.test.js — `f` finds (`IDEAS/haven.md` 9.6): the flood fill
// over a real stage, the walk to stand beside a figure, and the nearest by the
// walk rather than the crow. A room is drawn as text, `#` a wall piece, and
// stamped onto a stage, so `walkable` is the stage's own.
import { test, expect } from 'bun:test'
import { createStage } from '../src/stage.js'
import { piece } from '../src/pieces/index.js'
import { findByNick, pathBeside, reach } from '../src/paths.js'

function room(rows) {
  const stage = createStage({ slug: 'probe', palette: { w: { fg: '#ffffff' } }, spawn: { x: 1, y: 1 } })
  const wall = piece('wall', '#', 'w')
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') stage.stamp(wall, x, y) }))
  return stage
}

const ROOM = [
  '##########',
  '#....#.###',
  '#.##.#.#.#',
  '#....#.#.#',
  '#.####.#.#',
  '#......#.#',
  '##########',
]

const steps = (path) => path.every((c, i) => {
  const p = i === 0 ? null : path[i - 1]
  return !p || Math.abs(c.x - p.x) + Math.abs(c.y - p.y) === 1
})

test('the flood fill reaches the floor behind a corridor and not past a wall', () => {
  const stage = room(ROOM)
  const seen = reach(stage, { x: 1, y: 1 })
  expect(seen.has('6,1')).toBe(true)
  expect(seen.has('8,5')).toBe(false)
  expect(seen.has('5,1')).toBe(false)
})

test('the walk to a figure ends beside it, a step at a time on floor, and is empty when already beside it', () => {
  const stage = room(ROOM)
  const path = pathBeside(stage, { x: 1, y: 1 }, { x: 6, y: 1 })
  expect(path.at(-1)).toEqual({ x: 6, y: 2 })
  expect(steps([{ x: 1, y: 1 }, ...path])).toBe(true)
  expect(path.every((c) => stage.walkable(c.x, c.y))).toBe(true)
  expect(pathBeside(stage, { x: 1, y: 1 }, { x: 2, y: 1 })).toEqual([])
})

test('a figure nobody can walk beside has no walk', () => {
  expect(pathBeside(room(ROOM), { x: 1, y: 1 }, { x: 8, y: 3 })).toBeNull()
})

test('the nearest by nick is nearest by the walk, not the crow', () => {
  const stage = room(ROOM)
  // Ana is two cells off through a wall and a long way round; Abe is in the open.
  const found = findByNick(stage, { x: 4, y: 1 }, [
    { nick: 'ana', x: 6, y: 1 },
    { nick: 'abe', x: 1, y: 3 },
    { nick: 'bob', x: 4, y: 2 },
  ], 'A')
  expect(found.figure.nick).toBe('abe')
  expect(steps([{ x: 4, y: 1 }, ...found.path])).toBe(true)
})

test('a tie goes to the nick first in order, whatever order presence lists them', () => {
  const stage = room(ROOM)
  const figures = [{ nick: 'cy', x: 5, y: 5 }, { nick: 'cass', x: 1, y: 5 }]
  expect(findByNick(stage, { x: 3, y: 5 }, figures, 'c').figure.nick).toBe('cass')
  expect(findByNick(stage, { x: 3, y: 5 }, [...figures].reverse(), 'c').figure.nick).toBe('cass')
})

test('no nick with the letter, no letter, and a figure past a wall all find nothing', () => {
  const stage = room(ROOM)
  expect(findByNick(stage, { x: 1, y: 1 }, [{ nick: 'ana', x: 3, y: 1 }], 'z')).toBeNull()
  expect(findByNick(stage, { x: 1, y: 1 }, [{ nick: 'ana', x: 3, y: 1 }], '')).toBeNull()
  expect(findByNick(stage, { x: 1, y: 1 }, [{ nick: 'ana', x: 8, y: 3 }], 'a')).toBeNull()
})
