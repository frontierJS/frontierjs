// api/test/meta.test.ts
// What a presence frame may carry (`roomMeta`): a cell, and four optional
// words about the figure. Anything else, or anything malformed, is dropped
// and the move still lands.

import { test, expect } from 'bun:test'

import { roomMeta } from '../src/rooms.ts'

test('a cell, with the way faced and the shape drawn, and nothing else', () => {
  expect(roomMeta({ x: 3, y: 4 })).toEqual({ x: 3, y: 4 })
  expect(roomMeta({ x: 3, y: 4, typing: true, facing: 'n', shape: 'T', hat: 'red' })).toEqual({ x: 3, y: 4, typing: true, facing: 'n', shape: 'T' })
})

test('a facing that is not a compass letter, and a shape that is not one printable character, are dropped', () => {
  for (const facing of ['up', 'N', 7, null, ['n']]) expect(roomMeta({ x: 1, y: 1, facing })).toEqual({ x: 1, y: 1 })
  for (const shape of ['', 'TT', ' ', '\u0007', 'é', '\u{1f600}', 5, { a: 1 }]) expect(roomMeta({ x: 1, y: 1, shape })).toEqual({ x: 1, y: 1 })
})

test('an ink is carried only as a lowercase #rrggbb', () => {
  expect(roomMeta({ x: 1, y: 1, ink: '#f472b6' })).toEqual({ x: 1, y: 1, ink: '#f472b6' })
  for (const ink of ['#F472B6', 'f472b6', '#fff', 'red', '#f472b6;x', 5, null]) expect(roomMeta({ x: 1, y: 1, ink })).toEqual({ x: 1, y: 1 })
})

test('typing is carried only as true', () => {
  expect(roomMeta({ x: 1, y: 1, typing: 'yes' })).toEqual({ x: 1, y: 1 })
})

test('the fullest meta fits the presence frame cap', () => {
  expect(Buffer.byteLength(JSON.stringify(roomMeta({ x: 255, y: 255, typing: true, facing: 'n', shape: '"', ink: '#ffffff' })))).toBeLessThanOrEqual(80)
})
