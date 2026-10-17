// web/test/spots.test.js — a piece's named cells (`IDEAS/haven.md` 12.3): the
// shapes a piece refuses by name, a placement's spot as a cell of the stage,
// a piece found by import and never by its name, and the real pieces' spots
// — the table's pair of seats, the bar's stools, the desk's keeper, a bench's
// slots.
import { test, expect } from 'bun:test'
import { piece, spotsOf } from '../src/pieces/index.js'
import { table } from '../src/pieces/table.js'
import { bar, STOOLS } from '../src/pieces/bar.js'
import { namedBench } from '../src/pieces/bench.js'
import { deskPiece } from '../src/pieces/workshop.js'
import { createStage } from '../src/lib/scene/stage.js'

const art = 'o-o'
const paint = 'www'
const stage = () => createStage({ slug: 'spots', palette: {}, spawn: { x: 0, y: 0 }, manual: true })

test('a spot needs whole-number dx and dy', () => {
  expect(() => piece('p', art, paint, { spots: { a: { dx: 0.5, dy: 0 } } })).toThrow('p.a needs whole-number')
  expect(() => piece('p', art, paint, { spots: { a: { dx: 0 } } })).toThrow('p.a needs whole-number')
})

test('a spot is a seat or a burn or has no kind', () => {
  expect(() => piece('p', art, paint, { spots: { a: { kind: 'door', dx: 0, dy: 0 } } })).toThrow('seat or a burn')
  expect(piece('p', art, paint, { spots: { a: { dx: 0, dy: 1 } } }).spots.a).toEqual({ dx: 0, dy: 1 })
})

test('a seat needs somewhere to stand up to, and a mate or to be solo', () => {
  expect(() => piece('p', art, paint, { spots: { a: { kind: 'seat', dx: 0, dy: 0, solo: true } } })).toThrow('stand up to')
  expect(() => piece('p', art, paint, { spots: { a: { kind: 'seat', dx: 0, dy: 0, stand: { dx: 0, dy: 1 } } } })).toThrow('mate')
})

test('a mate is a seat of the same piece', () => {
  const stand = { dx: 0, dy: 1 }
  expect(() => piece('p', art, paint, { spots: { a: { kind: 'seat', dx: 0, dy: 0, stand, mate: 'nope' } } })).toThrow('no seat of the piece')
  expect(() => piece('p', art, paint, { spots: { a: { kind: 'seat', dx: 0, dy: 0, stand, mate: 'b' }, b: { dx: 2, dy: 0 } } })).toThrow('no seat of the piece')
})

test('spotsOf lists a piece\'s spots in the order named, of one kind when asked', () => {
  expect(spotsOf(table).map((s) => s.name)).toEqual(['west', 'east', 'candle'])
  expect(spotsOf(table, 'seat').map((s) => s.name)).toEqual(['west', 'east'])
  expect(spotsOf(table, 'burn').map((s) => s.name)).toEqual(['candle'])
  expect(spotsOf(piece('plain', art, paint))).toEqual([])
})

test('a placement\'s spot is a cell of the stage, and moves with the placement', () => {
  const s = stage()
  const mark = s.stamp(table, 10, 5)
  expect(mark.spot('west')).toEqual({ x: 10, y: 6 })
  expect(mark.spot('candle')).toEqual({ x: 15, y: 6 })
  mark.move(12, 8)
  expect(mark.spot('east')).toEqual({ x: 22, y: 9 })
  expect(() => mark.spot('keeper')).toThrow('table has no spot keeper')
})

test('a piece is found by the piece, and two placements of it are both found', () => {
  const s = stage()
  s.stamp(table, 10, 5)
  s.stamp(table, 40, 5)
  s.stamp(bar, 10, 12)
  expect(s.placed(table).map((m) => m.x)).toEqual([10, 40])
  expect(s.placed(bar)).toHaveLength(1)
  expect(s.placed(deskPiece)).toEqual([])
  // Same name, other piece: found by neither.
  expect(s.placed(piece('table', art, paint))).toEqual([])
})

test('a seat\'s mate is the seat it names', () => {
  const s = stage()
  s.stamp(table, 10, 5)
  expect(s.seatAt(10, 6)).toEqual({ mate: { x: 20, y: 6 }, stand: { x: 9, y: 6 } })
  expect(s.seatAt(20, 6)).toEqual({ mate: { x: 10, y: 6 }, stand: { x: 21, y: 6 } })
})

test('the bar\'s stools are fifteen solo seats and pair with nobody', () => {
  const s = stage()
  const mark = s.stamp(bar, 5, 7)
  expect(spotsOf(bar, 'seat').map((x) => mark.spot(x.name).x - 5)).toEqual(STOOLS)
  for (const x of spotsOf(bar, 'seat')) expect(s.seatAt(mark.spot(x.name).x, mark.spot(x.name).y)).toBeNull()
})

test('the desk has a keeper and a bench has four slots in a row below it', () => {
  const s = stage()
  const desk = s.stamp(deskPiece, 30, 40)
  expect(desk.spot('keeper')).toEqual({ x: 37, y: 41 })
  const bench = s.stamp(namedBench('litestone'), 4, 6)
  expect([0, 1, 2, 3].map((i) => bench.spot(`slot-${i}`))).toEqual([{ x: 6, y: 7 }, { x: 8, y: 7 }, { x: 10, y: 7 }, { x: 12, y: 7 }])
})

// ─── a piece's palette (12.8) ────────────────────────────────────────

import { lamp } from '../src/pieces/lamp.js'

const bulb = { fg: ['#ffffff'], light: 4 }
const bulbOf = (pal) => piece('bulb', 'O', 'B', { palette: pal })

test('a palette entry is for one paint letter and an object', () => {
  expect(() => piece('p', art, paint, { palette: { ab: { fg: '#fff' } } })).toThrow('not one paint letter')
  expect(() => piece('p', art, paint, { palette: { a: '#fff' } })).toThrow('needs an entry')
})

test('a piece placed in a scene that lacks its letter still draws it, and lights', () => {
  const s = stage()
  s.stamp(lamp, 5, 5)
  expect(s.entryOf('Y').light).toBe(4)
  expect(s.look(6, 5).fg).toBeDefined()
  expect(s.lights).toEqual([{ x: 6, y: 5, r: 4 }])
})

test('the scene\'s entry for a letter wins over the piece\'s', () => {
  const s = createStage({ slug: 'o', palette: { Y: { fg: '#00ff00', light: 5 } }, spawn: { x: 0, y: 0 }, manual: true })
  s.stamp(lamp, 5, 5)
  expect(s.entryOf('Y').light).toBe(5)
  expect(s.lights[0].r).toBe(5)
  expect(s.defaults).toEqual({})
})

test('two pieces that give one letter different entries are refused naming both, unless the scene settles it', () => {
  const s = stage()
  s.stamp(bulbOf({ B: bulb }), 0, 0)
  s.stamp(bulbOf({ B: bulb }), 5, 0)
  expect(() => s.stamp(piece('lantern', 'O', 'B', { palette: { B: { fg: '#ff0000' } } }), 9, 0)).toThrow("B is bulb's one way and lantern's another")
  expect(s.marks).toHaveLength(2)
  const settled = createStage({ slug: 's', palette: { B: { fg: '#123456' } }, spawn: { x: 0, y: 0 }, manual: true })
  settled.stamp(bulbOf({ B: bulb }), 0, 0)
  settled.stamp(piece('lantern', 'O', 'B', { palette: { B: { fg: '#ff0000' } } }), 5, 0)
  expect(settled.entryOf('B').fg).toBe('#123456')
})

test('a piece taken away takes its entries with it', () => {
  const s = stage()
  const mark = s.stamp(lamp, 5, 5)
  mark.remove()
  expect(s.entryOf('Y')).toBeUndefined()
  expect(s.defaults).toEqual({})
  expect(s.lights).toEqual([])
})
