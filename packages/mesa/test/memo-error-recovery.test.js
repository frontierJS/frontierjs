// memo-error-recovery.test.js
//
// A derivation that throws once must still hear its dependencies move. The
// memo leaves `dirty` set when `fn()` throws, and `_notify` returned early
// whenever `dirty` was set — so after one throw it was never queued again, and
// every consumer kept the last good value until something unrelated woke it
// (`FJS-1325`). A derived `const` is this memo, so `const first = items[0].name`
// throwing while a list was briefly empty froze `{first}` for good.
//
// Three ways in, because each leaves the memo dirty from a different place:
// the flush's own `_run`, a read that pulls before the flush reaches it, and a
// FIRST computation that throws — where the first success must still count as
// a change, since the consumer saw an error and not a value.

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

let createSignal, createMemo, createEffect, flushSync

beforeAll(async () => {
  ;({ createSignal, createMemo, createEffect, flushSync } = await import('../src/runtime.js'))
})

let errorSpy
beforeEach(() => { errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {}) })
afterEach(() => { errorSpy.mockRestore() })

const failsAt = (s, bad) => () => { const v = s(); if (v === bad) throw new Error('boom'); return v }

describe('a memo that threw recovers when a dependency moves', () => {

  test('a throw inside the flush does not stop later updates', () => {
    const [s, set] = createSignal(0)
    const m = createMemo(failsAt(s, 1))
    const seen = []
    createEffect(() => { seen.push(m()) })

    set(1); flushSync()
    set(2); flushSync()
    set(3); flushSync()

    expect(seen).toEqual([0, 2, 3])
    // The throw is still reported; recovering is not swallowing.
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  test('a throw on a read that pulled ahead of the flush does not stop later updates', () => {
    const [s, set] = createSignal(0)
    const m = createMemo(failsAt(s, 1))
    const seen = []
    createEffect(() => { try { seen.push(m()) } catch { seen.push('error') } })

    set(1)
    expect(() => m()).toThrow('boom')
    flushSync()
    set(2); flushSync()

    expect(seen.at(-1)).toBe(2)
  })

  test('a first computation that throws still tells its readers about the first value', () => {
    const [s, set] = createSignal(1)
    const m = createMemo(failsAt(s, 1))
    const seen = []
    createEffect(() => { try { seen.push(m()) } catch { seen.push('error') } })
    expect(seen).toEqual(['error'])

    set(2); flushSync()

    expect(seen).toEqual(['error', 2])
  })
})
