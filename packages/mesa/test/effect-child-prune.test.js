// effect-child-prune.test.js
//
// An effect that creates an effect leaked one child per re-run. `_run()` clears
// its cleanups and its dependencies and left `_children` alone, because a block
// owner disposes its own branch — true of `ifBlock` and `keyBlock`, whose owner
// nodes are inert holders, and false of anything a plain `createEffect` builds
// in its body. After fifty re-runs, fifty-one inner effects were live and all
// of them ran (`FJS-852`).
//
// The two halves have to be told apart: a block owner's node must survive the
// re-run, or an `{#if}` whose condition re-evaluates to the same branch would
// tear that branch down under itself — the bug the comment in `_run` records.

import { describe, test, expect, beforeAll } from 'vitest'

let createSignal, createEffect, createRoot, flushSync, ifBlock, onCleanup, portal

beforeAll(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  for (const k of ['document', 'HTMLElement', 'Node', 'Event', 'Comment']) {
    try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
  }
  globalThis.window = win
  ;({ createSignal, createEffect, createRoot, flushSync, ifBlock, onCleanup, portal } =
    await import('../src/runtime.js'))
})

describe('an effect prunes the effects it created itself', () => {

  test('a nested effect does not accumulate across re-runs', () => {
    const [outer, setOuter] = createSignal(0)
    const [inner, setInner] = createSignal(0)
    let innerRuns = 0

    createRoot(() => {
      createEffect(() => {
        outer()
        createEffect(() => { inner(); innerRuns++ })
      })
    })
    expect(innerRuns).toBe(1)

    for (let i = 1; i <= 5; i++) { setOuter(i); flushSync() }
    // Six creations, one per outer run, and every one of them ran once.
    expect(innerRuns).toBe(6)

    innerRuns = 0
    setInner(1)
    flushSync()
    // Only the child the LAST outer run created is still subscribed.
    expect(innerRuns).toBe(1)
  })

  test('a pruned child runs its cleanup', () => {
    const [outer, setOuter] = createSignal(0)
    const cleaned = []

    createRoot(() => {
      createEffect(() => {
        const n = outer()
        createEffect(() => { onCleanup(() => cleaned.push(n)) })
      })
    })

    setOuter(1)
    flushSync()
    expect(cleaned).toEqual([0])
    setOuter(2)
    flushSync()
    expect(cleaned).toEqual([0, 1])
  })

  test('a block owner node survives its owning effect re-running', () => {
    // `ifBlock`'s condition effect creates a branch owner and disposes it
    // itself when the branch changes. Pruning it on re-run would tear down a
    // branch that is staying put — the failure the comment in `_run` records.
    const [cond, setCond] = createSignal(true)
    const [label, setLabel] = createSignal('a')
    const seen = []

    const parent = document.createElement('div')
    const anchor = document.createComment('')
    parent.appendChild(anchor)

    createRoot(() => {
      ifBlock(anchor, () => (cond() ? 0 : null), [
        () => {
          // Stands in for a render inside the branch: it must keep tracking
          // after the condition effect has re-run without changing branch.
          createEffect(() => seen.push(label()))
          return document.createElement('span')
        }
      ])
    })
    flushSync()
    expect(seen).toEqual(['a'])

    // Re-run the condition without changing the branch.
    setCond(true)
    flushSync()
    setLabel('b')
    flushSync()
    expect(seen).toEqual(['a', 'b'])
  })

  test('a portal keeps its content when its target expression re-evaluates', () => {
    // The portal builds its content in an effect body and returns early when
    // the target has not moved, so its content is exactly what pruning would
    // take away — and it is not rebuilt afterwards. `@frontierjs/ui`'s global
    // alert showed once and then never changed its text again.
    const [tick, setTick] = createSignal(0)
    const [label, setLabel] = createSignal('a')
    const seen = []

    createRoot(() => {
      portal(() => { tick(); return document.body }, () => {
        createEffect(() => seen.push(label()))
        return document.createElement('span')
      })
    })
    flushSync()
    expect(seen).toEqual(['a'])

    setTick(1)
    flushSync()
    setLabel('b')
    flushSync()
    expect(seen).toEqual(['a', 'b'])
  })
})
