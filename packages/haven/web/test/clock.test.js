// web/test/clock.test.js
// The stage's one clock (`IDEAS/haven.md` 12.7): tasks run in their phase on
// the wall's beat, a paint runs only when the picture changed, and a stage made
// `manual` keeps no timer, so a scene with state is pinned at frame N.
import { test, expect } from 'bun:test'
import { createStage, PHASES } from '../src/lib/scene/stage.js'
import { piece } from '../src/pieces/index.js'

const probe = (opts = {}) => createStage({ slug: 'clock', spawn: { x: 0, y: 0 }, manual: true, layers: [], ...opts })

test('a frame runs simulate, then light, then paint, and `after` puts a task behind its target', () => {
  const stage = probe()
  const ran = []
  stage.task('paint', () => ran.push('paint'), { phase: 'paint' })
  ran.length = 0
  stage.task('b', () => ran.push('b'))
  stage.task('light', () => ran.push('light'), { phase: 'light' })
  stage.task('a', () => ran.push('a'))
  stage.task('a2', () => ran.push('a2'), { after: 'b' })
  stage.stamp(piece('dot', 'o', 'o'), 1, 1)   // the picture changed, so this frame paints
  ran.length = 0
  stage.task('bump', () => stage.touch())
  stage.frame(10)
  expect(ran).toEqual(['b', 'a2', 'a', 'light', 'paint'])
  expect(PHASES).toEqual(['simulate', 'light', 'paint'])
})

test('a task `every` n ms runs once each n ms of the clock, on its multiples', () => {
  const stage = probe()
  const at = []
  stage.task('poll', (ms) => at.push(ms), { every: 100 })
  for (const ms of [50, 99, 100, 150, 199, 230, 450]) stage.frame(ms)
  expect(at).toEqual([100, 230, 450])
})

test('a paint runs on a change, and on the look\'s next tick, and on nothing else', () => {
  const stage = probe({ palette: { k: { fg: '#fff', chars: 'ab', ms: 100 } } })
  const painted = []
  stage.task('paint', (ms) => painted.push(ms), { phase: 'paint' })
  expect(painted).toEqual([0])         // the first paint, on being added
  stage.frame(40)
  expect(painted).toEqual([0])         // nothing moves on a stage with no cycling cell
  stage.stamp(piece('water', '~', 'k'), 0, 0)
  expect(painted).toEqual([0, 40])     // a claim paints at once, at the clock's ms
  stage.frame(90)
  expect(painted).toEqual([0, 40])
  stage.frame(140)
  expect(painted).toEqual([0, 40, 140])   // the water's step
})

test('a task stopped runs no more, a key added twice runs once, and a stopped task may stop itself', () => {
  const stage = probe()
  let n = 0
  const stop = stage.task('once', () => { n++; stop() })
  stage.task('twice', () => { n += 10 })
  stage.task('twice', () => { n += 100 })
  stage.frame(1)
  stage.frame(2)
  expect(n).toBe(1 + 100 + 100)
  expect(() => stage.task('x', () => {}, { phase: 'later' })).toThrow('no phase is called later')
  expect(() => stage.task('x', () => {}, { after: 'nobody' })).toThrow('which is not a task')
})

test('a scene with state is pinned at frame N: a piece a task walks is where the frame count says', () => {
  const stage = probe()
  const cart = stage.stamp(piece('cart', 'c', 'c'), 0, 0)
  stage.task('cart', () => cart.move(cart.x + 1, 0), { every: 100 })
  for (let ms = 0; ms <= 1000; ms += 50) stage.frame(ms)
  expect(cart.x).toBe(10)
  expect(stage.picture()).toEqual([' '.repeat(10) + 'c'])
  expect(stage.now).toBe(1000)
})
