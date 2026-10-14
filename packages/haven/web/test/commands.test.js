// web/test/commands.test.js — `/` and Tab: which command a partial word names,
// and what Tab makes of the line.
import { test, expect } from 'bun:test'
import { COMMANDS, complete, matches, partial } from '../src/commands.js'

test('only a bare slash-word is completable', () => {
  expect(partial('/m')).toBe('m')
  expect(partial('/')).toBe('')
  expect(partial('hello')).toBeNull()
  expect(partial('/ban sam')).toBeNull()
})

test('/ lists every command and /m only the ones starting with m', () => {
  expect(matches('/')).toEqual(COMMANDS)
  expect(matches('/m')).toEqual(['map'])
  expect(matches('/x')).toEqual([])
})

test('Tab completes a lone match and opens its argument', () => {
  expect(complete('/m')).toBe('/map ')
  expect(complete('/un')).toBe('/unban ')
})

test('Tab on several matches stops at what they share, and on none leaves the line', () => {
  expect(complete('/')).toBe('/')
  expect(complete('/x')).toBe('/x')
  expect(complete('hello')).toBe('hello')
  expect(complete('/ban sam')).toBe('/ban sam')
})
