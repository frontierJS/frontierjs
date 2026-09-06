// opaque-watch-warning.test.js
//
// `Map`, `Set` and `Date` inside watched state are inert: their contents live
// in internal slots the proxy traps never observe, so `state.tags.add('x')`
// notifies nothing and renders nothing. That is a deliberate exclusion —
// wrapping them broke their own methods — and nothing said so, which is the
// same silence `_warnAccessorWatch` exists to break (`FJS-850`).
//
// The warning only. Making them reactive is a separate, unruled question.

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

let watchProxy

beforeAll(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  for (const k of ['document', 'HTMLElement', 'Node', 'Event']) {
    try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
  }
  globalThis.window = win
  ;({ watchProxy } = await import('../src/runtime.js'))
})

let warn
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => { warn.mockRestore() })

const said = () => warn.mock.calls.map((c) => String(c[0]))

describe('an inert value in watched state announces itself', () => {

  test('a Set is named, with its path', () => {
    const p = watchProxy({ filters: { tags: new Set(['a']) } })
    p.filters.tags
    expect(said().some((m) => m.includes('filters.tags') && m.includes('Set'))).toBe(true)
  })

  test('a Map is named', () => {
    const p = watchProxy({ byId: new Map() })
    p.byId
    expect(said().some((m) => m.includes('byId') && m.includes('Map'))).toBe(true)
  })

  test('a Date is named', () => {
    const p = watchProxy({ when: new Date(0) })
    p.when
    expect(said().some((m) => m.includes('when') && m.includes('Date'))).toBe(true)
  })

  test('once per value, however many times it is read', () => {
    const p = watchProxy({ tags: new Set() })
    for (let i = 0; i < 5; i++) p.tags
    expect(said().filter((m) => m.includes('tags')).length).toBe(1)
  })

  test('the value is still handed through untouched and still works', () => {
    const raw = new Set(['a'])
    const p = watchProxy({ tags: raw })
    expect(p.tags).toBe(raw)
    expect(() => p.tags.add('b')).not.toThrow()
    expect(p.tags.has('b')).toBe(true)
  })

  test('a plain object or array says nothing', () => {
    const p = watchProxy({ list: [1, 2], nested: { a: 1 } })
    p.list
    p.nested
    expect(said()).toEqual([])
  })

  test('an opaque value that is not a container says nothing', () => {
    // A RegExp or a Promise is inert too, but nobody expects mutating one to
    // render — the warning would be noise on every read of either.
    const p = watchProxy({ re: /x/, job: Promise.resolve(1) })
    p.re
    p.job
    expect(said()).toEqual([])
  })
})
