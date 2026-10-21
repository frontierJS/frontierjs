// FJS-1117: the availability table and the buy box say one sentence for one state.
import { test, expect } from 'bun:test'
import { stockText } from '../src/stock.js'

test('stock on the shelf but held in baskets is not sold out', () => {
  expect(stockText({ onHand: 7, available: 0 })).toBe('In other baskets right now')
})

test('nothing on the shelf is sold out', () => {
  expect(stockText({ onHand: 0, available: 0 })).toBe('Sold out')
})

test('some available reads as a count', () => {
  expect(stockText({ onHand: 7, available: 3 })).toBe('3 available')
})

// FJS-3401: a hold lapses on its own, so a page showing one is re-asked.
import { reaskDelay, HOLD_REASK_MS } from '../src/stock.js'

test('a shelf with stock in baskets is re-asked', () => {
  expect(reaskDelay([{ onHand: 5, available: 5 }, { onHand: 7, available: 0 }])).toBe(HOLD_REASK_MS)
  expect(reaskDelay([{ onHand: 7, available: 3 }])).toBe(HOLD_REASK_MS)
})

test('a page with nothing held, or sold out for good, is not re-asked', () => {
  expect(reaskDelay([{ onHand: 5, available: 5 }, { onHand: 0, available: 0 }])).toBe(null)
  expect(reaskDelay([])).toBe(null)
})
