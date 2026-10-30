// memo-disposed-read.test.js
//
// A memo disposed while clean kept serving its last value on read, so a read
// through a torn-down owner looked like a live one (`FJS-1143`). The `_disposed`
// guards sit on `_notify`/`_run`, which a read never reaches. The value is still
// served; the read says so, once per memo.

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

let createSignal, createMemo, createRoot, onCleanup

beforeAll(async () => {
  ;({ createSignal, createMemo, createRoot, onCleanup } = await import('../src/runtime.js'))
})

let warnSpy
beforeEach(() => { warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { warnSpy.mockRestore() })

describe('reading a disposed memo', () => {
  test('warns once and still returns the last value', () => {
    const [s] = createSignal(4)
    let m
    const dispose = createRoot((d) => { m = createMemo(() => s() * 2); m(); return d })
    dispose()

    expect(m()).toBe(8)
    expect(m()).toBe(8)
    const msgs = warnSpy.mock.calls.map((c) => String(c[0])).filter((t) => t.includes('disposed'))
    expect(msgs).toHaveLength(1)
  })

  test('a live memo does not warn', () => {
    const [s] = createSignal(1)
    createRoot(() => { const m = createMemo(() => s() + 1); m() })
    expect(warnSpy).not.toHaveBeenCalled()
  })
})

// A cleanup reads what its own owner derived: `Tab`'s `$.onDestroy` calls
// `unregisterTab`, a memo the component owns, and children are disposed before
// the owner's cleanups run (`FJS-3653`).
describe('reading a memo from a teardown', () => {
  test('an owner cleanup reading its own memo does not warn', () => {
    const [s] = createSignal(2)
    let seen
    const dispose = createRoot((d) => {
      const m = createMemo(() => s() * 3)
      m()
      onCleanup(() => { seen = m() })
      return d
    })
    dispose()

    expect(seen).toBe(6)
    expect(warnSpy).not.toHaveBeenCalled()
  })
})
