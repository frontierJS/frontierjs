// watch-proxy-staleness.test.js
//
// `_getNestedProxy` cached child proxies by path alone, so replacing an
// object-valued property left the previous child proxy in place permanently:
//
//   cart.items = ['c']
//   cart.items      // → ['c']       raw object, correct
//   proxy.items     // → ['a','b']   stale child proxy
//
// A template reading `{cart.items}` therefore rendered the *previous* value
// after any reassignment. Primitives were unaffected, and mutation-in-place
// (`items.push`) worked fine, which made it look intermittent — only
// reassignment of an object-valued property was broken, and only through the
// proxy.
//
// The cache now keys on path AND the object that path currently holds, so it
// self-heals however the value changed — including writes that bypassed the
// proxy entirely.

import { describe, test, expect, beforeAll } from 'vitest'

let watchProxy, watchPath, createEffect, untrack, flushSync

beforeAll(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  for (const k of ['document', 'HTMLElement', 'Node', 'Event']) {
    try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
  }
  globalThis.window = win
  ;({ watchProxy, watchPath, createEffect, untrack, flushSync } = await import('./runtime.js'))
})

describe('child proxies do not go stale', () => {

  test('reassigning an object property is visible through the proxy', () => {
    const cart = { items: ['a'] }
    const p = watchProxy(cart)
    expect(p.items).toEqual(['a'])
    p.items = ['c']
    expect(p.items).toEqual(['c'])
  })

  test('repeated reassignment keeps working', () => {
    const o = { list: [1] }
    const p = watchProxy(o)
    p.list = [2];    expect(p.list).toEqual([2])
    p.list = [3, 4]; expect(p.list).toEqual([3, 4])
    p.list = [];     expect(p.list).toEqual([])
  })

  test('mutation in place still works', () => {
    const cart = { items: ['a'] }
    const p = watchProxy(cart)
    p.items.push('b')
    expect(p.items).toEqual(['a', 'b'])
  })

  test('a raw write that bypasses the proxy is picked up on next read', () => {
    // The cache compares the held object, so it heals even when the write
    // never went through the set trap.
    const cart = { items: ['a'] }
    const p = watchProxy(cart)
    expect(p.items).toEqual(['a'])
    cart.items = ['raw']
    expect(p.items).toEqual(['raw'])
  })

  test('replacing a parent invalidates descendants', () => {
    const o = { nested: { deep: { n: 1 } } }
    const p = watchProxy(o)
    expect(p.nested.deep).toEqual({ n: 1 })
    p.nested = { deep: { n: 9 } }
    expect(p.nested.deep).toEqual({ n: 9 })
  })

  test('primitives were never affected, and still are not', () => {
    const o = { name: 'x' }
    const p = watchProxy(o)
    p.name = 'y'
    expect(p.name).toBe('y')
  })

  test('proxy and raw object agree after every kind of write', () => {
    const o = { a: { v: 1 }, b: 1 }
    const p = watchProxy(o)
    p.a = { v: 2 }
    p.b = 2
    o.a = { v: 3 }
    expect(p.a).toEqual(o.a)
    expect(p.b).toBe(o.b)
  })
})

describe('watchers see the new value, not the cached one', () => {

  test('a path watcher reads the replacement', () => {
    const cart = { items: ['a'] }
    const p = watchProxy(cart)
    const [watch] = watchPath(cart, 'items')

    const seen = []
    let first = true
    createEffect(() => {
      watch()
      const v = p.items
      if (first) { first = false; return }
      untrack(() => seen.push([...v]))
    })
    flushSync()

    p.items = ['c']
    flushSync()
    p.items = ['d', 'e']
    flushSync()

    // Before the fix both entries were the original array.
    expect(seen).toEqual([['c'], ['d', 'e']])
  })
})
