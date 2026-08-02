// watch-handler-defer.test.js
//
// `$: deps, handler` is deferred: the handler does not run on mount, only on
// change. And it receives the previous value alongside the current one.
//
// Deferring is only possible because the deps are explicit — the effect still
// reads them on the first run to subscribe, and withholds only the handler. An
// auto-tracked `$: { }` block cannot do this: it discovers its dependencies BY
// running, so skipping the body would subscribe to nothing and never fire
// again. That constraint is why Solid's `defer` lives on `on()` rather than on
// bare `createEffect`, and it is why Mesa's two effect forms differ here rather
// than by convention.
//
// Deferring also makes `prev` well defined. Firing on mount would mean the
// first invocation always had `prev === undefined`, so every handler would need
// a guard; deferred, the first invocation IS the first change.

import { describe, test, expect, beforeAll } from 'vitest'
import { compileSource } from './compiler.js'

let createSignal, createEffect, untrack, flushSync, watchProxy, watchPath

beforeAll(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  for (const k of ['document', 'HTMLElement', 'Node', 'Event', 'DocumentFragment']) {
    try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
  }
  globalThis.window = win
  ;({ createSignal, createEffect, untrack, flushSync, watchProxy, watchPath } =
    await import('./runtime.js'))
})

const compile = (script) =>
  compileSource(`<script>\n${script}\n</script><p>{1}</p>`, { filename: '/t/T.mesa', dev: false })

// ─── Emitted shape ────────────────────────────────────────────────────────────

describe('emitted shape', () => {

  test('a watch+handler emits deferral state and passes (value, prev)', async () => {
    const { result } = await compile(
      `let userId = 1\nfunction reset(){}\n$: userId, (id, prev) => reset(id, prev)`)
    expect(result).toMatch(/let \$\$prev_wh0; let \$\$first_wh0 = true;/)
    expect(result).toMatch(/\$\$first_wh0.*=\s*false/)
    expect(result).toMatch(/\(\$\$v, \$\$p\)/)
  })

  test('a single dep passes the value directly, not wrapped', async () => {
    const { result } = await compile(`let a = 1\nfunction f(){}\n$: a, () => f()`)
    expect(result).toMatch(/const \$\$v = \$runtime\.get\(\$\$sig_a\);/)
  })

  test('multiple deps pass an array', async () => {
    const { result } = await compile(`let a = 1, b = 2\nfunction f(){}\n$: (a, b), () => f()`)
    expect(result).toMatch(/const \$\$v = \[.*\$\$sig_a.*\$\$sig_b.*\];/)
  })

  test('a path on an imported object subscribes and reads separately', async () => {
    // The watch signal carries no value — it is a bare change notification —
    // so the value has to come off the proxy.
    const { result } = await compile(
      `import { cart } from './s.js'\nfunction f(){}\n$: cart.total, () => f()`)
    expect(result).toMatch(/\$\$watch_cart_total\(\)/)          // subscribe
    expect(result).toMatch(/const \$\$v = \$\$proxy_cart\.total;/) // value
  })

  test('an auto-tracked block is NOT deferred', async () => {
    const { result } = await compile(`let a = 1\nfunction f(){}\n$: { f(a) }`)
    expect(result).not.toMatch(/\$\$first_wh/)
  })
})

// ─── Runtime semantics ────────────────────────────────────────────────────────
// Exercising the emitted pattern directly; compiling and mounting a component
// per case would test the same three lines through much more machinery.

function deferred(readDep, handler) {
  let prev, first = true
  return createEffect(() => {
    const v = readDep()
    if (first) { first = false; prev = v; return }
    const p = prev; prev = v
    return untrack(() => handler(v, p))
  }, { user: true })
}

describe('deferral', () => {

  test('does not run on mount', () => {
    const [a] = createSignal('x')
    const log = []
    deferred(a, (v) => log.push(v))
    flushSync()
    expect(log).toEqual([])
  })

  test('runs on every subsequent change', () => {
    const [a, setA] = createSignal('x')
    const log = []
    deferred(a, (v) => log.push(v))
    flushSync()
    setA('y'); flushSync()
    setA('z'); flushSync()
    expect(log).toEqual(['y', 'z'])
  })

  test('disposing stops it', () => {
    const [a, setA] = createSignal(0)
    const log = []
    const dispose = deferred(a, (v) => log.push(v))
    flushSync()
    setA(1); flushSync()
    dispose()
    setA(2); flushSync()
    expect(log).toEqual([1])
  })
})

describe('previous value', () => {

  test('the first invocation already has a real previous value', () => {
    // This is what deferral buys: no undefined-on-first-run to guard against.
    const [a, setA] = createSignal('x')
    const log = []
    deferred(a, (v, p) => log.push(`${p}→${v}`))
    flushSync()
    setA('y'); flushSync()
    expect(log).toEqual(['x→y'])
  })

  test('prev tracks across several changes', () => {
    const [a, setA] = createSignal(1)
    const log = []
    deferred(a, (v, p) => log.push(`${p}→${v}`))
    flushSync()
    setA(2); flushSync()
    setA(3); flushSync()
    expect(log).toEqual(['1→2', '2→3'])
  })

  test('multiple deps give arrays for both', () => {
    const [a, setA] = createSignal(1)
    const [b, setB] = createSignal(10)
    const log = []
    deferred(() => [a(), b()], (v, p) => log.push(`[${p}]→[${v}]`))
    flushSync()
    setA(2); flushSync()
    setB(20); flushSync()
    expect(log).toEqual(['[1,10]→[2,10]', '[2,10]→[2,20]'])
  })

  test('a replaced object gives a genuine previous value', () => {
    const cart = { items: ['a'] }
    const p = watchProxy(cart)
    const [watch] = watchPath(cart, 'items')
    const log = []
    deferred(() => { watch(); return p.items }, (v, prev) => log.push([prev, v]))
    flushSync()
    p.items = ['b']; flushSync()
    expect(log).toEqual([[['a'], ['b']]])
  })

  test('a MUTATED object gives the same reference for both — documented limit', () => {
    // prev holds a reference. Mutation in place cannot produce a distinct
    // previous value without deep-cloning every read, so it doesn't.
    const cart = { items: ['a'] }
    const p = watchProxy(cart)
    const [watch] = watchPath(cart, 'items')
    let sameRef = null
    deferred(() => { watch(); return p.items }, (v, prev) => { sameRef = prev === v })
    flushSync()
    p.items.push('b'); flushSync()
    expect(sameRef).toBe(true)
  })
})
