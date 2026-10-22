// web/test/home-row.test.js — the left hand's keys (`IDEAS/haven.md` 9.4):
// each operator and the key after it, Esc, a key an operator cannot take, and
// a lone `d` on the clock, stepped as the scene's `keys()` steps them in the
// shell's NORMAL, where the line is no text context.
import { test, expect } from 'bun:test'
import { step, flush } from '@frontierjs/toolbelt/keys'
import { HOME_ROW, homeAction } from '../src/lib/home/home-row.js'

const CONTEXT = { active: [HOME_ROW], mac: false, text: false }

/** Each key's outcome, as the action it does, `'pending'`, or null. */
function press(keys, t = 0) {
  let state = null
  return keys.map((key) => {
    const next = step(state, { key }, CONTEXT, t)
    state = next.state
    const { outcome } = next
    if (outcome?.pending) return 'pending'
    return outcome?.action ? homeAction(outcome.action, outcome.arg) : null
  })
}

test('a key that is not the home row is not its own, and a walk is never taken', () => {
  expect(press(['ArrowLeft', 'h', 'x', 'Enter', 'Escape'])).toEqual([null, null, null, null, null])
})

test('d then a way is a bolt that way, dd is a volley', () => {
  expect(press(['d', 'h'])).toEqual(['pending', { act: 'bolt', facing: 'w' }])
  expect(press(['d', 'k'])[1]).toEqual({ act: 'bolt', facing: 'n' })
  expect(press(['d', 'l'])[1]).toEqual({ act: 'bolt', facing: 'e' })
  expect(press(['d', 'j'])[1]).toEqual({ act: 'bolt', facing: 's' })
  expect(press(['d', 'd'])[1]).toEqual({ act: 'volley' })
})

test('a lone d fires the way faced at state.due, the engine\'s one timeout, and not before', () => {
  const { state } = step(null, { key: 'd' }, CONTEXT, 0)
  expect(state.due).toBe(720)
  expect(flush(state, CONTEXT, 719).outcome).toBeNull()
  const fired = flush(state, CONTEXT, 720)
  expect(homeAction(fired.outcome.action)).toEqual({ act: 'bolt', facing: null })
  expect(fired.state).toBeNull()
})

test('f finds by a letter or digit, lowercased', () => {
  expect(press(['f', 'A'])[1]).toEqual({ act: 'find', letter: 'a' })
  expect(press(['f', '7'])[1]).toEqual({ act: 'find', letter: '7' })
  expect(press(['f', 'a'])[1]).toEqual({ act: 'find', letter: 'a' })
  expect(press(['f', '>'])[1]).toBeNull()
})

test('s takes one printable character, Space back to the figure itself, and nothing wider', () => {
  expect(press(['s', 'T'])[1]).toEqual({ act: 'shape', ch: 'T' })
  expect(press(['s', 's'])[1]).toEqual({ act: 'shape', ch: 's' })
  expect(press(['s', ' '])[1]).toEqual({ act: 'shape', ch: null })
  expect(press(['s', '木'])[1]).toBeNull()
  expect(press(['s', 'Enter'])[1]).toBeNull()
})

test('a chalks a printable character and never a space', () => {
  expect(press(['a', '>'])[1]).toEqual({ act: 'chalk', ch: '>' })
  expect(press(['a', ' '])[1]).toBeNull()
})

test('Esc drops a waiting operator, and the next key is its own again', () => {
  expect(press(['a', 'Escape', 'f'])).toEqual(['pending', null, 'pending'])
})

test('a key an operator cannot take drops it, and the key after is read fresh', () => {
  expect(press(['d', 'x', 'h'])).toEqual(['pending', null, null])
})
