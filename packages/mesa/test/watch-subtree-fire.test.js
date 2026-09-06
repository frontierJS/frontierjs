// watch-subtree-fire.test.js
//
// A write notifies every watch that COVERS the written path and every watch
// BENEATH it. The ancestor half was fixed once; the descendant half never was,
// so replacing a nested object left every watch on a path inside it silent:
//
//   $: page.data.title        // the watch the compiler emits for a template
//   page.data = { … }         // the move a router makes on every navigation
//
// `_watchFire` walked from the written key upward only, so the watch on
// `data.title` — whose value had just changed — was never fired and the screen
// kept rendering the previous page (`FJS-832`).

import { describe, test, expect, beforeAll } from 'vitest'

let watchProxy, watchPath, createEffect, flushSync

beforeAll(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  for (const k of ['document', 'HTMLElement', 'Node', 'Event']) {
    try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
  }
  globalThis.window = win
  ;({ watchProxy, watchPath, createEffect, flushSync } = await import('../src/runtime.js'))
})

/** Subscribe an effect to `path` and record what it reads there. */
function track(state, path, read) {
  const [dep] = watchPath(state, path)
  const seen = []
  createEffect(() => { dep(); seen.push(read()) })
  return seen
}

describe('a write fires the watches beneath it', () => {

  test('replacing an object notifies a watch on a path inside it', () => {
    const state = { page: { data: { title: 'one' } } }
    const p = watchProxy(state)
    const seen = track(state, 'page.data.title', () => p.page.data.title)
    expect(seen).toEqual(['one'])

    p.page.data = { title: 'two' }
    flushSync()
    expect(seen).toEqual(['one', 'two'])
  })

  test('a watch two levels below the write fires', () => {
    const state = { page: { data: { meta: { tag: 'a' } } } }
    const p = watchProxy(state)
    const seen = track(state, 'page.data.meta.tag', () => p.page.data.meta.tag)

    p.page.data = { meta: { tag: 'b' } }
    flushSync()
    expect(seen).toEqual(['a', 'b'])
  })

  test('replacing the root object reaches every watch under it', () => {
    const state = { page: { title: 'a', body: 'x' } }
    const p = watchProxy(state)
    const title = track(state, 'page.title', () => p.page.title)
    const body  = track(state, 'page.body',  () => p.page.body)

    p.page = { title: 'b', body: 'y' }
    flushSync()
    expect(title).toEqual(['a', 'b'])
    expect(body).toEqual(['x', 'y'])
  })

  test('a sibling subtree is left alone', () => {
    const state = { a: { deep: 1 }, b: { deep: 2 } }
    const p = watchProxy(state)
    const a = track(state, 'a.deep', () => p.a.deep)
    const b = track(state, 'b.deep', () => p.b.deep)

    p.a = { deep: 9 }
    flushSync()
    expect(a).toEqual([1, 9])
    expect(b).toEqual([2])
  })

  test('deleting a property fires the watches beneath it', () => {
    const state = { page: { data: { title: 'one' } } }
    const p = watchProxy(state)
    const seen = track(state, 'page.data.title', () => p.page.data?.title)

    delete p.page.data
    flushSync()
    expect(seen).toEqual(['one', undefined])
  })

  test('the ancestor direction still holds', () => {
    const state = { page: { data: { title: 'one' } } }
    const p = watchProxy(state)
    const seen = track(state, 'page', () => p.page.data.title)

    p.page.data.title = 'two'
    flushSync()
    expect(seen).toEqual(['one', 'two'])
  })

  test('a write to a path nobody declared costs no descendant walk', () => {
    // The hot case: an undeclared leaf has no trie node, so there is no
    // subtree to walk and the write is the ancestor walk it always was.
    const state = { page: { data: { title: 'one' } }, hot: 0 }
    const p = watchProxy(state)
    const seen = track(state, 'page.data.title', () => p.page.data.title)

    for (let i = 1; i <= 3; i++) p.hot = i
    flushSync()
    expect(seen).toEqual(['one'])
  })
})
