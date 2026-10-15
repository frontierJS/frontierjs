// test/crumble.test.js — a `crumbles` piece: a cell stepped onto and off again
// shakes, sinks and is water, and a cell never stepped on stays a plank. The
// stage is `manual`, so the clock is the ms each call hands it.

import { test, expect, describe } from 'bun:test'

import { createStage, CRUMBLE } from '../src/stage.js'
import { piece } from '../src/pieces/index.js'

const WATER = { ch: '~', key: 'b' }
const palette = { u: { fg: '#92400e' }, b: { fg: '#38bdf8', chars: '~-~', ms: 350, wave: true } }
const { wobble, fall } = CRUMBLE

function pier() {
  const stage = createStage({ slug: 'crumble', palette, spawn: { x: 0, y: 0 }, layers: [], manual: true })
  const planks = piece('pier', '===\n===', 'uuu\nuuu', { floor: true, crumbles: WATER })
  stage.stamp(planks, 0, 0)
  return stage
}

describe('a crumbling piece', () => {
  test('stays whole while it is stood on', () => {
    const stage = pier()
    stage.frame(0)
    stage.occupy([{ x: 0, y: 0 }])
    stage.frame(10_000)
    expect(stage.walkable(0, 0)).toBe(true)
    expect(stage.look(0, 0, 10_000).ch).toBe('=')
  })

  test('shakes once stepped off, then sinks, then is water nobody walks', () => {
    const stage = pier()
    stage.frame(0)
    stage.occupy([{ x: 0, y: 0 }])
    stage.frame(100)
    stage.occupy([{ x: 1, y: 0 }])
    stage.frame(100 + 1)
    expect(stage.walkable(0, 0)).toBe(true)
    expect(CRUMBLE.shake).toContain(stage.look(0, 0, 100 + 1).ch)
    stage.frame(100 + wobble + 1)
    expect(stage.walkable(0, 0)).toBe(false)
    expect(CRUMBLE.sink).toContain(stage.look(0, 0, 100 + wobble + 1).ch)
    const gone = 100 + wobble + fall + 1
    stage.frame(gone)
    expect(stage.walkable(0, 0)).toBe(false)
    expect(['~', '-']).toContain(stage.look(0, 0, gone).ch)
    expect(stage.look(0, 0, gone).fg).toBe('#38bdf8')
  })

  test('a cell nobody stepped on is untouched, and so is the one still stood on', () => {
    const stage = pier()
    stage.frame(0)
    stage.occupy([{ x: 0, y: 0 }])
    stage.occupy([{ x: 1, y: 0 }])
    stage.frame(wobble + fall + 1)
    expect(stage.walkable(2, 1)).toBe(true)
    expect(stage.look(2, 1, wobble + fall + 1).ch).toBe('=')
    expect(stage.walkable(1, 0)).toBe(true)
  })

  test('a step back onto a shaking cell holds it until the next step off', () => {
    const stage = pier()
    stage.frame(0)
    stage.occupy([{ x: 0, y: 0 }])
    stage.frame(100)
    stage.occupy([{ x: 1, y: 0 }])
    stage.frame(100 + wobble - 100)
    stage.occupy([{ x: 0, y: 0 }])
    stage.frame(100 + wobble + fall + 500)
    expect(stage.walkable(0, 0)).toBe(true)
    stage.frame(5_000)
    stage.occupy([{ x: 1, y: 0 }])
    stage.frame(5_000 + wobble + fall + 1)
    expect(stage.walkable(0, 0)).toBe(false)
  })

  test('a cell already sinking is not saved by stepping onto it', () => {
    const stage = pier()
    stage.frame(0)
    stage.occupy([{ x: 0, y: 0 }])
    stage.frame(100)
    stage.occupy([{ x: 1, y: 0 }])
    stage.frame(100 + wobble + 10)
    stage.occupy([{ x: 0, y: 0 }])
    stage.frame(100 + wobble + fall + 1)
    expect(stage.walkable(0, 0)).toBe(false)
    expect(['~', '-']).toContain(stage.look(0, 0, 100 + wobble + fall + 1).ch)
  })

  test('the stage keeps redrawing on the shake and sink beat, then only the water beat', () => {
    const stage = pier()
    stage.frame(0)
    stage.occupy([{ x: 0, y: 0 }])
    stage.frame(100)
    stage.occupy([{ x: 1, y: 0 }])
    expect(stage.tickOf(100)).toBe(CRUMBLE.beat)
    expect(stage.tickOf(100 + wobble + fall + 1)).toBe(350)
  })
})
