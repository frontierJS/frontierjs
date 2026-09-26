// effect-async-teardown.test.js
//
// An async effect body returns its teardown when its promise resolves, which is
// after the run that made it may already be over. It was stored on the node
// whatever the node was by then: disposed first, the teardown never ran — an
// async `$:` returning `() => ws.close()` on a component that unmounted early
// left the socket open for the life of the page — and run again first, it was
// called beside a later run's teardown, one run late (`FJS-1328`).

import { describe, test, expect, beforeAll } from 'vitest'

let createSignal, createEffect, createRoot, flushSync

beforeAll(async () => {
  ;({ createSignal, createEffect, createRoot, flushSync } = await import('../src/runtime.js'))
})

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('an async effect\'s teardown', () => {
  test('runs when the effect was disposed before it arrived', async () => {
    let closed = 0
    const dispose = createRoot((dispose) => {
      createEffect(async () => { await null; return () => closed++ })
      return dispose
    })
    dispose()
    await tick()
    expect(closed).toBe(1)
  })

  test('runs when its run is superseded before it arrived', async () => {
    const [n, setN] = createSignal(0)
    const log = []
    createRoot(() => {
      createEffect(async () => {
        const v = n()
        await null
        return () => log.push('cleanup ' + v)
      })
    })
    setN(1)
    flushSync()
    await tick()
    // Run 0's teardown arrived after run 1 began, so it is called then.
    expect(log).toEqual(['cleanup 0'])

    setN(2)
    flushSync()
    await tick()
    // Run 1's teardown was stored and runs before run 2, alone.
    expect(log).toEqual(['cleanup 0', 'cleanup 1'])
  })

  test('is stored, not called, while its run is current', async () => {
    let closed = 0
    const dispose = createRoot((dispose) => {
      createEffect(async () => { await null; return () => closed++ })
      return dispose
    })
    await tick()
    expect(closed).toBe(0)
    dispose()
    expect(closed).toBe(1)
  })
})
