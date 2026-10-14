// web/test/scenes.test.js — every scene draws the picture committed beside it
// (`FJS-D997`), and the stage under it holds.
//
// A scene is a tree of pieces placed by hand, so the ways it goes wrong are a
// piece on the wrong cell, two pieces on one cell, a door the spawn cannot
// reach, and a pacer walking a wall — none of which fails at render: the
// frame just looks wrong. `<name>.frame.txt` is the picture, pinned row for
// row; `bun run frames` rewrites it, and the diff is the review.
import { test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SCENES, WEB, mountScene } from './stage.mjs'
import { pacerAt, createStage } from '../src/stage.js'
import { piece } from '../src/pieces/index.js'

const STEPS = [[0, 1], [0, -1], [1, 0], [-1, 0]]

for (const { name, slug } of SCENES) {
  const { stage, frame } = await mountScene(name)
  const expected = readFileSync(join(WEB, 'src/scenes', `${slug}.frame.txt`), 'utf8').replace(/\n$/, '').split('\n')

  test(`${slug}: the stage's picture is ${slug}.frame.txt`, () => {
    expect(stage.picture()).toEqual(expected)
  })

  test(`${slug}: the terminal draws that picture`, () => {
    // A cycling cell may show another glyph of its `chars` at this tick, and a
    // pacer stands somewhere on its row, so a cell is compared only where no
    // clock moves it.
    const paced = (x, y) => stage.pacers.some((p) => p.y === y && x >= p.from && x <= p.to)
    expected.forEach((row, y) => {
      const drawn = frame[y] ?? ''
      ;[...row].forEach((ch, x) => {
        if (stage.cycles(x, y) || paced(x, y)) return
        expect({ x, y, ch: drawn[x] ?? ' ' }).toEqual({ x, y, ch })
      })
    })
  })

  test(`${slug}: a cycling cell changes over time and never moves a wall`, () => {
    const tick = stage.tickOf()
    expect(tick).toBeGreaterThan(0)
    let changed = false
    for (let y = 0; y < stage.height; y++) {
      for (let x = 0; x < stage.width; x++) {
        const a = stage.look(x, y, 0)
        const b = stage.look(x, y, tick * 7)
        if (a.ch !== b.ch || a.fg !== b.fg) changed = true
        expect(b.ch === ' ').toBe(expected[y][x] === ' ')
      }
    }
    expect(changed).toBe(true)
  })

  test(`${slug}: every painted cell has a glyph and a color at every tick`, () => {
    for (let ms = 0; ms < 200_000; ms += 37) {
      for (let y = 0; y < stage.height; y++) {
        for (let x = 0; x < stage.width; x++) {
          if (expected[y][x] === ' ') continue
          const { ch, fg } = stage.look(x, y, ms)
          if (typeof ch !== 'string' || typeof fg !== 'string') throw new Error(`${slug} ${x},${y} at ${ms}ms: ${ch} ${fg}`)
        }
      }
    }
  })

  test(`${slug}: the spawn is floor and every door is reached from it`, () => {
    const { spawn } = stage
    expect(stage.walkable(spawn.x, spawn.y)).toBe(true)
    const seen = new Set([`${spawn.x},${spawn.y}`])
    const queue = [spawn]
    while (queue.length) {
      const { x, y } = queue.shift()
      for (const [dx, dy] of STEPS) {
        const k = `${x + dx},${y + dy}`
        if (!seen.has(k) && stage.walkable(x + dx, y + dy)) { seen.add(k); queue.push({ x: x + dx, y: y + dy }) }
      }
    }
    expect(stage.doors.length).toBeGreaterThan(0)
    for (const d of stage.doors) {
      expect(stage.doorAt(d.x, d.y)).toEqual(d)
      expect(stage.walkable(d.x, d.y)).toBe(false)
      const reached = STEPS.some(([dx, dy]) => seen.has(`${d.x + dx},${d.y + dy}`))
      expect({ door: d.to, reached }).toEqual({ door: d.to, reached: true })
    }
  })

  for (const p of stage.pacers) {
    test(`${slug}: the ${p.name} paces floor only, end to end and back`, () => {
      for (let x = p.from; x <= p.to; x++) expect({ x, floor: stage.walkable(x, p.y) }).toEqual({ x, floor: true })
      const lefts = new Set(), rights = new Set()
      for (let ms = 0; ms < 200_000; ms += p.ms) {
        const { x, y, text } = pacerAt(p, ms)
        expect(y).toBe(p.y)
        expect(x).toBeGreaterThanOrEqual(p.from)
        expect(x + text.length - 1).toBeLessThanOrEqual(p.to)
        lefts.add(x)
        rights.add(x + text.length - 1)
      }
      expect(Math.min(...lefts)).toBe(p.from)
      expect(Math.max(...rights)).toBe(p.to)
    })
  }
}

// ─── the stage's own rules ───────────────────────────────────────────

const wall  = piece('wall', '|', 'w')
const table = piece('table', 'o|o', 'tct')

test('two pieces on one cell are refused naming the cell and both', () => {
  const stage = createStage({ slug: 'probe', spawn: { x: 0, y: 0 } })
  stage.stamp(table, 0, 0)
  expect(() => stage.stamp(wall, 1, 0)).toThrow('cell 1,0 is claimed by both table and wall')
})

test('a door replaces the wall under it and comes back when removed', () => {
  const stage = createStage({ slug: 'probe', spawn: { x: 0, y: 0 } })
  stage.stamp(wall, 2, 0)
  const door = stage.door(2, 0, '/out/')
  expect(stage.picture()).toEqual(['  n'])
  expect(stage.doorAt(2, 0)).toEqual({ x: 2, y: 0, to: '/out/' })
  expect(stage.walkable(2, 0)).toBe(false)
  door.remove()
  expect(stage.picture()).toEqual(['  |'])
  expect(stage.doorAt(2, 0)).toBeNull()
})

test('a moved piece frees the cells it left, and a removed one frees them all', () => {
  const stage = createStage({ slug: 'probe', spawn: { x: 0, y: 0 } })
  const mark = stage.stamp(table, 0, 0)
  mark.move(4, 0)
  expect(stage.picture()).toEqual(['    o|o'])
  expect(stage.walkable(0, 0)).toBe(true)
  stage.stamp(wall, 1, 0)
  mark.remove()
  expect(stage.picture()).toEqual([' |'])
})

test('a floor piece is walked on, a wall is not, and the edge is a wall', () => {
  const rug = piece('rug', ':::', 'mmm', { floor: true })
  const stage = createStage({ slug: 'probe', palette: { m: { fg: '#000000' } }, spawn: { x: 0, y: 0 } })
  stage.stamp(rug, 0, 1)
  stage.stamp(wall, 3, 1)
  expect([0, 1, 2, 3].map((x) => stage.walkable(x, 1))).toEqual([true, true, true, false])
  expect(stage.walkable(0, 0)).toBe(true)
  expect(stage.walkable(4, 1)).toBe(false)
  expect(stage.look(1, 1, 0)).toEqual({ ch: ':', fg: '#000000', bg: undefined })
})
