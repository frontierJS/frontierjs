// effect-phase.test.js
//
// Renders, control flow and user effects were all the same kind of node in one
// queue, so their relative order fell out of creation order. Because the
// compiler emits the `<script>` before the template, a `$:` effect ran BEFORE
// the DOM it was reacting to had been updated:
//
//   $: items, () => { count = el.childNodes.length }   // always one update stale
//
// That is inverted from both frameworks people arrive from. Solid's
// createEffect runs after the render phase completes (createRenderEffect is the
// during-render tier); Svelte's $effect runs after the DOM updates, with
// $effect.pre as the opt-out. Mesa now agrees: user effects drain after
// everything that builds the DOM.
//
// The split is by *user effect*, not by *render*. Control flow — ifBlock,
// keyBlock, awaitBlock — builds DOM and must keep its existing order relative to
// renders: an ifBlock's condition has to run before the renders inside its
// branch, or those renders fire against a branch that is about to be disposed.
// Tagging renders instead of user effects broke exactly that, and compiler.test
// caught it.

import { describe, test, expect, beforeAll } from 'vitest'

let createSignal, createEffect, render, flushSync, ifBlock

beforeAll(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  for (const k of ['document', 'HTMLElement', 'Node', 'Event', 'DocumentFragment']) {
    try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
  }
  globalThis.window = win
  ;({ createSignal, createEffect, render, flushSync, ifBlock } = await import('../src/runtime.js'))
})

describe('user effects run after the DOM updates', () => {

  test('an effect measuring rendered output sees the new DOM', () => {
    const el = globalThis.document.createElement('div')
    const [items, setItems] = createSignal(['a'])

    let measured = null
    // as the compiler emits for `$: items, () => …`
    createEffect(() => { items(); measured = el.childNodes.length }, { user: true })
    // the template's render block, created afterwards
    render(() => { el.innerHTML = items().map(i => `<p>${i}</p>`).join('') })
    flushSync()

    setItems(['a', 'b', 'c'])
    flushSync()
    expect(measured).toBe(3)

    setItems(['a', 'b', 'c', 'd'])
    flushSync()
    expect(measured).toBe(4)
  })

  test('declaration order no longer decides the phase', () => {
    // The same pairing with the render created FIRST must behave identically.
    const el = globalThis.document.createElement('div')
    const [items, setItems] = createSignal(['a'])
    let measured = null

    render(() => { el.innerHTML = items().map(i => `<p>${i}</p>`).join('') })
    createEffect(() => { items(); measured = el.childNodes.length }, { user: true })
    flushSync()

    setItems(['a', 'b'])
    flushSync()
    expect(measured).toBe(2)
  })

  test('an untagged effect still runs in the DOM phase', () => {
    // Runtime internals (control flow, watch-proxy refresh) must not be
    // deferred — they are part of building the DOM.
    const order = []
    const [n, setN] = createSignal(1)

    createEffect(() => { n(); order.push('internal') })              // untagged
    render(() => { n(); order.push('render') })
    createEffect(() => { n(); order.push('user') }, { user: true })
    flushSync()
    order.length = 0

    setN(2)
    flushSync()
    expect(order).toEqual(['internal', 'render', 'user'])
  })
})

describe('DOM-building order is preserved', () => {

  test('a parent control-flow effect still runs before its children', () => {
    // The regression that tagging renders introduced: inner renders fired
    // against a branch the ifBlock was about to dispose.
    const order = []
    const [show, setShow] = createSignal(true)

    createEffect(() => { show(); order.push('parent-controlflow') })   // untagged
    render(() => { show(); order.push('child-render') })
    flushSync()
    order.length = 0

    setShow(false)
    flushSync()
    expect(order).toEqual(['parent-controlflow', 'child-render'])
  })
})

describe('effects triggered by effects keep the ordering', () => {

  test('a render queued by a user effect runs before the next user effect', () => {
    const order = []
    const [a, setA] = createSignal(0)
    const [b, setB] = createSignal(0)

    render(() => { b(); order.push('render(b)') })
    createEffect(() => { b(); order.push('user(b)') }, { user: true })
    createEffect(() => { a(); if (a() > 0) setB(a()) }, { user: true })
    flushSync()
    order.length = 0

    setA(1)
    flushSync()

    // The write to b happens inside a user effect, so b's render and b's user
    // effect are picked up by the next pass — render first.
    expect(order.indexOf('render(b)')).toBeLessThan(order.indexOf('user(b)'))
  })
})
