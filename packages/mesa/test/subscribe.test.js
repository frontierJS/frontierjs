// subscribe.test.js
//
// `subscribe(start)` is the one reactive shape `src/browser/` is built from:
// one platform listener shared by every effect that reads it, started on the
// first reader and stopped at zero (`IDEAS/browser-kit.md` § The primitive).
// The counting is per node and the stop waits a microtask, because an effect's
// re-run clears its cleanups and reads again in the same tick — a per-run
// count tore the listener down and started it again on every update.

import { describe, test, expect, beforeAll, afterEach } from 'vitest'

let rt

beforeAll(async () => {
  rt = await import('../src/runtime.js')
})

afterEach(() => rt.setRenderEnvironment(true, true))

const tick = () => new Promise((r) => setTimeout(r, 0))

function fake() {
  const log = { starts: 0, stops: 0, update: null }
  const track = rt.subscribe((update) => {
    log.starts++
    log.update = update
    return () => log.stops++
  })
  return { log, track }
}

describe('subscribe(start)', () => {
  test('starts once across two readers and stops when the last is disposed', async () => {
    const { log, track } = fake()
    let runs = 0
    const dispose = rt.createRoot((dispose) => {
      rt.createEffect(() => { track(); runs++ })
      rt.createEffect(() => { track(); runs++ })
      return dispose
    })
    expect(log.starts).toBe(1)
    expect(runs).toBe(2)

    log.update()
    rt.flushSync()
    expect(runs).toBe(4)
    expect(log.starts).toBe(1)

    dispose()
    expect(log.stops).toBe(0)
    await tick()
    expect(log.stops).toBe(1)
  })

  test('an effect re-run neither stops nor restarts the listener', async () => {
    const { log, track } = fake()
    const [n, setN] = rt.createSignal(0)
    const dispose = rt.createRoot((dispose) => {
      rt.createEffect(() => { n(); track() })
      return dispose
    })
    setN(1); rt.flushSync()
    setN(2); rt.flushSync()
    await tick()
    expect(log.starts).toBe(1)
    expect(log.stops).toBe(0)
    dispose()
    await tick()
    expect(log.stops).toBe(1)
  })

  test('a memo is a reader too, and its recompute does not restart', async () => {
    const { log, track } = fake()
    let seen
    const dispose = rt.createRoot((dispose) => {
      const m = rt.createMemo(() => { track(); return log.starts })
      rt.createEffect(() => { seen = m() })
      return dispose
    })
    expect(seen).toBe(1)
    log.update(); rt.flushSync()
    log.update(); rt.flushSync()
    await tick()
    expect(log.starts).toBe(1)
    dispose()
    await tick()
    expect(log.stops).toBe(1)
  })

  test('one reader leaving while another stays keeps the listener up', async () => {
    const { log, track } = fake()
    let disposeInner
    const dispose = rt.createRoot((dispose) => {
      rt.createEffect(() => track())
      disposeInner = rt.createEffect(() => track())
      return dispose
    })
    disposeInner()
    await tick()
    expect(log.stops).toBe(0)
    dispose()
    await tick()
    expect(log.stops).toBe(1)
  })

  test('a reader arriving in the tick the last one left keeps the listener up', async () => {
    const { log, track } = fake()
    const first = rt.createRoot((dispose) => { rt.createEffect(() => track()); return dispose })
    first()
    const second = rt.createRoot((dispose) => { rt.createEffect(() => track()); return dispose })
    await tick()
    expect(log.starts).toBe(1)
    expect(log.stops).toBe(0)
    second()
    await tick()
    expect(log.stops).toBe(1)
  })

  test('outside an effect it tracks nothing and starts nothing', () => {
    const { log, track } = fake()
    track()
    rt.untrack(track)
    expect(log.starts).toBe(0)
  })

  test('on a server render start never runs', () => {
    rt.setRenderEnvironment(true, false)
    const { log, track } = fake()
    const dispose = rt.createRoot((dispose) => { rt.createEffect(() => track()); return dispose })
    expect(log.starts).toBe(0)
    dispose()
  })
})

describe('isBrowserClient()', () => {
  test('is the pair, not either flag', () => {
    expect(rt.isBrowserClient()).toBe(true)
    rt.setRenderEnvironment(true, false)
    expect(rt.isBrowserClient()).toBe(false)
    rt.setRenderEnvironment(false, true)
    expect(rt.isBrowserClient()).toBe(false)
  })
})

describe('delegationRootOf(el)', () => {
  test('is the nearest registered root, null with none, and crosses a shadow host', () => {
    const outer = document.createElement('div')
    const inner = document.createElement('section')
    const leaf  = document.createElement('button')
    outer.appendChild(inner)
    inner.appendChild(leaf)
    document.body.appendChild(outer)

    expect(rt.delegationRootOf(leaf)).toBe(null)
    expect(rt.delegationRootOf(null)).toBe(null)

    const releaseOuter = rt._registerDelegateRoot(outer)
    expect(rt.delegationRootOf(leaf)).toBe(outer)
    expect(rt.delegationRootOf(outer)).toBe(outer)

    const releaseInner = rt._registerDelegateRoot(inner)
    expect(rt.delegationRootOf(leaf)).toBe(inner)
    expect(rt.delegationRootOf(outer)).toBe(outer)

    const host   = document.createElement('div')
    const shadow = host.attachShadow({ mode: 'open' })
    const shaded = document.createElement('span')
    shadow.appendChild(shaded)
    inner.appendChild(host)
    expect(rt.delegationRootOf(shaded)).toBe(inner)
    const releaseShadow = rt._registerDelegateRoot(shadow)
    expect(rt.delegationRootOf(shaded)).toBe(shadow)

    releaseShadow(); releaseInner(); releaseOuter()
    expect(rt.delegationRootOf(leaf)).toBe(null)
    outer.remove()
  })
})

// bindWindow is the first consumer of subscribe(): one resize listener however
// many <mesa:window bind:innerWidth> and bind:innerHeight are mounted, gone
// when the last unmounts, and under renderToHTML an initial read with no
// listener at all.
describe('bindWindow(prop, setter) on subscribe', () => {
  const counts = () => {
    const added = [], removed = []
    const add = window.addEventListener, rm = window.removeEventListener
    window.addEventListener = (ev, fn, o) => { added.push(ev); add.call(window, ev, fn, o) }
    window.removeEventListener = (ev, fn, o) => { removed.push(ev); rm.call(window, ev, fn, o) }
    return { added, removed, restore() { window.addEventListener = add; window.removeEventListener = rm } }
  }

  test('reads synchronously, shares one resize listener, re-reads on the event, stops at zero', async () => {
    const c = counts()
    try {
      const [w, setW] = rt.createSignal(-1)
      const [h, setH] = rt.createSignal(-1)
      const dispose = rt.createRoot((dispose) => {
        rt.bindWindow('innerWidth', setW)
        rt.bindWindow('innerHeight', setH)
        return dispose
      })
      expect(w()).toBe(window.innerWidth)
      expect(h()).toBe(window.innerHeight)
      expect(c.added.filter((e) => e === 'resize').length).toBe(1)

      window.innerWidth = 333
      window.dispatchEvent(new Event('resize'))
      rt.flushSync()
      expect(w()).toBe(333)

      dispose()
      await tick()
      expect(c.removed.filter((e) => e === 'resize').length).toBe(1)
    } finally { c.restore() }
  })

  test('on a server render the initial value lands and no listener is added', () => {
    rt.setRenderEnvironment(true, false)
    const c = counts()
    try {
      const [w, setW] = rt.createSignal(-1)
      const dispose = rt.createRoot((dispose) => { rt.bindWindow('innerWidth', setW); return dispose })
      expect(w()).toBe(window.innerWidth)
      expect(c.added).toEqual([])
      dispose()
    } finally { c.restore() }
  })

  test('on a terminal there is no window and nothing happens', () => {
    rt.setRenderEnvironment(false, true)
    const [w, setW] = rt.createSignal(-1)
    rt.bindWindow('innerWidth', setW)
    expect(w()).toBe(-1)
  })
})
