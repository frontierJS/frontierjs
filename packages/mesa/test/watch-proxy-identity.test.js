// watch-proxy-identity.test.js
//
// FJS-849 / FJS-853 — through the watch proxy an object was not equal to
// itself.
//
// Child proxies were cached BY PATH, so one object reachable at two paths got
// two distinct proxies, and the get trap always hands back the proxy rather
// than the raw object. `state.selected = state.items[0]` then made
// `state.selected === state.items[0]` false, `indexOf` -1, `Set.has` false and
// an {#each} keyed on the object rebuild every row on every render.
//
// The second builder, for a local `let` under a bare `$:` deep watch, had no
// cache at all, so `obj.child === obj.child` was false within one expression.
//
// The cache is keyed by the target object now, one WeakMap per store, and the
// watch node — the thing the path key was really carrying — is a list on the
// entry, so an object reached at two paths subscribes and fires at both.

import { describe, test, expect, beforeAll } from 'vitest'

let watchProxy, localWatchProxy, watchPath, createEffect, flushSync

beforeAll(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  for (const k of ['document', 'HTMLElement', 'Node', 'Event']) {
    try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
  }
  globalThis.window = win
  ;({ watchProxy, localWatchProxy, watchPath, createEffect, flushSync } = await import('../src/runtime.js'))
})

// A local watch map of the shape the compiler emits: '' is the whole object.
function localProxy(obj) {
  const fired = []
  const map = { '': [() => {}, () => fired.push('')] }
  return [localWatchProxy(obj, map), fired]
}

describe('one object, one proxy — imported state', () => {

  test('an aliased object is equal to itself', () => {
    const state = { items: [{ id: 1 }, { id: 2 }], selected: null }
    const p = watchProxy(state)
    p.selected = p.items[0]
    expect(p.selected === p.items[0]).toBe(true)
  })

  test('indexOf, includes and Set.has find an aliased object', () => {
    const state = { items: [{ id: 1 }, { id: 2 }], selected: null }
    const p = watchProxy(state)
    p.selected = p.items[1]
    expect(p.items.indexOf(p.selected)).toBe(1)
    expect(p.items.includes(p.selected)).toBe(true)
    expect(new Set(p.items).has(p.selected)).toBe(true)
  })

  test('the same object read twice at one path is one proxy', () => {
    const p = watchProxy({ a: { b: 1 } })
    expect(p.a === p.a).toBe(true)
  })

  test('a cycle reaches the same proxy rather than one per hop', () => {
    const root = { n: 1 }
    root.self = root
    const p = watchProxy(root)
    expect(p.self === p).toBe(true)
    expect(p.self.self.self === p).toBe(true)
    // One entry per hop meant the walk never terminated, so a serialize died
    // with a stack overflow instead of the circular TypeError.
    expect(() => JSON.stringify(p)).toThrow(TypeError)
  })

  test('a replaced value still self-heals', () => {
    const cart = { items: ['a'] }
    const p = watchProxy(cart)
    const first = p.items
    p.items = ['c']
    expect(p.items).toEqual(['c'])
    expect(p.items === first).toBe(false)
  })
})

describe('one object, one proxy — a local let', () => {

  test('a nested object is equal to itself across two reads', () => {
    const [p] = localProxy({ child: { n: 1 } })
    expect(p.child === p.child).toBe(true)
  })

  test('an aliased object is equal to itself', () => {
    const [p] = localProxy({ rows: [{ id: 1 }], current: null })
    p.current = p.rows[0]
    expect(p.current === p.rows[0]).toBe(true)
    expect(p.rows.indexOf(p.current)).toBe(0)
  })

  test('a write through an alias still fires the whole-object watch', () => {
    const [p, fired] = localProxy({ rows: [{ id: 1 }], current: null })
    p.current = p.rows[0]
    fired.length = 0
    p.current.id = 2
    expect(fired.length).toBeGreaterThan(0)
  })
})

describe('an alias keeps both watch positions', () => {

  test('a write through one path wakes a watch declared on the other', () => {
    const state = { items: [{ id: 1 }], selected: null }
    const p = watchProxy(state)
    const [readItems] = watchPath(state, 'items')

    p.selected = p.items[0]
    // Reach the row through `selected` — a path-keyed proxy would carry only
    // that node, so the write below would never reach the `items` watch.
    const row = p.selected

    let runs = 0
    createEffect(() => { readItems(); runs++ })
    flushSync?.()
    const before = runs

    row.id = 99
    flushSync?.()
    expect(runs).toBeGreaterThan(before)
  })
})
