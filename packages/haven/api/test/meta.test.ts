// api/test/meta.test.ts
// What a presence frame may carry (`roomMeta`): a cell, and four optional
// words about the figure. Anything else, or anything malformed, is dropped
// and the move still lands.

import { test, expect } from 'bun:test'

import { roomMeta } from '../src/rooms.ts'

test('a cell, with the way faced and the shape drawn, and nothing else', () => {
  expect(roomMeta({ x: 3, y: 4 })).toEqual({ x: 3, y: 4 })
  expect(roomMeta({ x: 3, y: 4, typing: true, facing: 'n', shape: 'T', hat: 'red' })).toEqual({ x: 3, y: 4, typing: true, facing: 'n', shape: 'T' })
  expect(roomMeta({ x: 3, y: 4, shape: '\u{1f600}' })).toEqual({ x: 3, y: 4, shape: '\u{1f600}' })
})

test('a facing that is not a compass letter, and a shape that is not one printable character or one emoji, are dropped', () => {
  for (const facing of ['up', 'N', 7, null, ['n']]) expect(roomMeta({ x: 1, y: 1, facing })).toEqual({ x: 1, y: 1 })
  for (const shape of ['', 'TT', ' ', '\u0007', 'é', '木', '\u{1f44d}\u{1f3fd}', '\u{1f1ef}', 5, { a: 1 }]) expect(roomMeta({ x: 1, y: 1, shape })).toEqual({ x: 1, y: 1 })
})

test('an ink is carried only as a lowercase #rrggbb', () => {
  expect(roomMeta({ x: 1, y: 1, ink: '#f472b6' })).toEqual({ x: 1, y: 1, ink: '#f472b6' })
  for (const ink of ['#F472B6', 'f472b6', '#fff', 'red', '#f472b6;x', 5, null]) expect(roomMeta({ x: 1, y: 1, ink })).toEqual({ x: 1, y: 1 })
})

test('typing and thinking are carried only as true, and thinking is not also typing', () => {
  expect(roomMeta({ x: 1, y: 1, typing: 'yes' })).toEqual({ x: 1, y: 1 })
  expect(roomMeta({ x: 1, y: 1, thinking: 1 })).toEqual({ x: 1, y: 1 })
  expect(roomMeta({ x: 1, y: 1, thinking: true, typing: true })).toEqual({ x: 1, y: 1, thinking: true })
})

test('hushed is a line id, and anything else is dropped', () => {
  expect(roomMeta({ x: 1, y: 1, hushed: 42 })).toEqual({ x: 1, y: 1, hushed: 42 })
  for (const hushed of [0, -1, 1.5, 1e9, '7', null, {}]) expect(roomMeta({ x: 1, y: 1, hushed })).toEqual({ x: 1, y: 1 })
})

test('an emote is one of the three, and anything else is dropped', () => {
  for (const emote of ['wave', 'sit', 'dance'] as const) expect(roomMeta({ x: 1, y: 1, emote })).toEqual({ x: 1, y: 1, emote })
  for (const emote of ['Wave', 'jump', '', 1, null]) expect(roomMeta({ x: 1, y: 1, emote })).toEqual({ x: 1, y: 1 })
})

test('a pet is out only as true, and anything else is dropped', () => {
  expect(roomMeta({ x: 1, y: 1, pet: true })).toEqual({ x: 1, y: 1, pet: true })
  for (const pet of [false, 1, 'dog', {}, null]) expect(roomMeta({ x: 1, y: 1, pet })).toEqual({ x: 1, y: 1 })
})

test('the fullest meta fits the presence frame cap', () => {
  expect(Buffer.byteLength(JSON.stringify(roomMeta({ x: 255, y: 255, thinking: true, facing: 'n', shape: '🙂', ink: '#ffffff', hushed: 999999999, emote: 'dance', pet: true })))).toBeLessThanOrEqual(128)
})
