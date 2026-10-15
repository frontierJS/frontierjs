// web/test/home-row.test.js — the left hand's keys (`IDEAS/haven.md` 9.4):
// each operator and the key after it, Esc, a key an operator cannot take, a
// lone `d` on the clock, and the arrows the terminal's NORMAL hands a scene
// for h j k l.
import { test, expect } from 'bun:test'
import { PENDING_MS, createHomeRow } from '../src/home-row.js'

const press = (row, keys, t = 0) => keys.map((k) => row.key(k, t))

test('a key that is not the home row is not its own, and a walk is never taken', () => {
  const row = createHomeRow()
  expect(press(row, ['ArrowLeft', 'h', 'x', 'Enter', 'Escape'])).toEqual([null, null, null, null, null])
})

test('d then a way is a bolt that way, dd is a volley', () => {
  const row = createHomeRow()
  expect(press(row, ['d', 'h'])).toEqual([true, { act: 'bolt', facing: 'w' }])
  expect(press(row, ['d', 'k'])[1]).toEqual({ act: 'bolt', facing: 'n' })
  expect(press(row, ['d', 'ArrowRight'])[1]).toEqual({ act: 'bolt', facing: 'e' })
  expect(press(row, ['d', 'down'])[1]).toEqual({ act: 'bolt', facing: 's' })
  expect(press(row, ['d', 'd'])[1]).toEqual({ act: 'volley' })
})

test('a lone d fires the way faced once PENDING_MS passes, and not before', () => {
  const row = createHomeRow()
  row.key('d', 0)
  expect(row.due(PENDING_MS - 1)).toBeNull()
  expect(row.pending).toBe('d')
  expect(row.due(PENDING_MS)).toEqual({ act: 'bolt', facing: null })
  expect(row.pending).toBeNull()
  expect(row.due(PENDING_MS * 2)).toBeNull()
})

test('a key after a lone d ran out is the bolt, and still the key it was', () => {
  const row = createHomeRow()
  row.key('d', 0)
  expect(row.key('ArrowLeft', PENDING_MS)).toEqual({ act: 'bolt', facing: null, after: null })
  row.key('d', 1000)
  expect(row.key('f', 1000 + PENDING_MS)).toEqual({ act: 'bolt', facing: null, after: true })
  expect(row.pending).toBe('f')
})

test('f finds by a letter or digit, lowercased', () => {
  const row = createHomeRow()
  expect(press(row, ['f', 'A'])[1]).toEqual({ act: 'find', letter: 'a' })
  expect(press(row, ['f', '7'])[1]).toEqual({ act: 'find', letter: '7' })
  expect(press(row, ['f', 'ArrowLeft'])[1]).toEqual({ act: 'find', letter: 'h' })
  expect(press(row, ['f', '>'])[1]).toBe(true)
})

test('s takes one printable character, Space back to the figure itself, and nothing wider', () => {
  const row = createHomeRow()
  expect(press(row, ['s', 'T'])[1]).toEqual({ act: 'shape', ch: 'T' })
  expect(press(row, ['s', 's'])[1]).toEqual({ act: 'shape', ch: 's' })
  expect(press(row, ['s', ' '])[1]).toEqual({ act: 'shape', ch: null })
  expect(press(row, ['s', 'up'])[1]).toEqual({ act: 'shape', ch: 'k' })
  expect(press(row, ['s', '木'])[1]).toBe(true)
  expect(press(row, ['s', 'Enter'])[1]).toBe(true)
})

test('a chalks a printable character and never a space', () => {
  const row = createHomeRow()
  expect(press(row, ['a', '>'])[1]).toEqual({ act: 'chalk', ch: '>' })
  expect(press(row, ['a', ' '])[1]).toBe(true)
})

test('Esc drops a waiting operator, and the next key is its own again', () => {
  const row = createHomeRow()
  expect(press(row, ['a', 'Escape', 'x'])).toEqual([true, true, null])
  row.key('d', 0)
  row.cancel()
  expect(row.due(PENDING_MS)).toBeNull()
})

test('a key an operator cannot take drops it and is swallowed', () => {
  const row = createHomeRow()
  expect(press(row, ['d', 'x', 'h'])).toEqual([true, true, null])
})
