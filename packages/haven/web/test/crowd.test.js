// web/test/crowd.test.js — what the other figures put on a screen: who is
// drawn, the name under one within reach and the line over one that spoke,
// over a real stage and a presence snapshot of the shape `here.get()` hands.
import { test, expect } from 'bun:test'
import { createStage } from '../src/stage.js'
import { bubbles, cellOf, figures, inView, NEAR, plates } from '../src/crowd.js'

const spawn = { x: 5, y: 5 }
const stage = createStage({ slug: 'crowd', palette: {}, spawn, manual: true })
const view = { x: 0, y: 0, w: 40, h: 12 }
const member = (userId, x, y) => ({ userId, connectionId: `c${userId}`, meta: x == null ? {} : { x, y } })
const here = (others, self = 1) => ({ self: { userId: self }, others })
const said = (id, memberId, body, extra = {}) => ({ id, memberId, body, ...extra })

test('a member with no cell stands at the spawn', () => {
  expect(cellOf(member(2), spawn)).toEqual(spawn)
  expect(cellOf(member(2, 9, 3), spawn)).toEqual({ x: 9, y: 3 })
  expect(inView({ x: 39, y: 11 }, view)).toBe(true)
  expect(inView({ x: 40, y: 11 }, view)).toBe(false)
})

test('only figures inside the view are drawn, at their cell of it', () => {
  const h = here([member(2, 10, 4), member(3, 60, 4)])
  const drawn = figures(h, { ...view, x: 2 }, stage, spawn)
  expect(drawn.map((f) => [f.m.userId, f.x, f.y])).toEqual([[2, 8, 4]])
})

test('a nameplate sits under a figure within reach and only with a name known', () => {
  const h = here([member(2, 8, 6), member(3, 8 + NEAR.x + 1, 5), member(4, 6, 6)])
  const out = plates(h, view, { 2: 'ana', 3: 'rex' }, 5, 5, stage, spawn)
  expect(out).toEqual([{ key: 'c2', text: 'ana', x: 8, y: 7 }])
})

test('a nameplate is kept inside the view', () => {
  const h = here([member(2, 39, 11)])
  const [p] = plates(h, view, { 2: 'anabel' }, 38, 11, stage, spawn)
  expect(p).toMatchObject({ x: 34, y: 11 })
})

test('a bubble is the newest line of each speaker, over where they stand', () => {
  const h = here([member(2, 10, 6)])
  const out = bubbles(h, [said(9, 2, 'hi'), said(8, 2, 'older'), said(7, 1, 'mine')], 5, 5, view, spawn)
  expect(out).toEqual([
    { key: '2:9', x: 10, y: 5, text: '(hi)' },
    { key: '1:7', x: 5, y: 4, text: '(mine)' },
  ])
})

test('a hushed line, and every one before it, is no bubble, and nothing older takes its place', () => {
  const h = here([{ ...member(2, 10, 6), meta: { x: 10, y: 6, hushed: 9 } }])
  const lines = [said(9, 2, 'hi'), said(8, 2, 'older'), said(7, 1, 'mine'), said(6, 1, 'first')]
  expect(bubbles(h, lines, 5, 5, view, spawn).map((b) => b.key)).toEqual(['1:7'])
  expect(bubbles(h, lines, 5, 5, view, spawn, 7)).toEqual([])
  expect(bubbles(h, [said(10, 2, 'again'), ...lines], 5, 5, view, spawn, 7).map((b) => b.key)).toEqual(['2:10'])
})

test('a line from beyond earshot is no bubble, a shout and a whisper are', () => {
  const h = here([member(2, 39, 5)])
  const far = (extra) => bubbles(h, [said(1, 2, 'hello', extra)], 5, 5, view, spawn)
  expect(far()).toEqual([])
  expect(far({ body: '!hello' })).toHaveLength(1)
  expect(far({ toId: 1 })[0].text).toBe('(psst: hello)')
})

test('a speaker past the view is a marker on the edge facing them', () => {
  const h = here([member(2, 60, 5)])
  const [b] = bubbles(h, [said(1, 2, '!yo')], 5, 5, view, spawn)
  expect(b.text).toBe('(!yo)>')
  expect(b.x + b.text.length).toBe(view.w)
})
