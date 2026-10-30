// web/test/scars.test.js
// What a bolt leaves on the stage (`IDEAS/haven.md` 9.5): a piece it breaks is
// nothing and can be stood on until it grows back, and a wall it strikes is a
// `,` that fades. Both are laid from the server's traces, named by the id
// `world.js` spells, so a trace for a piece this scene does not place is
// ignored rather than thrown.
import { test, expect } from 'bun:test'
import { createStage, INDOORS, SCORCH_FG } from '../src/lib/scene/stage.js'
import { barrel } from '../src/pieces/barrel.js'
import { piece } from '../src/pieces/index.js'
import { DAY_MS } from '#shared/sky.js'
import { worldOf } from '../src/lib/scene/world.js'
import { TRACES } from '#shared/memory.ts'

const NOON = 3 * DAY_MS + 1000
const GROWS = TRACES.struck.ms
const FADES = TRACES.scorch.ms

const probe = (opts = {}) => {
  const stage = createStage({ slug: 'scars', palette: { w: { fg: '#ffffff' }, u: { fg: '#aa8844' } }, spawn: { x: 0, y: 0 }, manual: true, ...opts })
  stage.stamp(barrel, 5, 2)
  stage.stamp(piece('wall', '|', 'w'), 12, 2)
  stage.frame(NOON)
  return stage
}
const broken = (at = NOON, id = worldOf(probe()).pieces.find((p) => p.name === 'barrel').id) => ({ kind: 'struck', id, x: 6, y: 3, at, until: at + GROWS })
const burnt = (x, at = NOON) => ({ kind: 'scorch', x, y: 2, at, until: at + FADES })

test('the id a trace names a piece by is the one the world file spells', () => {
  expect(worldOf(probe()).pieces.map((p) => p.id)).toContain('barrel@5,2')
})

test('a broken piece draws as nothing and can be stood on, then is the piece again', () => {
  const stage = probe()
  expect(stage.walkable(6, 3)).toBe(false)
  expect(stage.look(6, 3, NOON).ch).toBe('=')
  stage.shatter([broken()])
  expect(stage.walkable(6, 3)).toBe(true)
  for (const [x, y] of [[6, 3], [5, 3], [9, 3]]) expect(stage.look(x, y, NOON).ch).toBe(' ')
  expect(stage.look(6, 3, NOON + GROWS - 1).ch).toBe(' ')
  expect(stage.look(6, 3, NOON + GROWS).ch).toBe('=')
  stage.frame(NOON + GROWS)
  expect(stage.walkable(6, 3)).toBe(false)
})

test('the stage asks for a redraw when the piece will grow back', () => {
  const stage = probe()
  stage.shatter([broken()])
  const tick = stage.tickOf(NOON)
  expect(tick).toBeGreaterThan(0)
  expect(tick).toBeLessThanOrEqual(GROWS)
})

test('a piece this scene does not place and an expired trace change nothing', () => {
  const stage = probe()
  stage.shatter([broken(NOON, 'barrel@1,1'), broken(NOON - 2 * GROWS)])
  expect(stage.walkable(6, 3)).toBe(false)
  expect(stage.look(6, 3, NOON).ch).toBe('=')
})

test('a scorch replaces the glyph of the wall it struck and fades in thirds', () => {
  const stage = probe()
  expect(stage.look(12, 2, NOON).ch).toBe('|')
  stage.scorch([burnt(12)])
  expect(stage.look(12, 2, NOON)).toMatchObject({ ch: ',', fg: SCORCH_FG[2] })
  expect(stage.look(12, 2, NOON + FADES / 3 + 1).fg).toBe(SCORCH_FG[1])
  expect(stage.look(12, 2, NOON + (2 * FADES) / 3 + 1).fg).toBe(SCORCH_FG[0])
  expect(stage.look(12, 2, NOON + FADES).ch).toBe('|')
})

test('a scorch is not drawn on a blank cell, and is there indoors as out', () => {
  const stage = probe()
  stage.scorch([burnt(20)])
  expect(stage.look(20, 2, NOON).ch).toBe(' ')
  const inside = probe({ layers: INDOORS })
  inside.scorch([burnt(12)])
  expect(inside.look(12, 2, NOON).ch).toBe(',')
})
