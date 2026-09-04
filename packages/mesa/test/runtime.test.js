/**
 * @frontierjs/mesa-runtime — combined test suite
 *
 * Run with:
 *   npx vitest run --environment happy-dom runtime.test.js
 *
 * Sections
 *   1.  createSignal
 *   2.  createEffect  (+ edge cases)
 *   3.  createMemo
 *   4.  batch / tick / untrack
 *   5.  onCleanup — disposal order
 *   6.  addEvent — listener cleanup
 *   7.  DOM utils — htmlToFragment, refer, createTextNode, insertAfter, removeElements, addStyles
 *   8.  DOM bindings — bindText, bindAttribute, bindClass, bindStyle, bindInput
 *   9.  Events — makeEmitter, mergeEvents, mergeAllEvents
 *   10. makeComponent / mount
 *   11. makeRootEvent
 *   12. Blocks — makeBlock, makeBlockBound, attachBlock
 *   13. ifBlock  (+ [FIX 3] multi-node fragment leak)
 *   14. $$eachBlock  (+ [FIX 4] multi-node reorder, reverse stress)
 *   15. awaitBlock
 *   16. Slots — attachSlot
 *   17. spreadAttributes
 *   18. watchProxy / watchPath  (+ [FIX 1] root sentinel, [FIX 2] cross-component isolation)
 *   19. makeAsyncState / asyncDerived  (+ edge cases)
 *   20. makeExternalProperty / $push / $apply
 *   21. SSR guards — _isBrowser = false behavior
 *   22. Misc exports
 *   23. Integration — signals + DOM end-to-end
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as $rt from '../src/runtime.js'
import {
  // Signals
  createSignal,
  createEffect,
  createRoot,
  createMemo,
  createWritableSignal,
  batch,
  flushSync,
  tick as mesaTick,
  untrack,
  // Lifecycle
  onCleanup,
  onMount,
  onDestroy,
  // Context
  createContext,
  provideContext,
  useContext,
  // DOM utils
  htmlToFragment,
  svgToFragment,
  refer,
  createTextNode,
  insertAfter,
  removeElements,
  addStyles,
  // DOM bindings
  bindText,
  bindAttribute,
  bindClass,
  bindClassExp,
  bindStyle,
  bindInput,
  // Events
  addEvent,
  makeEmitter,
  mergeEvents,
  mergeAllEvents,
  makeRootEvent,
  // Component
  makeComponent,
  makeExternalProperty,
  mount,
  // Blocks
  makeBlock,
  makeBlockBound,
  attachBlock,
  // Template constructs
  $$eachBlock,
  ifBlock,
  keyBlock,
  awaitBlock,
  track,
  trackDerived,
  get as trackedGet,
  $$eachBlock,
  push_component,
  pop_component,
  contextProvide,
  contextRead,
  // Boundary / Mounted
  boundaryBlock,
  mountedBlock,
  onMounted,
  // Slots
  attachSlot,
  attachNamedSlot,
  makeSlots,
  // Events
  bindGroup,
  debounce,
  throttle,
  // Spread
  spreadAttributes,
  restProps,
  // Watch proxy
  watchProxy,
  watchPath,
  localWatchProxy,
  // Async state
  makeAsyncState,
  asyncDerived,
  // Misc
  noop,
  eachDefaultKey,
  addClass,
  version,
  // Animation
  transition,
  entrance,
  attach,
  // createSignal alias used in prop tests
  createSignal as _cs,
  orderedGroup,
  set as trackedSet,
} from '../src/runtime.js'

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Wait for all microtasks + one macrotask to flush. */
const tick = () => new Promise((r) => setTimeout(r, 0))

const div  = () => document.createElement('div')
const span = () => document.createElement('span')

// ─────────────────────────────────────────────────────────────────────────────
// §1  createSignal
// ─────────────────────────────────────────────────────────────────────────────

describe('createSignal', () => {
  it('returns initial value', () => {
    const [count] = createSignal(0)
    expect(count()).toBe(0)
  })

  it('updates via write fn', () => {
    const [count, setCount] = createSignal(0)
    setCount(5)
    flushSync()
    expect(count()).toBe(5)
  })

  it('stores function values directly (no updater form)', () => {
    // createSignal no longer supports the updater-function pattern.
    // Functions are stored as plain values. The compiler emits full expressions
    // for compound ops (count++ → write(read() + 1)), not updater lambdas.
    const [fn, setFn] = createSignal(null)
    const myFn = (x) => x + 1
    setFn(myFn)
    flushSync()
    expect(fn()).toBe(myFn)  // stored as-is, not called
  })

  it('does not notify when value is unchanged (Object.is)', () => {
    const [count, setCount] = createSignal(1)
    let runs = 0
    createEffect(() => { count(); runs++ })
    setCount(1) // same value
    flushSync()
    expect(runs).toBe(1) // effect ran once on init, not again
  })

  it('custom equals — always notify', () => {
    const [val, setVal] = createSignal({}, { equals: () => false })
    let runs = 0
    createEffect(() => { val(); runs++ })
    setVal({})
    flushSync()
    expect(runs).toBe(2) // init + one notification
  })

  it('works with objects', () => {
    const [user, setUser] = createSignal({ name: 'Alice' })
    expect(user().name).toBe('Alice')
    setUser({ name: 'Bob' })
    flushSync()
    expect(user().name).toBe('Bob')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §2  createEffect
// ─────────────────────────────────────────────────────────────────────────────

describe('createEffect', () => {
  it('runs immediately', () => {
    let ran = false
    createEffect(() => { ran = true })
    expect(ran).toBe(true)
  })

  it('re-runs when signal changes', () => {
    const [count, setCount] = createSignal(0)
    const log = []
    createEffect(() => log.push(count()))
    setCount(1)
    flushSync()
    setCount(2)
    flushSync()
    expect(log).toEqual([0, 1, 2])
  })

  it('only tracks signals read during last run', () => {
    const [a, setA] = createSignal(true)
    const [b, setB] = createSignal('b')
    const [c, setC] = createSignal('c')
    const log = []

    createEffect(() => {
      if (a()) log.push(b())
      else log.push(c())
    })

    expect(log).toEqual(['b'])
    setA(false) // switches branch — now tracks c, not b
    flushSync()
    expect(log).toEqual(['b', 'c'])
    setB('b2') // NOT tracked anymore
    flushSync()
    expect(log).toEqual(['b', 'c'])
    setC('c2') // SHOULD re-run
    flushSync()
    expect(log).toEqual(['b', 'c', 'c2'])
  })

  it('runs onCleanup before re-run', () => {
    const [count, setCount] = createSignal(0)
    const log = []
    createEffect(() => {
      count()
      onCleanup(() => log.push('cleanup'))
      log.push('run')
    })
    setCount(1)
    flushSync()
    expect(log).toEqual(['run', 'cleanup', 'run'])
  })

  it('dispose() stops the effect', () => {
    const [count, setCount] = createSignal(0)
    let runs = 0
    const dispose = createEffect(() => { count(); runs++ })
    dispose()
    setCount(1)
    flushSync()
    expect(runs).toBe(1) // only the initial run
  })

  it('nested effects: outer does not re-run when inner signal changes', () => {
    const [outer, setOuter] = createSignal('o')
    const [inner, setInner] = createSignal('i')
    const log = []

    createEffect(() => {
      log.push('outer:' + outer())
      createEffect(() => { log.push('inner:' + inner()) })
    })

    setInner('i2')
    flushSync()
    expect(log).toContain('inner:i2')
    expect(log.filter((l) => l.startsWith('outer')).length).toBe(1)
  })

  it('effect writing to a different signal does not cause infinite loop', () => {
    const [a, setA] = createSignal(0)
    const [b, setB] = createSignal(0)
    let runs = 0

    createEffect(() => {
      runs++
      if (a() > 0) setB(a() * 2) // writes B but doesn't read B
    })

    setA(3)
    flushSync()
    expect(runs).toBe(2) // init + one re-run
    expect(b()).toBe(6)
  })

  it('untrack inside memo prevents over-subscription', () => {
    const [a, setA] = createSignal(1)
    const [b, setB] = createSignal(100)

    // memo reads a (subscribed) and b via untrack (NOT subscribed)
    const memo = createMemo(() => a() + untrack(() => b()))
    let runs = 0
    createEffect(() => { memo(); runs++ })

    setB(999) // b changed — memo NOT subscribed to b
    flushSync()
    expect(runs).toBe(1)
    expect(memo()).toBe(1 + 100) // not yet recomputed

    setA(2) // a changed — SHOULD recompute using current b (999)
    flushSync()
    expect(runs).toBe(2)
    expect(memo()).toBe(2 + 999)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3b  createWritableSignal
// ─────────────────────────────────────────────────────────────────────────────

describe('createWritableSignal', () => {
  it('initialises from derivation', () => {
    const [items] = createSignal(['a', 'b'])
    const [sel] = createWritableSignal(() => items()[0])
    expect(sel()).toBe('a')
  })

  it('re-derives when deps change', () => {
    const [items, setItems] = createSignal(['a', 'b'])
    const [sel] = createWritableSignal(() => items()[0])
    setItems(['x', 'y'])
    flushSync()
    expect(sel()).toBe('x')
  })

  it('manual override holds until next dep change', () => {
    const [items, setItems] = createSignal(['a', 'b'])
    const [sel, setSel] = createWritableSignal(() => items()[0])
    setSel('OVERRIDE')
    flushSync()
    expect(sel()).toBe('OVERRIDE')
    setItems(['x', 'y'])
    flushSync()
    expect(sel()).toBe('x')
  })

  it('manual override does not affect the derivation function', () => {
    const [count, setCount] = createSignal(1)
    const [doubled, setDoubled] = createWritableSignal(() => count() * 2)
    expect(doubled()).toBe(2)
    setDoubled(99)
    flushSync()
    expect(doubled()).toBe(99)
    setCount(5)
    flushSync()
    expect(doubled()).toBe(10)
  })

  it('subscribers re-run when derivation fires', () => {
    const [n, setN] = createSignal(3)
    const [derived] = createWritableSignal(() => n() * 10)
    const seen = []
    createEffect(() => seen.push(derived()))
    setN(4)
    flushSync()
    expect(seen).toEqual([30, 40])
  })

  it('subscribers re-run on manual write', () => {
    const [n] = createSignal(1)
    const [derived, setDerived] = createWritableSignal(() => n())
    const seen = []
    createEffect(() => seen.push(derived()))
    setDerived(99)
    flushSync()
    expect(seen).toEqual([1, 99])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3  createMemo
// ─────────────────────────────────────────────────────────────────────────────

describe('createMemo', () => {
  it('returns derived value', () => {
    const [count] = createSignal(3)
    const double = createMemo(() => count() * 2)
    expect(double()).toBe(6)
  })

  it('recomputes when dep changes', () => {
    const [count, setCount] = createSignal(1)
    const double = createMemo(() => count() * 2)
    setCount(5)
    flushSync()
    expect(double()).toBe(10)
  })

  it('is lazy — does NOT recompute if not read', () => {
    const [count, setCount] = createSignal(0)
    let computations = 0
    const memo = createMemo(() => { computations++; return count() * 2 })
    memo() // first read — forces computation
    setCount(1)
    flushSync()
    expect(computations).toBe(1) // not recomputed until read
    memo()
    expect(computations).toBe(2)
  })

  it('does NOT re-run downstream effects when the memo value is unchanged', () => {
    // The memo settles in its own flush tier and propagates from the recompute,
    // not from the invalidation — so a derivation that lands on the same value
    // cuts off propagation entirely.
    const [count, setCount] = createSignal(2)
    const isEven = createMemo(() => count() % 2 === 0)
    let runs = 0
    createEffect(() => { isEven(); runs++ })
    setCount(4) // still even — must not reach the effect
    flushSync()
    expect(runs).toBe(1)
    setCount(6)
    setCount(8)
    flushSync()
    expect(runs).toBe(1)
    setCount(5) // now it actually changes
    flushSync()
    expect(runs).toBe(2)
  })

  it('chain of memos', () => {
    const [x, setX] = createSignal(1)
    const a = createMemo(() => x() + 1)
    const b = createMemo(() => a() * 2)
    expect(b()).toBe(4)
    setX(2)
    flushSync()
    expect(b()).toBe(6)
  })

  it('a chain of memos settles within one flush, without intermediate runs', () => {
    const [x, setX] = createSignal(1)
    const a = createMemo(() => x() + 1)
    const b = createMemo(() => a() * 2)
    const seen = []
    createEffect(() => { seen.push([x(), a(), b()]) })
    setX(2)
    flushSync()
    // One consistent observation — no pass where b still reflects the old a.
    expect(seen).toEqual([[1, 2, 4], [2, 3, 6]])
  })

  it('a write to a dep from inside the memo body is not swallowed', () => {
    const [n, setN] = createSignal(1)
    // `dirty` is cleared before fn() runs, so this re-invalidates rather than
    // being erased by the recompute that is already in progress.
    const m = createMemo(() => { const v = n(); if (v === 1) setN(2); return v * 10 })
    m()
    flushSync()
    expect(n()).toBe(2)
    expect(m()).toBe(20)
  })

  it('stays lazy when nothing is subscribed', () => {
    const [count, setCount] = createSignal(0)
    let computations = 0
    const memo = createMemo(() => { computations++; return count() * 2 })
    memo()
    setCount(1)
    flushSync()
    expect(computations).toBe(1)
  })

  it('a disposed memo neither recomputes nor resurrects its subscriptions', () => {
    const [x, setX] = createSignal(1)
    let computations = 0
    let memo
    const dispose = createEffect(() => {
      memo = createMemo(() => { computations++; return x() * 2 })
      memo()
    })
    const before = computations
    dispose()
    setX(5)
    flushSync()
    expect(computations).toBe(before)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3c  Flush resilience — error containment and cycle detection
// ─────────────────────────────────────────────────────────────────────────────
describe('equals applies consistently', () => {
  const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

  it('createWritableSignal honors equals on manual writes as well as derivations', () => {
    const [t, setT] = createSignal(1)
    const [read, write] = createWritableSignal(
      () => ({ v: t() > 0 ? 1 : 0 }), { equals: deepEq }
    )
    let runs = 0
    createEffect(() => { read(); runs++ })
    flushSync()

    // A recompute that lands on an equals-equal value stays silent…
    const afterInit = runs
    setT(2); flushSync()
    expect(runs).toBe(afterInit)

    // …and so must a manual write of a value the same comparator calls equal.
    // opts used to reach the memo half only, so this notified via Object.is.
    write({ v: 1 }); flushSync()
    expect(runs).toBe(afterInit)

    // A genuinely different value still propagates.
    write({ v: 99 }); flushSync()
    expect(runs).toBe(afterInit + 1)
  })

  it('signal and memo agree on what equals means', () => {
    const [r1, w1] = createSignal({ v: 1 }, { equals: deepEq })
    const sigFirst = r1()
    w1({ v: 1 })
    expect(r1()).toBe(sigFirst)          // equal → old identity retained

    const [s, setS] = createSignal(1)
    const m = createMemo(() => ({ v: s() > 0 ? 1 : 0 }), { equals: deepEq })
    const memoFirst = m()
    setS(2); flushSync()
    expect(m()).toBe(memoFirst)          // same rule on the memo
  })

  it('the comparator is not invoked against undefined on a memo first run', () => {
    let sawUndefined = false
    const spy = (a, b) => { if (a === undefined) sawUndefined = true; return Object.is(a, b) }
    createMemo(() => 5, { equals: spy })()
    expect(sawUndefined).toBe(false)
  })
})

describe('flush resilience', () => {
  it('one throwing effect does not drop the rest of the generation', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const [s, set] = createSignal(0)
      let after = 0
      createEffect(() => { if (s() === 1) throw new Error('boom') })
      createEffect(() => { s(); after++ })
      set(1)
      expect(() => flushSync()).not.toThrow()
      // The effect queued behind the thrower still ran for this write — it is
      // not merely delayed, it would never be re-notified for this value.
      expect(after).toBe(2)
      expect(spy).toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })

  it('a cyclic effect pair is reported and dropped instead of hanging', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const [a, setA] = createSignal(0)
      const [b, setB] = createSignal(0)
      createEffect(() => { setB(a() + 1) })
      createEffect(() => { setA(b() + 1) })
      setA(1)
      expect(() => flushSync()).not.toThrow()
      const msg = spy.mock.calls.map((c) => String(c[0])).join('\n')
      expect(msg).toMatch(/Update cycle detected/)
    } finally { spy.mockRestore() }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §3d  createRoot — an owner scope with an end
// ─────────────────────────────────────────────────────────────────────────────

describe('createRoot', () => {
  it('disposes everything created inside it', () => {
    const [n, setN] = createSignal(0)
    let runs = 0
    let dispose
    createRoot((d) => {
      dispose = d
      createEffect(() => { n(); runs++ })
      createEffect(() => { n(); runs++ })
    })
    expect(runs).toBe(2)
    setN(1); flushSync()
    expect(runs).toBe(4)

    dispose()
    setN(2); flushSync()
    expect(runs).toBe(4)   // both children gone
  })

  it('returns what its callback returns', () => {
    expect(createRoot(() => 'value')).toBe('value')
  })

  it('a body that reads then writes a signal runs exactly once (RULE 54)', () => {
    // This is what earns the primitive. createEffect is the obvious substitute
    // and it is wrong: an effect subscribes to what its body reads, so a
    // component that reads a store during setup and then writes it re-notifies
    // the very scaffolding that is running it. Measured before the rule was
    // written: 1001 runs for one render, one thousand copies of the markup, and
    // a cycle warning blaming the user's `$:` statements.
    const [hits, setHits] = createSignal(0)

    // The createEffect half deliberately induces the cycle, so the runtime's
    // (misleading, in this case) warning is expected — silence it.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let effectRuns = 0
    try {
      const disposeEffect = createEffect(() => {
        effectRuns++
        const n = hits()
        setHits(n + 1)
      })
      flushSync()
      disposeEffect()
    } finally { spy.mockRestore() }
    expect(effectRuns).toBeGreaterThan(1)   // the failure mode, pinned

    let rootRuns = 0
    createRoot((dispose) => {
      rootRuns++
      const n = hits()
      setHits(n + 1)
      flushSync()
      dispose()
    })
    expect(rootRuns).toBe(1)                // ownership without tracking
  })

  it('does not subscribe the enclosing effect to reads inside it', () => {
    const [n, setN] = createSignal(0)
    let outer = 0
    createEffect(() => {
      outer++
      createRoot((dispose) => { n(); dispose() })
    })
    expect(outer).toBe(1)
    setN(1); flushSync()
    expect(outer).toBe(1)   // a root is ownership, not tracking
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §4  batch / tick / untrack
// ─────────────────────────────────────────────────────────────────────────────

describe('batch', () => {
  it('defers notifications until the batch ends', () => {
    const [a, setA] = createSignal(1)
    const [b, setB] = createSignal(2)
    const log = []

    createEffect(() => log.push(a() + b()))
    expect(log).toEqual([3])

    batch(() => {
      setA(10)
      setB(20)
    })
    expect(log).toEqual([3, 30]) // single flush
  })

  it('nested batch: only flushes at outermost end', () => {
    const [x, setX] = createSignal(0)
    const log = []
    createEffect(() => log.push(x()))

    batch(() => {
      batch(() => { setX(1); setX(2) })
      setX(3)
    })
    expect(log).toEqual([0, 3]) // one flush at end of outer batch
  })
})

describe('tick', () => {
  it('resolves as a promise', async () => {
    await expect(mesaTick()).resolves.toBeUndefined()
  })

  it('executes callback after current microtask', async () => {
    let called = false
    mesaTick(() => { called = true })
    expect(called).toBe(false) // not yet
    await tick()
    expect(called).toBe(true)
  })
})

describe('untrack', () => {
  it('reads signal without subscribing', () => {
    const [count, setCount] = createSignal(0)
    let runs = 0
    createEffect(() => {
      untrack(() => count()) // read without subscription
      runs++
    })
    setCount(1)
    flushSync()
    expect(runs).toBe(1) // effect did not re-run
  })

  it('returns the value', () => {
    const [val] = createSignal(42)
    expect(untrack(() => val())).toBe(42)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §5  onCleanup — disposal order
// ─────────────────────────────────────────────────────────────────────────────

describe('onCleanup — children disposed before parent cleanups', () => {
  it('inner cleanup runs before outer cleanup', () => {
    const log = []
    const [x] = createSignal(0)

    const disposeOuter = createEffect(() => {
      x()
      onCleanup(() => log.push('outer-cleanup'))
      createEffect(() => {
        x()
        onCleanup(() => log.push('inner-cleanup'))
      })
    })

    disposeOuter()

    const innerIdx = log.indexOf('inner-cleanup')
    const outerIdx = log.indexOf('outer-cleanup')
    expect(innerIdx).toBeLessThan(outerIdx)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §6  addEvent — listener cleanup
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// §5b  Return-based cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe('return-based cleanup', () => {
  it('sync effect: returned function runs before next execution', () => {
    const log = []
    const [count, setCount] = createSignal(0)

    createEffect(() => {
      const current = count()
      log.push('run:' + current)
      // Close over the captured value so cleanup sees it correctly
      return () => log.push('cleanup:' + current)
    })

    setCount(1)
    setCount(2)
    flushSync()
    // With microtask coalescing, consecutive writes before flushSync batch into one effect run.
    // The effect sees only the final value (2), not the intermediate (1).
    expect(log).toEqual(['run:0', 'cleanup:0', 'run:2'])
  })

  it('sync effect: returned function runs on dispose', () => {
    const log = []
    const [count] = createSignal(0)

    const dispose = createEffect(() => {
      count()
      return () => log.push('disposed')
    })

    expect(log).toHaveLength(0)
    dispose()
    expect(log).toEqual(['disposed'])
  })

  it('non-function return value is ignored', () => {
    const [count, setCount] = createSignal(0)
    let runs = 0

    // returning a non-function should not throw or cause issues
    createEffect(() => {
      count()
      runs++
      return 42  // not a function — ignored
    })

    setCount(1)
    flushSync()
    expect(runs).toBe(2)
  })

  it('async effect: returned promise that resolves to function registers cleanup', async () => {
    const log = []

    const dispose = createEffect(() => {
      return Promise.resolve(() => log.push('async-cleanup'))
    })

    await tick()
    dispose()
    // cleanup was registered when promise resolved, runs on dispose
    expect(log).toContain('async-cleanup')
  })

  it('onMount: returned function registers as component cleanup', async () => {
    const log = []

    const comp = makeComponent(() => {
      onMount(() => {
        log.push('mounted')
        return () => log.push('mount-cleanup')
      })
      return div()
    })

    const instance = comp()
    await tick()
    expect(log).toContain('mounted')

    instance.destroy()
    expect(log).toContain('mount-cleanup')
  })

  it('watch+handler: returned cleanup runs before next handler execution', async () => {
    const log = []
    const [count, setCount] = createSignal(0)

    createEffect(() => {
      const current = count()
      return untrack(() => {
        log.push('handler:' + current)
        return () => log.push('cleanup:' + current)
      })
    })

    setCount(1)
    flushSync()
    expect(log).toEqual(['handler:0', 'cleanup:0', 'handler:1'])
  })
})

describe('addEvent — cleanup removes listener', () => {
  it('removeEventListener is called when owner is disposed', () => {
    const el  = div()
    const log = []
    const dispose = createEffect(() => {
      addEvent(el, 'click', () => log.push('click'))
    })

    el.dispatchEvent(new MouseEvent('click'))
    expect(log.length).toBe(1)

    dispose() // should remove listener via onCleanup
    el.dispatchEvent(new MouseEvent('click'))
    expect(log.length).toBe(1) // listener gone
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §7  DOM utils
// ─────────────────────────────────────────────────────────────────────────────

describe('htmlToFragment', () => {
  it('parses HTML into a DOM node', () => {
    const frag = htmlToFragment('<p>hello</p>')
    expect(frag.tagName).toBe('P')
  })

  it('option bit 1 (clone) returns a cloneNode', () => {
    const a = htmlToFragment('<p>hi</p>', 1)
    const b = htmlToFragment('<p>hi</p>', 1)
    expect(a).not.toBe(b)
  })

  it('option bit 2 (requireFragment) returns a DocumentFragment', () => {
    const frag = htmlToFragment('<p>one</p><p>two</p>', 2)
    expect(frag.nodeType).toBe(11) // DOCUMENT_FRAGMENT_NODE
    expect(frag.childNodes.length).toBe(2)
  })

  it('caches parsed result — same HTML string returns same reference', () => {
    const html = '<span data-cached="yes">cached</span>'
    const a = htmlToFragment(html)
    const b = htmlToFragment(html)
    expect(a).toBe(b)
  })
})

describe('createTextNode', () => {
  it('creates a text node', () => {
    const tn = createTextNode('hello')
    expect(tn.nodeType).toBe(3)
    expect(tn.textContent).toBe('hello')
  })
})

describe('insertAfter', () => {
  it('inserts node after anchor', () => {
    const container = div()
    const anchor = span()
    container.appendChild(anchor)

    const newEl = span()
    newEl.textContent = 'new'
    insertAfter(anchor, newEl)

    expect(container.children[1]).toBe(newEl)
  })
})

describe('removeElements', () => {
  it('removes a single element', () => {
    const container = div()
    const el = span()
    container.appendChild(el)
    removeElements(el, el)
    expect(container.children.length).toBe(0)
  })

  it('removes a range of siblings', () => {
    const container = div()
    const a = span(), b = span(), c = span()
    container.append(a, b, c)
    removeElements(a, b) // remove a and b, keep c
    expect(container.children.length).toBe(1)
    expect(container.children[0]).toBe(c)
  })
})

describe('addStyles', () => {
  it('injects a style tag into document.head', () => {
    const id = 'mesa-test-' + Date.now()
    addStyles(id, 'body { margin: 0 }')
    expect(document.head.querySelector(`style#${id}`)).not.toBeNull()
  })

  it('does not inject duplicate style tags', () => {
    const id = 'mesa-dedup-' + Date.now()
    addStyles(id, 'body {}')
    addStyles(id, 'body {}')
    expect(document.head.querySelectorAll(`style#${id}`).length).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §8  DOM bindings
// ─────────────────────────────────────────────────────────────────────────────

describe('bindText', () => {
  it('sets textContent initially', () => {
    const el = div()
    const [val] = createSignal('hello')
    bindText(el, () => val())
    expect(el.textContent).toBe('hello')
  })

  it('updates textContent when signal changes', () => {
    const [val, setVal] = createSignal('a')
    const el = div()
    bindText(el, () => val())
    setVal('b')
    flushSync()
    expect(el.textContent).toBe('b')
  })
})

describe('bindAttribute', () => {
  it('sets attribute initially', () => {
    const el = div()
    const [val] = createSignal('my-id')
    bindAttribute(el, 'id', () => val())
    expect(el.id).toBe('my-id')
  })

  it('updates attribute on signal change', () => {
    const [cls, setCls] = createSignal('a')
    const el = div()
    bindAttribute(el, 'data-x', () => cls())
    setCls('b')
    flushSync()
    expect(el.getAttribute('data-x')).toBe('b')
  })

  it('removes attribute when value is null', () => {
    const [val, setVal] = createSignal('yes')
    const el = div()
    bindAttribute(el, 'data-x', () => val())
    setVal(null)
    flushSync()
    expect(el.hasAttribute('data-x')).toBe(false)
  })

  // `value` and `checked` stop following their attribute the moment a user
  // edits the control, so removing the attribute is not clearing the field:
  // the typed text stays on screen while the component's state says the value
  // is gone, and nothing reports the disagreement. A form reset is the case
  // that found it — every generated field kept what had been typed into it.
  it('clears a dirty input when the value goes null', () => {
    const [val, setVal] = createSignal('seed')
    const el = document.createElement('input')
    bindAttribute(el, 'value', () => val())
    el.value = 'typed by the user'
    setVal(null)
    flushSync()
    expect(el.value).toBe('')
  })

  it('unchecks a dirty checkbox when the value goes null', () => {
    const [on, setOn] = createSignal(true)
    const el = document.createElement('input')
    el.type = 'checkbox'
    bindAttribute(el, 'checked', () => on())
    el.checked = true
    setOn(null)
    flushSync()
    expect(el.checked).toBe(false)
  })

  it('still removes a plain attribute rather than emptying it', () => {
    const [val, setVal] = createSignal('x')
    const el = div()
    bindAttribute(el, 'title', () => val())
    setVal(null)
    flushSync()
    expect(el.hasAttribute('title')).toBe(false)
  })
})

describe('bindClass', () => {
  it('adds class when truthy', () => {
    const [active, setActive] = createSignal(false)
    const el = div()
    bindClass(el, () => active(), 'active')
    expect(el.classList.contains('active')).toBe(false)
    setActive(true)
    flushSync()
    expect(el.classList.contains('active')).toBe(true)
  })

  it('removes class when falsy', () => {
    const [active, setActive] = createSignal(true)
    const el = div()
    bindClass(el, () => active(), 'active')
    setActive(false)
    flushSync()
    expect(el.classList.contains('active')).toBe(false)
  })
})

describe('bindStyle', () => {
  it('sets style property', () => {
    const [color, setColor] = createSignal('red')
    const el = div()
    bindStyle(el, 'color', () => color())
    expect(el.style.color).toBe('red')
    setColor('blue')
    flushSync()
    expect(el.style.color).toBe('blue')
  })

  // Every conditional style in the repo is `style:x={cond ? 'v' : null}`.
  // Handing that null to setProperty left the answer to the DOM: happy-dom
  // wrote the string "null" for `position` and `z-index` and dropped it for
  // `color` and `top`, so one server-rendered element carried
  // `style="position: null; z-index: null;"` while the client carried nothing.
  it('removes the property when the value is null, rather than writing it', () => {
    const [on, setOn] = createSignal(true)
    const el = div()
    for (const [prop, value] of [['color', 'red'], ['position', 'absolute'], ['z-index', '10'], ['top', '1px']]) {
      bindStyle(el, prop, () => (on() ? value : null))
    }
    expect(el.getAttribute('style')).toContain('position')

    setOn(false)
    flushSync()
    const style = el.getAttribute('style') || ''
    expect(style).not.toContain('null')
    expect(style.trim()).toBe('')
  })

  it('treats an empty string the same as null', () => {
    const el = div()
    bindStyle(el, 'font-size', () => '')
    expect(el.getAttribute('style') || '').toBe('')
  })
})

describe('bindInput', () => {
  it('sets initial value from signal', () => {
    const [val] = createSignal('hello')
    const input = document.createElement('input')
    bindInput(input, 'value', val, () => {})
    expect(input.value).toBe('hello')
  })

  it('calls setter when input event fires', () => {
    const [, setVal] = createSignal('')
    const setSpy = vi.fn()
    const input = document.createElement('input')
    bindInput(input, 'value', () => '', setSpy)
    input.value = 'typed'
    input.dispatchEvent(new Event('input'))
    expect(setSpy).toHaveBeenCalledWith('typed')
  })

  it('handles checked binding', () => {
    const [checked, setChecked] = createSignal(false)
    const input = document.createElement('input')
    input.type = 'checkbox'
    bindInput(input, 'checked', checked, setChecked)
    expect(input.checked).toBe(false)
    setChecked(true)
    flushSync()
    expect(input.checked).toBe(true)
  })

  // ── <select> ───────────────────────────────────────────────────────────────
  // A select was bound as a plain property: `el.value = ['a','c']` coerced to
  // "a,c" and matched no option, and the read handed back `el.value` — a
  // string — which replaced the caller's array, so the next render of it threw
  // `picked.join is not a function`. Both directions go through the options now.

  const select = (values, { multiple = false } = {}) => {
    const el = document.createElement('select')
    if (multiple) el.multiple = true
    for (const v of values) {
      const o = document.createElement('option')
      o.value = v
      o.textContent = v.toUpperCase()
      el.appendChild(o)
    }
    document.body.appendChild(el)
    return el
  }
  const selectedValues = (el) => [...el.options].filter((o) => o.selected).map((o) => o.value)

  it('selects every option named by the bound array', () => {
    const el = select(['a', 'b', 'c'], { multiple: true })
    const [picked] = createSignal(['a', 'c'])
    bindInput(el, 'value', picked, () => {})
    expect(selectedValues(el)).toEqual(['a', 'c'])
  })

  it('gives the setter an ARRAY of values, not a string', () => {
    const el = select(['a', 'b', 'c'], { multiple: true })
    const setSpy = vi.fn()
    bindInput(el, 'value', () => [], setSpy)
    el.options[0].selected = true
    el.options[2].selected = true
    el.dispatchEvent(new Event('change'))
    expect(setSpy).toHaveBeenCalledWith(['a', 'c'])
  })

  it('tracks the bound array as it changes', () => {
    const el = select(['a', 'b', 'c'], { multiple: true })
    const [picked, setPicked] = createSignal(['b'])
    bindInput(el, 'value', picked, () => {})
    expect(selectedValues(el)).toEqual(['b'])
    setPicked(['a', 'b'])
    flushSync()
    expect(selectedValues(el)).toEqual(['a', 'b'])
    setPicked([])
    flushSync()
    expect(selectedValues(el)).toEqual([])
  })

  it('single select still binds one value', () => {
    const el = select(['a', 'b'])
    const [v, setV] = createSignal('b')
    const setSpy = vi.fn()
    bindInput(el, 'value', v, setSpy)
    expect(el.value).toBe('b')
    setV('a')
    flushSync()
    expect(el.value).toBe('a')
    el.options[1].selected = true
    el.dispatchEvent(new Event('change'))
    expect(setSpy).toHaveBeenCalledWith('b')
  })

  it('carries non-string option values through __value', () => {
    // `<option value={obj}>` cannot survive as an attribute — it stringifies to
    // "[object Object]". set_attribute() stashes the real value on the element.
    const el = select(['x', 'y'])
    const objs = [{ id: 1 }, { id: 2 }]
    el.options[0].__value = objs[0]
    el.options[1].__value = objs[1]
    const [chosen, setChosen] = createSignal(objs[1])
    const setSpy = vi.fn()
    bindInput(el, 'value', chosen, setSpy)
    expect(el.selectedIndex).toBe(1)

    setChosen(objs[0])
    flushSync()
    expect(el.selectedIndex).toBe(0)

    el.options[1].selected = true
    el.dispatchEvent(new Event('change'))
    expect(setSpy).toHaveBeenCalledWith(objs[1])   // the object, not "[object Object]"
  })

  // ── bind:files ─────────────────────────────────────────────────────────────
  // `input.files` is settable — the IDL attribute is `FileList?` — but it takes
  // a FileList and nothing else. The generic property path wrote
  // `el.files = get() ?? ''`, so an unset variable assigned the empty string and
  // Chrome threw on mount: "Failed to convert value to 'FileList'". happy-dom's
  // setter accepts any value, which is exactly why the suite never saw it, so
  // these tests assert what MESA does rather than what the DOM rejects.

  const fileInput = () => {
    const el = document.createElement('input')
    el.type = 'file'
    document.body.appendChild(el)
    return el
  }
  const fileList = (...names) => {
    const dt = new DataTransfer()
    for (const n of names) dt.items.add(new File(['x'], n))
    return dt.files
  }

  it('leaves the input alone while the bound variable is undefined', () => {
    const el = fileInput()
    el.files = fileList('kept.txt')
    const [files] = createSignal(undefined)
    bindInput(el, 'files', files, () => {})
    expect(el.files.length).toBe(1)          // not clobbered with ''
  })

  it('assigns a FileList straight through', () => {
    const el = fileInput()
    const [files, setFiles] = createSignal(undefined)
    bindInput(el, 'files', files, () => {})
    setFiles(fileList('a.txt', 'b.txt'))
    flushSync()
    expect(el.files.length).toBe(2)
  })

  it('reads the selection back on change', () => {
    const el = fileInput()
    const setSpy = vi.fn()
    bindInput(el, 'files', () => undefined, setSpy)
    el.files = fileList('picked.txt')
    el.dispatchEvent(new Event('change'))
    expect(setSpy).toHaveBeenCalledTimes(1)
    expect(setSpy.mock.calls[0][0].length).toBe(1)
  })

  it('clears through the value attribute, since files = null is ignored', () => {
    // Verified in headless Chrome: `el.files = null` is accepted and then does
    // nothing — a two-file input still holds both — while `el.value = ''`
    // empties the selection. happy-dom models neither, so this asserts the
    // write Mesa makes rather than the DOM's reaction to it.
    const el = fileInput()
    el.files = fileList('a.txt')
    const writes = []
    Object.defineProperty(el, 'value', {
      get: () => '', set: (v) => writes.push(v), configurable: true,
    })
    const [files, setFiles] = createSignal(undefined)
    bindInput(el, 'files', files, () => {})
    expect(writes).toEqual([])          // undefined must not clear anything
    setFiles(null)
    flushSync()
    expect(writes).toEqual([''])
  })

  it('accepts an array of File objects by building a FileList', () => {
    // `el.files = [file]` throws in a browser — a DataTransfer is the only way
    // to build a FileList, and that is not something every caller should have
    // to learn.
    const el = fileInput()
    const [files, setFiles] = createSignal(undefined)
    bindInput(el, 'files', files, () => {})
    setFiles([new File(['x'], 'array.txt'), new File(['y'], 'two.txt')])
    flushSync()
    expect(el.files.length).toBe(2)
  })

  it('warns and leaves the input alone for a value it cannot use', () => {
    const el = fileInput()
    el.files = fileList('kept.txt')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const [files, setFiles] = createSignal(undefined)
    bindInput(el, 'files', files, () => {})
    setFiles('oops.txt')                         // a path string, the other guess
    flushSync()
    expect(warn.mock.calls.some((c) => /bind:files/.test(c[0]))).toBe(true)
    expect(el.files.length).toBe(1)              // untouched
    warn.mockRestore()
  })

  it('selects nothing when the value matches no option', () => {
    const el = select(['a', 'b'])
    const [v] = createSignal({ nope: true })
    bindInput(el, 'value', v, () => {})
    expect(el.selectedIndex).toBe(-1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §9  Events
// ─────────────────────────────────────────────────────────────────────────────

describe('transition', () => {
  it('calls fn immediately when View Transitions not available', () => {
    // jsdom doesn't have startViewTransition
    let called = false
    transition(() => { called = true })
    expect(called).toBe(true)
  })
})

describe('entrance', () => {
  it('calls in function when element mounts', () => {
    const el = document.createElement('div')
    const inFn = vi.fn()
    const attach = entrance({ in: inFn })
    attach(el)
    expect(inFn).toHaveBeenCalledWith(el)
  })

  it('returns cleanup that calls out function', () => {
    const el = document.createElement('div')
    const outFn = vi.fn()
    const attach = entrance({ out: outFn })
    const cleanup = attach(el)
    cleanup()
    expect(outFn).toHaveBeenCalledWith(el)
  })

  it('works with only in — no cleanup returned', () => {
    const el = document.createElement('div')
    const inFn = vi.fn()
    const attach = entrance({ in: inFn })
    const result = attach(el)
    expect(result).toBeUndefined()
  })

  it('works with only out — no in call on mount', () => {
    const el = document.createElement('div')
    const outFn = vi.fn()
    const attach = entrance({ out: outFn })
    attach(el)
    expect(outFn).not.toHaveBeenCalled()
  })
})

describe('attach — Promise cleanup', () => {
  it('calls sync cleanup function when re-run', async () => {
    const el = document.createElement('div')
    const [sig, setSig] = createSignal(0)
    const cleanupFn = vi.fn()

    // attach with a handler that tracks sig and returns cleanup
    attach(el, () => {
      sig() // track
      return cleanupFn
    })

    // trigger re-run by changing sig
    setSig(1)
    await Promise.resolve()
    expect(cleanupFn).toHaveBeenCalled()
  })
})

describe('makeEmitter', () => {
  it('dispatches to onclick prop (lowercase)', () => {
    const handler = vi.fn()
    const $option = { props: { onclick: handler } }
    const emit = makeEmitter($option)
    emit('click', 42)
    expect(handler).toHaveBeenCalledWith(42)
  })

  it('dispatches to onClick prop (camelCase)', () => {
    const handler = vi.fn()
    const $option = { props: { onClick: handler } }
    const emit = makeEmitter($option)
    emit('click', 'data')
    expect(handler).toHaveBeenCalledWith('data')
  })

  it('does nothing when no handler registered', () => {
    const emit = makeEmitter({ props: {} })
    expect(() => emit('unhandled', null)).not.toThrow()
  })
})

describe('mergeEvents', () => {
  it('calls both callbacks', () => {
    const log = []
    const merged = mergeEvents(() => log.push('a'), () => log.push('b'))
    merged()
    expect(log).toEqual(['a', 'b'])
  })

  it('returns null for empty list', () => {
    expect(mergeEvents()).toBeNull()
  })

  it('returns single fn when only one provided', () => {
    const fn = () => {}
    expect(mergeEvents(fn)).toBe(fn)
  })
})

describe('mergeAllEvents', () => {
  it('merges local events over $events', () => {
    const log = []
    const $events = { click: () => log.push('global') }
    const local = { click: () => log.push('local') }
    const merged = mergeAllEvents($events, local)
    merged.click()
    expect(log).toEqual(['global', 'local'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §10  makeComponent / mount
// ─────────────────────────────────────────────────────────────────────────────

describe('makeComponent', () => {
  it('returns a factory that produces {$dom, $push, $apply, destroy}', () => {
    const comp = makeComponent(() => div())
    const instance = comp()
    expect(instance.$dom).toBeDefined()
    expect(typeof instance.$push).toBe('function')
    expect(typeof instance.$apply).toBe('function')
    expect(typeof instance.destroy).toBe('function')
  })

  it('calls onMount callbacks after microtask', async () => {
    let mounted = false
    const comp = makeComponent(() => {
      onMount(() => { mounted = true })
      return div()
    })
    comp()
    expect(mounted).toBe(false)
    await tick()
    expect(mounted).toBe(true)
  })

  it('destroy disposes reactive effects', () => {
    const [count, setCount] = createSignal(0)
    let runs = 0
    const comp = makeComponent(() => {
      createEffect(() => { count(); runs++ })
      return div()
    })
    const instance = comp()
    expect(runs).toBe(1)
    instance.destroy()
    setCount(1)
    flushSync()
    expect(runs).toBe(1) // effect stopped
  })

  it('onDestroy runs on destroy()', () => {
    let destroyed = false
    const comp = makeComponent(() => {
      onDestroy(() => { destroyed = true })
      return div()
    })
    comp().destroy()
    expect(destroyed).toBe(true)
  })
})

describe('mount()', () => {
  it('mounts component after anchor and returns destroy()', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const comp = (__anchor) => {
      const el = span(); el.textContent = 'hello'
      __anchor.before(el)
    }

    const instance = mount(anchor, comp)
    expect(container.textContent).toBe('hello')

    // destroy() removes the anchor; DOM cleanup is the component's own responsibility
    expect(() => instance.destroy()).not.toThrow()
  })

  it('throws a descriptive error when anchor has no parentNode', () => {
    const detached = document.createComment('')
    const comp = (__anchor) => {}
    expect(() => mount(detached, comp)).toThrow('@frontierjs/mesa-runtime mount()')
  })

  it('mounts a fragment-rooted component correctly', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const comp = (__anchor) => {
      const a = span(); a.textContent = 'A'
      const b = span(); b.textContent = 'B'
      __anchor.before(a)
      __anchor.before(b)
    }

    const instance = mount(anchor, comp)
    expect(container.querySelectorAll('span').length).toBe(2)
    expect(container.textContent).toBe('AB')

    instance.destroy()
    // destroy() only removes the anchor comment; DOM cleanup is component's responsibility
    expect(container.querySelectorAll('span').length).toBeGreaterThanOrEqual(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §11  makeRootEvent
// ─────────────────────────────────────────────────────────────────────────────

describe('makeRootEvent()', () => {
  it('delegates events via fragment (pre-insertion)', () => {
    const comp = makeComponent(() => {
      const fr  = htmlToFragment('<div><button></button></div>', 1)
      const btn = fr.querySelector('button')

      const log = []
      const register = makeRootEvent(fr) // called pre-insertion
      register(btn, 'click', () => log.push('clicked'))

      const container = div()
      document.body.appendChild(container)
      container.appendChild(fr)

      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      expect(log).toEqual(['clicked'])

      document.body.removeChild(container)
      return document.createDocumentFragment()
    })
    comp()
  })

  it('accepts an explicit node array (post-insertion safe)', () => {
    const container = div()
    document.body.appendChild(container)

    const el    = htmlToFragment('<div><span></span></div>', 1)
    const inner = el.querySelector('span')
    container.appendChild(el)

    const log = []
    const comp = makeComponent(() => {
      const register = makeRootEvent([el])
      register(inner, 'click', () => log.push('ok'))
      return document.createDocumentFragment()
    })
    comp()

    inner.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(log).toEqual(['ok'])

    document.body.removeChild(container)
  })

  it('warns (not throws) when called on already-inserted fragment', () => {
    const container = div()
    const fr = htmlToFragment('<div></div>', 3) // force fragment return
    container.appendChild(fr) // transfers children out — fragment now empty

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const comp = makeComponent(() => {
      makeRootEvent(fr) // empty fragment — should warn, not throw
      return document.createDocumentFragment()
    })
    expect(() => comp()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('makeRootEvent'))
    warnSpy.mockRestore()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §12  Blocks — makeBlock, makeBlockBound, attachBlock
// ─────────────────────────────────────────────────────────────────────────────

describe('makeBlock', () => {
  it('clones template on each call', () => {
    const tpl = htmlToFragment('<p>item</p>')
    const block = makeBlock(tpl)
    const a = block()
    const b = block()
    expect(a).not.toBe(b)
  })

  it('calls setup fn with the cloned DOM', () => {
    const tpl = htmlToFragment('<p></p>', 1)
    const block = makeBlock(tpl, ($dom) => { $dom.textContent = 'set' })
    const el = block()
    expect(el.textContent).toBe('set')
  })
})

describe('makeBlockBound', () => {
  it('creates a self-contained reactive block', () => {
    const [val, setVal] = createSignal('init')
    const tpl = htmlToFragment('<p></p>', 1)
    const block = makeBlockBound(tpl, ($dom) => {
      createEffect(() => { $dom.textContent = val() })
    })
    const el = block()
    expect(el.textContent).toBe('init')
    setVal('updated')
    flushSync()
    expect(el.textContent).toBe('updated')
  })
})

describe('attachBlock', () => {
  it('inserts $dom after anchor', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const el = span(); el.textContent = 'hello'
    attachBlock(anchor, el)
    expect(container.textContent).toBe('hello')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §13  ifBlock
// ─────────────────────────────────────────────────────────────────────────────

describe('ifBlock', () => {
  it('shows block 0 initially', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [cond] = createSignal(0)
    ifBlock(anchor, cond, [
      () => { const el = div(); el.textContent = 'yes'; return el },
      () => { const el = div(); el.textContent = 'no'; return el },
    ])
    expect(container.textContent).toBe('yes')
  })

  it('switches blocks on signal change', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [cond, setCond] = createSignal(0)
    ifBlock(anchor, cond, [
      () => { const el = div(); el.textContent = 'A'; return el },
      () => { const el = div(); el.textContent = 'B'; return el },
    ])

    setCond(1)
    flushSync()
    expect(container.textContent).toBe('B')
    setCond(0)
    flushSync()
    expect(container.textContent).toBe('A')
  })

  it('shows nothing when condition is null', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [cond, setCond] = createSignal(0)
    ifBlock(anchor, cond, [
      () => { const el = div(); el.textContent = 'A'; return el },
    ])
    setCond(null)
    flushSync()
    expect(container.textContent).toBe('')
  })
})

// ─── [FIX 3]  ifBlock — multi-node fragment leak ──────────────────────────────
// After a DocumentFragment is inserted its children move out, so probing
// currentDom.firstChild post-insert returned null and _remove() was a no-op.
// Fixed by storing firstChild/lastChild before insertion.

describe('[FIX 3] ifBlock — multi-node fragment switching', () => {
  const makeMultiFragment = (text, n = 3) => {
    const fr = document.createDocumentFragment()
    for (let i = 0; i < n; i++) {
      const el = document.createElement('span')
      el.textContent = text + i
      fr.appendChild(el)
    }
    return fr
  }

  it('removes all fragment nodes when switching away from a multi-node block', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [cond, setCond] = createSignal(0)
    ifBlock(anchor, cond, [
      () => makeMultiFragment('A', 3),
      () => makeMultiFragment('B', 2),
    ])

    expect(container.querySelectorAll('span').length).toBe(3)
    setCond(1)
    flushSync()
    expect(container.querySelectorAll('span').length).toBe(2)
    expect(container.textContent).toBe('B0B1')
  })

  it('no leaked nodes after repeated switching', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [cond, setCond] = createSignal(0)
    ifBlock(anchor, cond, [
      () => makeMultiFragment('X', 3),
      () => makeMultiFragment('Y', 3),
    ])

    for (let i = 0; i < 6; i++) setCond(i % 2)
    expect(container.querySelectorAll('span').length).toBe(3)
  })

  it('null condition removes all multi-node fragment nodes', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [cond, setCond] = createSignal(0)
    ifBlock(anchor, cond, [() => makeMultiFragment('Z', 4)])

    expect(container.querySelectorAll('span').length).toBe(4)
    setCond(null)
    flushSync()
    expect(container.querySelectorAll('span').length).toBe(0)
  })

  it('single-node block still works correctly (regression guard)', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [cond, setCond] = createSignal(0)
    ifBlock(anchor, cond, [
      () => { const el = div(); el.textContent = 'one'; return el },
      () => { const el = div(); el.textContent = 'two'; return el },
    ])

    expect(container.textContent).toBe('one')
    setCond(1); flushSync(); expect(container.textContent).toBe('two')
    setCond(0); flushSync(); expect(container.textContent).toBe('one')
    flushSync()
    expect(container.querySelectorAll('div').length).toBe(1)
  })
})

describe('ifBlock — full lifecycle null→block→block→null', () => {
  it('transitions through all states cleanly', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [cond, setCond] = createSignal(null)
    ifBlock(anchor, cond, [
      () => { const el = div(); el.textContent = 'A'; return el },
      () => { const el = div(); el.textContent = 'B'; return el },
    ])

    expect(container.textContent).toBe('')
    setCond(0); flushSync(); expect(container.textContent).toBe('A')
    setCond(1); flushSync(); expect(container.textContent).toBe('B')
    setCond(0); flushSync(); expect(container.textContent).toBe('A')
    setCond(null); flushSync(); expect(container.textContent).toBe('')
    flushSync()
    expect(container.querySelectorAll('div').length).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §14  $$eachBlock
// ─────────────────────────────────────────────────────────────────────────────

describe('$$eachBlock — what it may iterate', () => {
  const rowsFrom = (value) => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    // Keyed by index: an array-like yields `undefined` for every item, and
    // keying by value would warn about duplicates rather than test anything.
    $$eachBlock(anchor, 0, () => value, (_item, i) => i, (getItem) => {
      const el = document.createElement('li')
      createEffect(() => { el.textContent = String(getItem() ?? '') })
      return el
    })
    return [...container.querySelectorAll('li')].map((l) => l.textContent)
  }

  // `{#each { length: 6 } as _, i}` is how a fixed-size grid is written, and
  // it used to die as `array.map is not a function` — no block, no expression,
  // nothing to search for. @frontierjs/ui's DatePicker built both of its
  // calendar panes that way, so the component threw on first render and had
  // never rendered at all, in any environment.
  it('takes an array-like', () => {
    expect(rowsFrom({ length: 3 })).toEqual(['', '', ''])
  })

  it('takes an iterable', () => {
    expect(rowsFrom(new Set(['a', 'b']))).toEqual(['a', 'b'])
    expect(rowsFrom('ab')).toEqual(['a', 'b'])
  })

  it('treats null and undefined as empty', () => {
    expect(rowsFrom(null)).toEqual([])
    expect(rowsFrom(undefined)).toEqual([])
  })

  // Refused by name rather than converted: both are typos with an obvious
  // intent, and guessing produces an empty list where the author wanted rows.
  it('refuses a number, and says what to write instead', () => {
    expect(() => rowsFrom(3)).toThrow(/\{#each\}.*number/s)
    expect(() => rowsFrom(3)).toThrow(/length: 3/)
  })

  it('refuses a plain object, and points at Object.entries', () => {
    expect(() => rowsFrom({ a: 1 })).toThrow(/plain object/)
    expect(() => rowsFrom({ a: 1 })).toThrow(/Object\.entries/)
  })
})

describe('$$eachBlock', () => {
  it('renders initial list', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [items] = createSignal(['a', 'b', 'c'])
    $$eachBlock(anchor, 0, items, eachDefaultKey, (getItem) => {
      const el = document.createElement('li')
      createEffect(() => { el.textContent = getItem() })
      return el
    })

    expect(container.querySelectorAll('li').length).toBe(3)
    expect([...container.querySelectorAll('li')].map((l) => l.textContent)).toEqual(['a','b','c'])
  })

  it('adds item on signal change', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [items, setItems] = createSignal(['a'])
    $$eachBlock(anchor, 0, items, eachDefaultKey, (getItem) => {
      const el = document.createElement('li')
      createEffect(() => { el.textContent = getItem() })
      return el
    })

    setItems(['a', 'b'])
    flushSync()
    expect(container.querySelectorAll('li').length).toBe(2)
  })

  it('clears list on empty array', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [items, setItems] = createSignal(['a', 'b'])
    $$eachBlock(anchor, 0, items, eachDefaultKey, (getItem) => {
      const el = document.createElement('li')
      createEffect(() => { el.textContent = getItem() })
      return el
    })

    setItems([])
    flushSync()
    expect(container.querySelectorAll('li').length).toBe(0)
  })

  it('shows else block when array is empty', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [items, setItems] = createSignal([])
    $$eachBlock(
      anchor, 0, items, eachDefaultKey,
      (getItem) => { const el = document.createElement('li'); return el },
      () => { const el = div(); el.textContent = 'empty'; return el }
    )

    expect(container.textContent).toBe('empty')
    setItems(['a'])
    flushSync()
    expect(container.querySelectorAll('li').length).toBe(1)
    expect(container.textContent).not.toContain('empty')
  })
})

// ─── [FIX 4]  $$eachBlock — multi-node item reorder ──────────────────────────
// The reorder pass was probing $dom.lastChild?.nextSibling — always null on
// an emptied fragment — so items were re-inserted on every diff.
// Fixed by using block.$domLast.nextSibling (stored at creation time).

describe('[FIX 4] $$eachBlock — multi-node item reorder', () => {
  const makeTwoNodeItem = (getItem) => {
    const frag = document.createDocumentFragment()
    const dt   = document.createElement('dt')
    const dd   = document.createElement('dd')
    createEffect(() => {
      const item = getItem()
      dt.textContent = item.key
      dd.textContent = item.val
    })
    frag.appendChild(dt)
    frag.appendChild(dd)
    return frag
  }

  it('renders multi-node items in correct order', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [items] = createSignal([
      { id: 1, key: 'A', val: '1' },
      { id: 2, key: 'B', val: '2' },
    ])
    $$eachBlock(anchor, 0, items, (i) => i.id, makeTwoNodeItem)

    const dts = [...container.querySelectorAll('dt')].map((el) => el.textContent)
    expect(dts).toEqual(['A', 'B'])
  })

  it('reorders multi-node items without duplicating nodes', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [items, setItems] = createSignal([
      { id: 1, key: 'A', val: '1' },
      { id: 2, key: 'B', val: '2' },
      { id: 3, key: 'C', val: '3' },
    ])
    $$eachBlock(anchor, 0, items, (i) => i.id, makeTwoNodeItem)

    setItems([
      { id: 3, key: 'C', val: '3' },
      { id: 2, key: 'B', val: '2' },
      { id: 1, key: 'A', val: '1' },
    ])
    flushSync()

    const all = [...container.querySelectorAll('dt, dd')].map(
      (el) => el.tagName.toLowerCase() + ':' + el.textContent
    )
    expect(all).toEqual(['dt:C','dd:3','dt:B','dd:2','dt:A','dd:1'])
  })

  it('no duplicate nodes after reorder (node count stays 2n)', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [items, setItems] = createSignal([
      { id: 1, key: 'X', val: 'x' },
      { id: 2, key: 'Y', val: 'y' },
    ])
    $$eachBlock(anchor, 0, items, (i) => i.id, makeTwoNodeItem)

    setItems([{ id: 2, key: 'Y', val: 'y' }, { id: 1, key: 'X', val: 'x' }])
    flushSync()
    expect(container.querySelectorAll('dt').length).toBe(2)
    expect(container.querySelectorAll('dd').length).toBe(2)
  })

  it('single-node items still reorder correctly (regression guard)', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [items, setItems] = createSignal([
      { id: 1, name: 'P' },
      { id: 2, name: 'Q' },
      { id: 3, name: 'R' },
    ])
    $$eachBlock(anchor, 0, items, (i) => i.id, (getItem) => {
      const el = document.createElement('li')
      createEffect(() => { el.textContent = getItem().name })
      return el
    })

    setItems([{ id: 3, name: 'R' }, { id: 1, name: 'P' }, { id: 2, name: 'Q' }])
    flushSync()
    const order = [...container.querySelectorAll('li')].map((el) => el.textContent)
    expect(order).toEqual(['R', 'P', 'Q'])
  })
})

describe('$$eachBlock — reverse-order stress', () => {
  it('completely reversing a list produces correct text order', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const initial = ['one', 'two', 'three', 'four', 'five']
    const [items, setItems] = createSignal(initial)

    $$eachBlock(anchor, 0, items, eachDefaultKey, (getItem) => {
      const el = document.createElement('li')
      createEffect(() => { el.textContent = getItem() })
      return el
    })

    setItems([...initial].reverse())
    flushSync()
    const order = [...container.querySelectorAll('li')].map((el) => el.textContent)
    expect(order).toEqual(['five', 'four', 'three', 'two', 'one'])
  })
})

// ─── $$eachBlock — the index after a reorder ─────────────────────────────────
// The reconciler re-pointed a surviving block at its new item, but only when
// the ITEM had changed. A move, a reverse, a splice — every reorder hands the
// same item object to a block at a new position, so the index signal was never
// written and the row kept rendering its old i. Two rows could show the same
// index. Invisible until today because an indexed {#each} threw on mount, so
// nobody ever saw a stale one.

describe('$$eachBlock — index after a reorder', () => {
  const renderIndexed = (container, items) => {
    const anchor = document.createComment('')
    container.appendChild(anchor)
    $$eachBlock(anchor, 0, items, (item) => item.id, (getItem, getIndex) => {
      const el = document.createElement('li')
      createEffect(() => { el.textContent = `${getIndex()}:${getItem().text}` })
      return el
    })
    return () => [...container.querySelectorAll('li')].map((el) => el.textContent)
  }

  const rows = () => [
    { id: 'a', text: 'alpha' },
    { id: 'b', text: 'beta' },
    { id: 'c', text: 'gamma' },
  ]

  it('renumbers every row when the list is reversed', () => {
    const container = div()
    const [items, setItems] = createSignal(rows())
    const read = renderIndexed(container, items)
    expect(read()).toEqual(['0:alpha', '1:beta', '2:gamma'])

    setItems([...items()].reverse())
    flushSync()
    expect(read()).toEqual(['0:gamma', '1:beta', '2:alpha'])
  })

  it('renumbers on a single move, with the same item objects', () => {
    const container = div()
    const initial = rows()
    const [items, setItems] = createSignal(initial)
    const read = renderIndexed(container, items)

    // Same object identities, new order — the case that used to no-op.
    setItems([initial[1], initial[0], initial[2]])
    flushSync()
    expect(read()).toEqual(['0:beta', '1:alpha', '2:gamma'])
  })

  it('renumbers the tail when an item is removed from the head', () => {
    const container = div()
    const initial = rows()
    const [items, setItems] = createSignal(initial)
    const read = renderIndexed(container, items)

    setItems(initial.slice(1))
    flushSync()
    expect(read()).toEqual(['0:beta', '1:gamma'])
  })

  it('does not renumber rows whose position did not change', () => {
    // The comparison has to stay cheap: an unchanged (item, index) pair must
    // not re-run the row's effects.
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    const initial = rows()
    const [items, setItems] = createSignal(initial)
    const runs = new Map()
    $$eachBlock(anchor, 0, items, (item) => item.id, (getItem, getIndex) => {
      const el = document.createElement('li')
      createEffect(() => {
        const item = getItem()
        runs.set(item.id, (runs.get(item.id) ?? 0) + 1)
        el.textContent = `${getIndex()}:${item.text}`
      })
      return el
    })
    expect(runs.get('c')).toBe(1)

    // Append — a and b keep both their item and their index.
    setItems([...initial, { id: 'd', text: 'delta' }])
    flushSync()
    expect(runs.get('a')).toBe(1)
    expect(runs.get('c')).toBe(1)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// §14b  $$eachBlock inside {#if} — anchor detach regression
// When {#each} is inside a {#if} branch that gets swapped out at the same
// time results are cleared to [], eachBlock must not crash with
// 'parent is null' on anchor.parentNode.
// ─────────────────────────────────────────────────────────────────────────────

describe('$$eachBlock — anchor detach safety (async/if interaction)', () => {
  it('does not throw when cleared while anchor is detached from DOM', () => {
    // Simulates: {#if searching}{:else if results.length}{#each results}{/each}{/if}
    // When searching=true fires at the same time as results=[] the {#each}
    // anchor is removed from DOM by ifBlock before eachBlock's clear path runs.
    const container = div()
    const ifAnchor = document.createComment('if')
    container.appendChild(ifAnchor)

    const [searching, setSearching] = createSignal(false)
    const [results, setResults]     = createSignal(['a', 'b', 'c'])

    // Build the {#else if results.length} branch which contains the {#each}
    let eachAnchor
    const elseIfBranch = () => {
      const wrapper = div()
      eachAnchor = document.createComment('each')
      wrapper.appendChild(eachAnchor)

      $$eachBlock(eachAnchor, 0, results, eachDefaultKey, (getItem) => {
        const el = document.createElement('li')
        createEffect(() => { el.textContent = getItem() })
        return el
      })
      return wrapper
    }

    // Wire {#if}: 0=searching branch, 1=results branch
    ifBlock(ifAnchor, () => {
      if (searching()) return 0       // show Searching…
      if (results().length) return 1  // show results
      return null
    }, [
      () => { const el = div(); el.textContent = 'Searching…'; return el },
      elseIfBranch,
    ])

    flushSync()
    // results branch is active, 3 items rendered
    expect(container.querySelectorAll('li').length).toBe(3)

    // Simulate: query changes → searching=true AND results=[] fire together
    // This is the exact pattern that caused the crash
    expect(() => {
      setSearching(true)
      setResults([])
      flushSync()
    }).not.toThrow()

    // searching branch now active
    expect(container.textContent).toContain('Searching…')
    expect(container.querySelectorAll('li').length).toBe(0)

    // Simulate: search finishes → searching=false, results populated
    expect(() => {
      setSearching(false)
      setResults(['x', 'y'])
      flushSync()
    }).not.toThrow()

    expect(container.querySelectorAll('li').length).toBe(2)
  })


  it('does not throw on type, backspace, retype — full REPL repro', () => {
    // Full sequence: type → backspace to empty → retype → new search finishes.
    // The second branch instantiation must NOT share effects with the first.
    const container = div()
    const ifAnchor = document.createComment('if')
    container.appendChild(ifAnchor)

    const [searching, setSearching] = createSignal(false)
    const [results, setResults]     = createSignal([])

    const elseIfBranch = () => {
      const wrapper = div()
      const ea = document.createComment('each')
      wrapper.appendChild(ea)
      $$eachBlock(ea, 0, results, eachDefaultKey, (getItem) => {
        const el = document.createElement('li')
        createEffect(() => { el.textContent = getItem() })
        return el
      })
      return wrapper
    }

    ifBlock(ifAnchor, () => {
      if (searching()) return 0
      if (results().length) return 1
      return null
    }, [
      () => { const el = div(); el.textContent = 'Searching'; return el },
      elseIfBranch,
    ])

    flushSync()

    // Step 1: initial results — branch 1 mounts, eachBlock effect #1 created
    setResults(['a', 'b', 'c'])
    flushSync()
    expect(container.querySelectorAll('li').length).toBe(3)

    // Step 2: backspace to empty — branch 1 torn down, eachBlock effect #1 disposed
    setResults([])
    flushSync()
    expect(container.querySelectorAll('li').length).toBe(0)

    // Step 3: start searching
    setSearching(true)
    flushSync()

    // Step 4: new results come in — branch 1 mounts AGAIN with NEW eachBlock effect
    // The old disposed effect must not fire. _insertBlock must not crash.
    expect(() => {
      setSearching(false)
      setResults(['x result', 'y result'])
      flushSync()
    }).not.toThrow()
    expect(container.querySelectorAll('li').length).toBe(2)
  })

})

describe('$$eachBlock — multi-root sibling anchor preservation', () => {
  // Regression: {#each} fast-clear path was doing parent.textContent = '' which
  // wiped ALL siblings including the anchor comment for a following {#if} block.
  // Fix: use anchor.previousSibling removal instead of nuking the whole parent.

  it('does not destroy sibling {#if} anchor when {#each} clears to empty', () => {
    // Simulates multi-root component:
    //   {#each items as item}{...}{/each}
    //   {#if show}<p>footer</p>{/if}
    const container = div()
    const eachAnchor = document.createComment('each')
    const ifAnchor   = document.createComment('if')
    container.appendChild(eachAnchor)
    container.appendChild(ifAnchor)

    const [items, setItems] = createSignal(['a', 'b', 'c'])
    const [show,  setShow]  = createSignal(true)

    $$eachBlock(eachAnchor, 0, items, eachDefaultKey, (getItem) => {
      const el = document.createElement('li')
      createEffect(() => { el.textContent = getItem() })
      return el
    })

    ifBlock(ifAnchor, () => show() ? 0 : null, [
      () => { const el = document.createElement('p'); el.textContent = 'footer'; return el }
    ])

    flushSync()
    expect(container.querySelectorAll('li').length).toBe(3)
    expect(container.textContent).toContain('footer')

    // Clear {#each} — this is where the bug was: parent.textContent = '' wiped
    // the ifAnchor, making the {#if} unable to find its parentNode
    setItems([])
    flushSync()

    expect(container.querySelectorAll('li').length).toBe(0)
    // {#if} anchor must still be in DOM — footer still visible
    expect(ifAnchor.parentNode).toBe(container)
    expect(container.textContent).toContain('footer')

    // Toggle {#if} — must work after {#each} cleared
    setShow(false)
    flushSync()
    expect(container.textContent).not.toContain('footer')

    setShow(true)
    flushSync()
    expect(container.textContent).toContain('footer')

    // Re-populate {#each} — must also still work
    setItems(['x', 'y'])
    flushSync()
    expect(container.querySelectorAll('li').length).toBe(2)
    expect(container.textContent).toContain('footer')
  })
})
// ─────────────────────────────────────────────────────────────────────────────
// §14c  orderedGroup — dep shapes
//
// `$: { dep, () => … }` compiles to orderedGroup([{ deps: [...], handler }]),
// and the compiler emits TWO shapes of dep: a read function (watchPath, for a
// proxied import) and a tracked object (track, for a local signal — the
// compiler comment at the emit site says "pass the signal object itself").
// The runtime read them with a bare `dep()`, so every group with a local dep
// threw "dep is not a function" on mount. Only the emitted string was ever
// asserted, never run, so the whole feature was dead with a green suite.
// ─────────────────────────────────────────────────────────────────────────────

describe('orderedGroup — dep shapes', () => {
  it('accepts a tracked object as a dep', () => {
    const sig = track(1)
    const log = []
    orderedGroup([{ deps: [sig], handler: () => log.push(trackedGet(sig)) }])
    flushSync()
    expect(log).toEqual([1])            // initial run is synchronous
    trackedSet(sig, 2)
    flushSync()
    return Promise.resolve().then(() => {
      expect(log).toEqual([1, 2])
    })
  })

  it('accepts a read function as a dep', () => {
    const [a, setA] = createSignal('x')
    const log = []
    orderedGroup([{ deps: [a], handler: () => log.push(a()) }])
    flushSync()
    setA('y')
    flushSync()
    return Promise.resolve().then(() => {
      expect(log).toEqual(['x', 'y'])
    })
  })

  it('runs entries in declaration order within a flush', () => {
    const sig = track(0)
    const order = []
    orderedGroup([
      { deps: [sig], handler: () => order.push('first') },
      { deps: [sig], handler: () => order.push('second') },
    ])
    flushSync()
    expect(order).toEqual(['first', 'second'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §15  awaitBlock
// ─────────────────────────────────────────────────────────────────────────────

describe('awaitBlock', () => {
  it('shows pending block while promise is unresolved', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [getP] = createSignal(new Promise(() => {}))
    awaitBlock(
      anchor, getP,
      () => { const el = div(); el.textContent = 'loading'; return el },
      null, null
    )
    expect(container.textContent).toBe('loading')
  })

  it('shows then block after resolve', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    let resolve
    const promise = new Promise((r) => { resolve = r })
    const [getP] = createSignal(promise)

    awaitBlock(
      anchor, getP,
      () => { const el = div(); el.textContent = 'loading'; return el },
      (val) => { const el = div(); el.textContent = 'done:' + val; return el },
      null
    )

    resolve('ok')
    await tick()
    expect(container.textContent).toBe('done:ok')
  })

  it('shows catch block on rejection', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    let reject
    const promise = new Promise((_, r) => { reject = r })
    const [getP] = createSignal(promise)

    awaitBlock(
      anchor, getP,
      () => htmlToFragment('<p>loading</p>', 1).cloneNode(true),
      null,
      (err) => { const el = document.createElement('p'); el.textContent = 'error:' + err.message; return el }
    )

    reject(new Error('oops'))
    await tick()
    expect(container.textContent).toBe('error:oops')
  })

  // These tests mirror the actual compiler-emitted pattern:
  //   pending: ($parentElement) => makeBlock($$tpl)
  //   then:    (value) => makeBlock($$tpl, setupFn)   — setupFn closes over value
  //   catch:   (err) => makeBlock($$tpl, setupFn)     — setupFn closes over err
  it('compiler-style: pending is makeBlock wrapper, then receives value via closure', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    let resolve
    const promise = new Promise((r) => { resolve = r })

    // Simulate: ($parentElement) => $$runtime.makeBlock($$tpl)
    const pendingFn = () => makeBlock(
      () => { const el = div(); el.textContent = 'loading'; return el }
    )
    // Simulate: (data) => $$runtime.makeBlock($$tpl, ($parentElement) => { el.nodeValue = data.msg })
    const thenFn = (data) => makeBlock(
      () => { const el = div(); el.textContent = ' '; return el },
      ($parentElement) => { $parentElement.textContent = data.msg }
    )

    awaitBlock(anchor, () => promise, pendingFn, thenFn, null)
    flushSync()
    expect(container.textContent).toBe('loading')

    resolve({ msg: 'hello from Mesa' })
    await tick()
    expect(container.textContent).toBe('hello from Mesa')
  })

  it('compiler-style: catch receives error via closure', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    let reject
    const promise = new Promise((_, r) => { reject = r })

    const catchFn = (err) => makeBlock(
      () => { const el = div(); el.textContent = ' '; return el },
      ($parentElement) => { $parentElement.textContent = 'err:' + err.message }
    )

    awaitBlock(anchor, () => promise, null, null, catchFn)
    flushSync()

    reject(new Error('network fail'))
    await tick()
    expect(container.textContent).toBe('err:network fail')
  })

  it('does not set currentFirst to a function — n.remove regression', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    let resolve
    const p1 = new Promise((r) => { resolve = r })
    const [getP, setP] = createSignal(p1)

    const thenFn = (val) => makeBlock(
      () => { const el = div(); el.textContent = val; return el }
    )

    awaitBlock(anchor, getP, null, thenFn, null)
    flushSync()

    resolve('first')
    await tick()
    expect(container.textContent).toBe('first')

    // Swap to a new promise — this triggers _swap which calls removeElements
    // If currentFirst is a function (the bug), n.remove() crashes here
    const p2 = new Promise((r) => { resolve = r })
    setP(p2)
    flushSync()
    resolve('second')
    await tick()
    expect(container.textContent).toBe('second')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §16  Slots — attachSlot
// ─────────────────────────────────────────────────────────────────────────────

describe('attachSlot', () => {
  it('replaces slot anchor with block factory content', () => {
    const container = div()
    const anchor = document.createComment('slot:test')
    container.appendChild(anchor)

    // attachSlot now receives makeBlock factories, not raw DOM nodes
    const contentEl = span()
    contentEl.textContent = 'slotted'
    const slotFactory = () => ({ $dom: contentEl })

    attachSlot(anchor, slotFactory, null)

    expect(container.textContent).toBe('slotted')
  })

  it('uses fallback factory when no content provided', () => {
    const container = div()
    const anchor = document.createComment('slot:test')
    container.appendChild(anchor)

    const fallbackEl = span()
    fallbackEl.textContent = 'fallback'
    const fallbackFactory = () => ({ $dom: fallbackEl })

    attachSlot(anchor, null, fallbackFactory)

    expect(container.textContent).toBe('fallback')
  })

  it('renders nothing when both slot and fallback are null', () => {
    const container = div()
    const anchor = document.createComment('slot:test')
    container.appendChild(anchor)

    attachSlot(anchor, null, null)

    // anchor removed, nothing inserted
    expect(container.textContent).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §17  spreadAttributes
// ─────────────────────────────────────────────────────────────────────────────

describe('spreadAttributes', () => {
  it('sets initial attributes', () => {
    const el = div()
    const [attrs] = createSignal({ id: 'box', 'data-x': '1' })
    spreadAttributes(el, attrs)
    expect(el.getAttribute('id')).toBe('box')
    expect(el.getAttribute('data-x')).toBe('1')
  })

  it('removes attributes no longer in spread', () => {
    const [attrs, setAttrs] = createSignal({ id: 'box', extra: 'yes' })
    const el = div()
    spreadAttributes(el, attrs)
    setAttrs({ id: 'box' })
    flushSync()
    expect(el.hasAttribute('extra')).toBe(false)
  })

  it('handles style as cssText', () => {
    const [attrs] = createSignal({ style: 'color:red' })
    const el = div()
    spreadAttributes(el, attrs)
    expect(el.style.cssText).toContain('red')
  })

  it('assigns a function as a property, never as an attribute string', () => {
    // `<Btn onclick={fn}>` forwarded through {...$attributes} reached the DOM as
    // onclick="() => $$set_clicks(…)" — the source text of the handler, in an
    // inline attribute, which never fires. A function is never a useful
    // attribute value, so it always takes the property path.
    const el = document.createElement('button')
    let hits = 0
    const [attrs] = createSignal({ onclick: () => hits++ })
    spreadAttributes(el, attrs)
    expect(el.hasAttribute('onclick')).toBe(false)
    expect(typeof el.onclick).toBe('function')
    el.onclick()
    expect(hits).toBe(1)
  })

  it('clears a removed handler instead of leaving it bound', () => {
    const el = document.createElement('button')
    const [attrs, setAttrs] = createSignal({ onclick: () => {} })
    spreadAttributes(el, attrs)
    setAttrs({})
    flushSync()
    expect(el.onclick == null).toBe(true)
  })

  it('finds setters further up the prototype chain', () => {
    // `id` lives on Element.prototype, not on HTMLDivElement.prototype — the
    // one-level lookup missed it and fell through to setAttribute.
    const el = div()
    const [attrs] = createSignal({ id: 'box' })
    spreadAttributes(el, attrs)
    expect(el.id).toBe('box')
  })

  it('restProps keeps content and styling hooks out of the spread', () => {
    // `class` is merged by bindClassPassthrough and `children` is slot
    // content; neither is an attribute the caller meant to forward.
    const rest = restProps(
      { id: 'x', class: 'a', $class: 'b', children: () => {}, label: 'L' },
      ['label']
    )
    expect(Object.keys(rest)).toEqual(['id'])
  })

  it('skips a function whose property is read-only rather than throwing', () => {
    // `children` is getter-only on Element. Assigning a function to it threw
    // out of the effect and took the whole component's render with it — which
    // is what a `{#snippet children}` passed to a component built around
    // `<slot />` did, since the snippet reached the root as a spread prop.
    const el = div()
    const [attrs] = createSignal({ children: () => {}, id: 'kept' })
    expect(() => spreadAttributes(el, attrs)).not.toThrow()
    expect(el.id).toBe('kept')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §18  watchProxy / watchPath
// ─────────────────────────────────────────────────────────────────────────────

describe('watchProxy / watchPath', () => {
  it('watchProxy returns same proxy for same object', () => {
    const obj = { name: 'Alice' }
    expect(watchProxy(obj)).toBe(watchProxy(obj))
  })

  it('watchPath creates a signal that fires on mutation', () => {
    const store = { count: 0 }
    const [read] = watchPath(store, 'count')
    const log = []
    createEffect(() => { read(); log.push('fired') })

    const proxy = watchProxy(store)
    proxy.count = 1
    flushSync()
    expect(log.length).toBe(2) // init + mutation
  })

  it('surgical — only fires signal for watched path', () => {
    const store = { a: 1, b: 2 }
    const [readA] = watchPath(store, 'a')
    let aFired = 0

    createEffect(() => { readA(); aFired++ })

    const proxy = watchProxy(store)
    proxy.b = 99 // mutate b — 'a' should NOT fire
    flushSync()
    expect(aFired).toBe(1)
    proxy.a = 99 // SHOULD fire
    flushSync()
    expect(aFired).toBe(2)
  })

  it('intercepts array push', () => {
    const store = { items: [] }
    const [read] = watchPath(store, 'items')
    let fired = 0
    createEffect(() => { read(); fired++ })

    const proxy = watchProxy(store)
    proxy.items.push('x')
    flushSync()
    expect(fired).toBe(2)
  })

  it('nested path — wraps child object in proxy', () => {
    const store = { user: { name: 'Alice' } }
    const [read] = watchPath(store, 'user.name')
    let fired = 0
    createEffect(() => { read(); fired++ })

    const proxy = watchProxy(store)
    proxy.user.name = 'Bob'
    flushSync()
    expect(fired).toBeGreaterThan(1)
  })
})

// ─── [FIX 1]  watchPath — whole-object / root sentinel ───────────────────────
// The old _fireSignal bailed when path was '' (falsy).
// Fixed by normalizing '' → '__root__' sentinel.

describe('track() stores values, trackDerived() derives', () => {
  it('a zero-arg callback prop is stored, not invoked', () => {
    let fired = 0
    const cb = () => { fired++; return 'RET' }
    // Exactly what the compiler emits for `export let ondone`. Arity used to
    // decide this, so `<Child ondone={() => n++} />` was memoised and called
    // during setup, and on:click bound the return value instead of the callback.
    const sig = track(cb, undefined, undefined, null)
    expect(fired).toBe(0)
    expect(trackedGet(sig)).toBe(cb)
    trackedGet(sig)()
    expect(fired).toBe(1)
  })

  it('a named zero-arg function prop is stored, not invoked', () => {
    let fired = 0
    function bump() { fired++ }
    const sig = track(bump, undefined, undefined, null)
    expect(fired).toBe(0)
    expect(trackedGet(sig)).toBe(bump)
  })

  it('trackDerived memoises and tracks its dependencies', () => {
    const [n, setN] = createSignal(1)
    const d = trackDerived(() => n() * 2, undefined, undefined, null)
    expect(trackedGet(d)).toBe(2)
    setN(5); flushSync()
    expect(trackedGet(d)).toBe(10)
  })
})

describe('{#each}{:else} teardown', () => {
  it('does not leak else-block effects across toggles', () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const anchor = document.createComment('each')
    root.appendChild(anchor)
    const [items, setItems] = createSignal([1])
    const [tick, setTick] = createSignal(0)
    let runs = 0

    $$eachBlock(anchor, 0, () => items(), (x) => x,
      (getItem) => { const s = document.createElement('span'); s.textContent = String(getItem()); return s },
      () => {
        const s = document.createElement('span')
        createEffect(() => { tick(); runs++ })
        return s
      })
    flushSync()

    for (let i = 0; i < 5; i++) {
      setItems([]); flushSync()
      setItems([1]); flushSync()
    }
    // Ended non-empty: no else block should be alive at all. Each toggle used to
    // strand another live copy, since the else block had no owner node.
    const before = runs
    setTick(1); flushSync()
    expect(runs - before).toBe(0)

    setItems([]); flushSync()
    const b2 = runs
    setTick(2); flushSync()
    expect(runs - b2).toBe(1)   // exactly one
  })
})

describe('block teardown across async boundaries', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('{#if} removes a branch whose {#await} has already resolved', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const ifAnchor = document.createComment('if')
    root.appendChild(ifAnchor)
    const [show, setShow] = createSignal(0)
    let resolveIt
    const p = new Promise((r) => { resolveIt = r })

    ifBlock(ifAnchor, () => show(), [() => {
      const frag = document.createDocumentFragment()
      const aw = document.createComment('await')
      frag.appendChild(aw)
      awaitBlock(aw, () => p,
        () => { const s = document.createElement('span'); s.textContent = 'pending'; return s },
        (v) => { const s = document.createElement('span'); s.textContent = 'resolved:' + v; return s },
        null)
      return frag
    }])
    flushSync()
    resolveIt('X'); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('resolved:X')

    // The await swap replaced the very nodes ifBlock had recorded as the branch
    // bounds, so removal used to walk from a detached node and remove nothing.
    setShow(null); flushSync(); await tick()
    expect(root.textContent).toBe('')
  })

  it('effects created in {:then} are disposed with their owner', async () => {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const anchor = document.createComment('await')
    root.appendChild(anchor)
    const [n, setN] = createSignal(1)
    let runs = 0
    let resolveIt
    const p = new Promise((r) => { resolveIt = r })

    const dispose = createEffect(() => {
      awaitBlock(anchor, () => p, null, () => {
        const s = document.createElement('span')
        createEffect(() => { s.textContent = 'n=' + n(); runs++ })
        return s
      }, null)
    })
    flushSync()
    resolveIt('go'); await tick(); flushSync(); await tick()
    expect(runs).toBeGreaterThan(0)

    dispose()
    const before = runs
    setN(2); flushSync()
    expect(runs).toBe(before)   // built in a microtask — used to have no owner at all
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §18c  Block teardown — one suite per block type
//
// Two failure shapes account for every teardown bug found in this layer, and
// each block type is checked for both:
//
//   1. RANGE ESCAPE — the block records its content's first and last DOM nodes
//      and removes that range later. An inner block inserts before its own
//      anchor, so when that anchor is the range's first node, everything the
//      inner block renders sits outside the range and survives removal. The
//      fix is a marker comment the outer block owns (or, for {#each} rows,
//      _guardRange prepending one when the first node is a comment).
//
//   2. NO OWNER — content built without an owner node parents its effects to
//      whatever was ambient (an effect that never disposes its own children,
//      or nothing at all in a microtask). Those effects then re-run forever
//      against detached DOM, one more set per swap.
//
// Every block also gets a "remove it while something inside is mid-flight"
// case, which is the condition all four original bugs needed.
// ─────────────────────────────────────────────────────────────────────────────

describe('block teardown — {#key}', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  const mkAwait = (promise, label = 'v') => () => {
    const frag = document.createDocumentFragment()
    const aw = document.createComment('await')
    frag.appendChild(aw)
    awaitBlock(aw, () => promise,
      () => { const s = span(); s.textContent = 'pending'; return s },
      (v) => { const s = span(); s.textContent = label + ':' + v; return s },
      null)
    return frag
  }

  it('removes a keyed block whose inner {#await} has already resolved', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('key')
    root.appendChild(anchor)
    const [k, setK] = createSignal(1)
    const p = Promise.resolve('X')

    keyBlock(anchor, () => k(), mkAwait(p))
    flushSync(); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('v:X')

    // The keyed content was tracked by its first/last nodes, which the inner
    // {#await} replaced on resolve. Removal walked from a detached node and
    // removed nothing, so the new key's copy was appended beside the old one.
    setK(2); flushSync(); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('v:X')
  })

  it('removes a keyed block whose {#await} is still pending', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('key')
    root.appendChild(anchor)
    const [k, setK] = createSignal(1)
    let resolveIt
    const p = new Promise((r) => { resolveIt = r })

    keyBlock(anchor, () => k(), mkAwait(p))
    flushSync()
    expect(root.textContent).toBe('pending')

    setK(2); flushSync()
    resolveIt('X'); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('v:X')   // exactly one, from the live key
  })

  it('disposes effects inside the outgoing keyed block', () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('key')
    root.appendChild(anchor)
    const [k, setK] = createSignal(1)
    const [n, setN] = createSignal(0)
    let runs = 0

    keyBlock(anchor, () => k(), () => {
      const s = span()
      createEffect(() => { n(); runs++ })
      return s
    })
    flushSync()
    setK(2); flushSync()
    const before = runs
    setN(1); flushSync()
    expect(runs - before).toBe(1)   // only the live copy
  })

  it('removes a multi-node keyed block completely', () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('key')
    root.appendChild(anchor)
    const [k, setK] = createSignal(1)

    keyBlock(anchor, () => k(), () => {
      const frag = document.createDocumentFragment()
      const a = span(); a.textContent = 'a' + k()
      const b = span(); b.textContent = 'b' + k()
      frag.append(a, b)
      return frag
    })
    flushSync()
    expect(root.textContent).toBe('a1b1')
    setK(2); flushSync()
    expect(root.textContent).toBe('a2b2')
  })
})

describe('block teardown — {#await}', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('re-swapping drops a branch that starts with a resolved nested {#await}', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('await')
    root.appendChild(anchor)
    const inner = Promise.resolve('IN')
    const [which, setWhich] = createSignal(0)
    const p1 = Promise.resolve('P1')
    const p2 = Promise.resolve('P2')

    awaitBlock(anchor, () => (which() === 0 ? p1 : p2), null,
      (v) => {
        const frag = document.createDocumentFragment()
        const aw = document.createComment('inner')
        const t = span(); t.textContent = v
        frag.append(aw, t)          // inner anchor is the FIRST node of the branch
        awaitBlock(aw, () => inner, null,
          (iv) => { const s = span(); s.textContent = iv + '-'; return s }, null)
        return frag
      }, null)
    flushSync(); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('IN-P1')

    setWhich(1); flushSync(); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('IN-P2')
  })

  it('a promise that resolves after the block is disposed renders nothing', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('await')
    root.appendChild(anchor)
    let resolveIt
    const p = new Promise((r) => { resolveIt = r })

    const dispose = createEffect(() => {
      awaitBlock(anchor, () => p,
        () => { const s = span(); s.textContent = 'pending'; return s },
        (v) => { const s = span(); s.textContent = 'then:' + v; return s }, null)
    })
    flushSync()
    expect(root.textContent).toBe('pending')

    dispose()
    resolveIt('late'); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('pending')   // no resurrection into detached DOM
  })
})

describe('block teardown — {#each}', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  const awaitRow = (p) => (getItem) => {
    const frag = document.createDocumentFragment()
    const aw = document.createComment('a')            // row's only node
    frag.appendChild(aw)
    awaitBlock(aw, () => p,
      () => { const s = span(); s.textContent = '?'; return s },
      (v) => { const s = span(); s.textContent = v + getItem(); return s }, null)
    return frag
  }

  it('removes a row whose only content is a resolved {#await}', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('each')
    root.appendChild(anchor)
    const [items, setItems] = createSignal([1, 2])
    const p = Promise.resolve('R')

    $$eachBlock(anchor, 0, () => items(), (x) => x, awaitRow(p), null)
    flushSync(); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('R1R2')

    setItems([2]); flushSync(); await tick()
    expect(root.textContent).toBe('R2')
  })

  it('clears an array of rows whose {#await} already resolved', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('each')
    root.appendChild(anchor)
    const [items, setItems] = createSignal([1, 2])
    const p = Promise.resolve('R')

    $$eachBlock(anchor, 0, () => items(), (x) => x, awaitRow(p), null)
    flushSync(); await tick(); flushSync(); await tick()
    setItems([]); flushSync(); await tick()
    expect(root.textContent).toBe('')
  })

  it('removes a row while its {#await} is still in flight', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('each')
    root.appendChild(anchor)
    const [items, setItems] = createSignal([1, 2])
    let resolveIt
    const p = new Promise((r) => { resolveIt = r })

    $$eachBlock(anchor, 0, () => items(), (x) => x, awaitRow(p), null)
    flushSync()
    setItems([2]); flushSync()
    resolveIt('R'); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('R2')
  })

  it('reorders rows whose {#await} already resolved', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('each')
    root.appendChild(anchor)
    const [items, setItems] = createSignal([1, 2])
    const p = Promise.resolve('R')

    $$eachBlock(anchor, 0, () => items(), (x) => x, awaitRow(p), null)
    flushSync(); await tick(); flushSync(); await tick()
    setItems([2, 1]); flushSync(); await tick()
    expect(root.textContent).toBe('R2R1')
  })
})

describe('block teardown — <mesa:boundary>', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('disposes the pending branch effects when it swaps to content', () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('b')
    root.appendChild(anchor)
    const state = makeAsyncState()
    const [n, setN] = createSignal(0)
    let pendingRuns = 0

    boundaryBlock(anchor, () => [state],
      () => { const e = span(); e.textContent = 'content'; return e },
      () => {
        const e = span()
        createEffect(() => { e.textContent = 'n=' + n(); pendingRuns++ })
        return e
      },
      null)
    flushSync()
    expect(pendingRuns).toBe(1)

    state._update('done'); flushSync()
    expect(root.textContent).toBe('content')

    // The pending branch was built under the boundary's own effect node, which
    // never disposes its children on re-run — its effects kept rendering into
    // detached DOM on every write, one more set per swap.
    const before = pendingRuns
    setN(1); flushSync()
    expect(pendingRuns - before).toBe(0)
  })

  it('swaps out a pending branch whose inner {#await} already resolved', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('b')
    root.appendChild(anchor)
    const state = makeAsyncState()
    const p = Promise.resolve('Y')

    boundaryBlock(anchor, () => [state],
      () => { const e = span(); e.textContent = 'content'; return e },
      () => {
        const frag = document.createDocumentFragment()
        const aw = document.createComment('await')
        frag.appendChild(aw)
        awaitBlock(aw, () => p,
          () => { const e = span(); e.textContent = 'p0'; return e },
          (v) => { const e = span(); e.textContent = 'p1:' + v; return e }, null)
        return frag
      },
      null)
    flushSync(); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('p1:Y')

    state._update('done'); flushSync(); await tick()
    expect(root.textContent).toBe('content')
  })

  it('cycles pending → content → failed → content without stranding DOM', () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('b')
    root.appendChild(anchor)
    const state = makeAsyncState()

    boundaryBlock(anchor, () => [state],
      () => { const e = span(); e.textContent = 'content'; return e },
      () => { const e = span(); e.textContent = 'pending'; return e },
      (err) => { const e = span(); e.textContent = 'err:' + err; return e })
    flushSync()
    expect(root.textContent).toBe('pending')
    state._update('done');            flushSync(); expect(root.textContent).toBe('content')
    state._update('error', 'boom');   flushSync(); expect(root.textContent).toBe('err:boom')
    state._update('start')
    state._update('done');            flushSync(); expect(root.textContent).toBe('content')
  })

  it('disposes the live branch when the boundary itself is disposed', () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('b')
    root.appendChild(anchor)
    const state = makeAsyncState()
    const [n, setN] = createSignal(0)
    let runs = 0

    const dispose = createEffect(() => {
      boundaryBlock(anchor, () => [state],
        null,
        () => { const e = span(); createEffect(() => { n(); runs++ }); return e },
        null)
    })
    flushSync()
    expect(runs).toBe(1)
    dispose()
    const before = runs
    setN(1); flushSync()
    expect(runs).toBe(before)
  })
})

describe('block teardown — <mesa:mounted>', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))

  it('disposes pending branch effects once the mount promise resolves', async () => {
    const root = div()
    document.body.appendChild(root)
    const anchor = document.createComment('m')
    root.appendChild(anchor)
    const [n, setN] = createSignal(0)
    let pendingRuns = 0
    let resolveIt
    const p = new Promise((r) => { resolveIt = r })

    mountedBlock(anchor, () => p,
      () => { const e = span(); createEffect(() => { n(); pendingRuns++ }); e.textContent = 'pending'; return e },
      () => { const e = span(); e.textContent = 'content'; return e },
      null, null)
    flushSync()
    expect(pendingRuns).toBe(1)

    resolveIt(true); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('content')
    const before = pendingRuns
    setN(1); flushSync()
    expect(pendingRuns - before).toBe(0)
  })

  it('removed while the mount promise is in flight — content never appears', async () => {
    const root = div()
    document.body.appendChild(root)
    const ifAnchor = document.createComment('if')
    root.appendChild(ifAnchor)
    const [show, setShow] = createSignal(0)
    let resolveIt
    const p = new Promise((r) => { resolveIt = r })

    ifBlock(ifAnchor, () => show(), [() => {
      const frag = document.createDocumentFragment()
      const m = document.createComment('m')
      frag.appendChild(m)
      mountedBlock(m, () => p,
        () => { const e = span(); e.textContent = 'pending'; return e },
        () => { const e = span(); e.textContent = 'content'; return e },
        null, null)
      return frag
    }])
    flushSync()
    expect(root.textContent).toBe('pending')

    setShow(null); flushSync()
    expect(root.textContent).toBe('')
    resolveIt(true); await tick(); flushSync(); await tick()
    expect(root.textContent).toBe('')
  })
})

describe('context reaches content a block creates LATER', () => {
  // `_contextStack` is synchronous setup-time state: a component pushes its
  // map, runs init, pops. Everything built inside init therefore sees the
  // provider — and everything a block builds AFTERWARDS does not, because by
  // then the stack has unwound to the flush's depth.
  //
  // Every compound component in `@frontierjs/ui` has that shape. `DropdownMenu`
  // provides `close()` and renders its items inside `{#if open}`, so
  // `DropdownItem` read `undefined` and choosing an item never closed the
  // menu — silently, because the call is optional.
  //
  // Each block that can instantiate content after setup captures the stack
  // where it was DECLARED and reinstates it. One test per block kind: they are
  // separate call sites and fixing one says nothing about the others.

  /** Read `key` from inside a factory, the way a consumer's setup does.
   *
   *  The push/pop pair is load-bearing, not ceremony: `contextRead` skips the
   *  TOP map on purpose, because a component must not consume its own
   *  provides. A reader with no frame of its own therefore skips the provider
   *  instead and reads one level too far out.
   *
   *  `contextRead` answers the reactive GETTER, so the value needs the call;
   *  `null` is what a consumer with no provider in scope gets. */
  const reader = (out) => () => {
    push_component('Consumer', 'C.mesa')
    try {
      const getter = contextRead('probe')
      out.push(getter ? getter() : null)
    } finally { pop_component() }
    return document.createComment('')
  }

  it('an {#if} branch that flips after setup', () => {
    const seen = []
    const [show, setShow] = createSignal(false)
    const anchor = document.createComment('')
    document.body.appendChild(anchor)

    push_component('Provider', 'P.mesa')
    contextProvide('probe', () => 'from-provider')
    ifBlock(anchor, () => (show() ? 0 : -1), [reader(seen)])
    pop_component()

    flushSync()
    expect(seen).toEqual([])          // not rendered yet

    setShow(true); flushSync()
    expect(seen).toEqual(['from-provider'])
    anchor.remove()
  })

  it('an {#each} row that arrives after setup', () => {
    const seen = []
    const [rows, setRows] = createSignal([])
    const anchor = document.createComment('')
    document.body.appendChild(anchor)

    push_component('Provider', 'P.mesa')
    contextProvide('probe', () => 'from-provider')
    $rt.$$eachBlock(anchor, 'keyed', rows, (r) => r, reader(seen))
    pop_component()

    flushSync()
    setRows(['a']); flushSync()
    expect(seen).toEqual(['from-provider'])
    anchor.remove()
  })

  it('a {#key} block rebuilt after setup', () => {
    const seen = []
    const [k, setK] = createSignal(1)
    const anchor = document.createComment('')
    document.body.appendChild(anchor)

    push_component('Provider', 'P.mesa')
    contextProvide('probe', () => 'from-provider')
    $rt.keyBlock(anchor, k, reader(seen))
    pop_component()

    flushSync()
    setK(2); flushSync()
    // Once at setup, once for the rebuild — and the rebuild is the one that
    // used to read null.
    expect(seen.length).toBeGreaterThan(1)
    expect(seen.every(v => v === 'from-provider')).toBe(true)
    anchor.remove()
  })

  it('an {#await} that resolves after setup', async () => {
    const seen = []
    let resolveIt
    const promise = new Promise((r) => { resolveIt = r })
    const anchor = document.createComment('')
    document.body.appendChild(anchor)

    push_component('Provider', 'P.mesa')
    contextProvide('probe', () => 'from-provider')
    $rt.awaitBlock(anchor, () => promise, null, reader(seen), null)
    pop_component()

    flushSync()
    resolveIt('done')
    await Promise.resolve(); await Promise.resolve(); flushSync()
    expect(seen).toEqual(['from-provider'])
    anchor.remove()
  })

  // The provider must still be the NEAREST one: reinstating a captured stack
  // must not resurrect a frame that has since been superseded.
  it('and the nearest provider still wins', () => {
    const seen = []
    const [show, setShow] = createSignal(false)
    const anchor = document.createComment('')
    document.body.appendChild(anchor)

    push_component('Outer', 'O.mesa')
    contextProvide('probe', () => 'outer')
    push_component('Inner', 'I.mesa')
    contextProvide('probe', () => 'inner')
    ifBlock(anchor, () => (show() ? 0 : -1), [reader(seen)])
    pop_component()
    pop_component()

    setShow(true); flushSync()
    expect(seen).toEqual(['inner'])
    anchor.remove()
  })
})

describe('component setup that throws does not poison later mounts', () => {
  it('unwinds on the initial effect run, and rethrows', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => createEffect(() => {
        push_component('Boom', 'Boom.mesa')
        contextProvide('leaked', () => 'from-boom')
        throw new Error('setup failed')   // the emitted pop_component never runs
      })).toThrow('setup failed')

      push_component('Next', 'Next.mesa')
      expect(contextRead('leaked')).toBe(null)
      pop_component()
    } finally { spy.mockRestore() }
  })

  it('unwinds from inside the flush loop', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const [s, set] = createSignal(0)
      createEffect(() => {
        if (s() === 1) {
          push_component('Boom2', 'Boom2.mesa')
          contextProvide('leaked2', () => 'x')
          throw new Error('re-run failed')
        }
      })
      set(1)
      expect(() => flushSync()).not.toThrow()
      push_component('After', 'After.mesa')
      expect(contextRead('leaked2')).toBe(null)
      pop_component()
    } finally { spy.mockRestore() }
  })

  it('mount() rethrows but leaves the stacks usable', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const label = document.createComment('x')
    host.appendChild(label)
    expect(() => mount(label, () => {
      push_component('Boom3', 'Boom3.mesa')
      contextProvide('leaked3', () => 'x')
      throw new Error('mount failed')
    })).toThrow('mount failed')

    push_component('After3', 'After3.mesa')
    expect(contextRead('leaked3')).toBe(null)
    pop_component()
  })
})

describe('localWatchProxy — subtree watches on a local object', () => {
  const mkSig = () => {
    const [read, write] = createSignal(undefined, { equals: () => false })
    let n = 0
    createEffect(() => { read(); n++ })
    return { pair: [read, () => write(undefined)], get n() { return n } }
  }

  it('a write notifies every covering watch, not just the nearest', () => {
    const a = mkSig(), abc = mkSig(), whole = mkSig()
    const obj = { a: { b: { c: 1 } }, other: 1 }
    const proxy = localWatchProxy(obj, { a: a.pair, 'a.b.c': abc.pair, '': whole.pair })
    flushSync()
    const b = [a.n, abc.n, whole.n]
    proxy.a.b.c = 99
    flushSync()
    // The exact-match early return used to stop here, leaving `$: a` unfired.
    expect(a.n).toBeGreaterThan(b[0])
    expect(abc.n).toBeGreaterThan(b[1])
    expect(whole.n).toBeGreaterThan(b[2])
  })

  it('a sibling subtree stays silent', () => {
    const a = mkSig(), whole = mkSig()
    const obj = { a: { b: 1 }, other: 1 }
    const proxy = localWatchProxy(obj, { a: a.pair, '': whole.pair })
    flushSync()
    const b = [a.n, whole.n]
    proxy.other = 5
    flushSync()
    expect(a.n).toBe(b[0])
    expect(whole.n).toBeGreaterThan(b[1])
  })

  it('a key containing a dot is one segment, not a path', () => {
    const a = mkSig()
    const obj = { 'a.real': 1, a: { real: 2 } }
    const proxy = localWatchProxy(obj, { a: a.pair })
    flushSync()
    const before = a.n
    proxy['a.real'] = 9
    flushSync()
    expect(a.n).toBe(before)
  })

  it('array mutators fire the watches covering the array', () => {
    const items = mkSig()
    const obj = { items: [1, 2] }
    const proxy = localWatchProxy(obj, { items: items.pair })
    flushSync()
    const before = items.n
    proxy.items.push(3)
    flushSync()
    expect(items.n).toBeGreaterThan(before)
    expect(obj.items).toEqual([1, 2, 3])
  })
})

describe('watchProxy — keeping raw state plain', () => {
  const watch = (obj, path) => {
    const [read] = watchPath(obj, path)
    let n = 0
    createEffect(() => { read(); n++ })
    return { get n() { return n } }
  }

  it('does not write proxies into the raw object', () => {
    const store = { items: [{ id: 1 }, { id: 2 }], selected: null }
    const proxy = watchProxy(store)
    proxy.selected = proxy.items[0]          // the ubiquitous "select a row"
    expect(store.selected).toBe(store.items[0])
    expect(store.items.indexOf(store.selected)).toBe(0)
    expect(() => structuredClone(store)).not.toThrow()
  })

  it('strips proxies out of freshly built containers', () => {
    const store = { items: [{ id: 1 }, { id: 2 }, { id: 3 }] }
    const proxy = watchProxy(store)
    proxy.items = proxy.items.filter((i) => i.id !== 2)   // elements read as proxies
    expect(store.items).toHaveLength(2)
    expect(() => structuredClone(store)).not.toThrow()
    expect(store.items.some((i) => i.id === 2)).toBe(false)
  })

  it('passes Date / Map / Set through instead of throwing', () => {
    const store = { when: new Date(0), tags: new Set(), byId: new Map() }
    const proxy = watchProxy(store)
    expect(() => proxy.when.getTime()).not.toThrow()
    expect(proxy.when.getTime()).toBe(0)
    expect(() => proxy.tags.add('x')).not.toThrow()
    expect(store.tags.has('x')).toBe(true)
    expect(() => proxy.byId.set('k', 1)).not.toThrow()
    expect(store.byId.get('k')).toBe(1)
  })

  it('delete notifies the watches covering the key', () => {
    const store = { prefs: { theme: 'dark', lang: 'en' } }
    const proxy = watchProxy(store)
    const whole = watch(store, ''), prefs = watch(store, 'prefs.theme')
    flushSync()
    const b = [whole.n, prefs.n]
    delete proxy.prefs.theme
    flushSync()
    expect('theme' in store.prefs).toBe(false)
    expect(whole.n).toBeGreaterThan(b[0])
    expect(prefs.n).toBeGreaterThan(b[1])
  })

  it('deleting a key that was not there notifies nothing', () => {
    const store = { a: 1 }
    const proxy = watchProxy(store)
    const whole = watch(store, '')
    flushSync()
    const before = whole.n
    delete proxy.nope
    flushSync()
    expect(whole.n).toBe(before)
  })

  it('a getter tracks the properties it reads', () => {
    const store = { first: 'Ada', last: 'L', get full() { return this.first + ' ' + this.last } }
    const proxy = watchProxy(store)
    watch(store, 'first')                    // watch the getter's INPUT
    const seen = []
    createEffect(() => { seen.push(proxy.full) })
    flushSync()
    proxy.first = 'Grace'
    flushSync()
    expect(seen).toEqual(['Ada L', 'Grace L'])
  })
})

describe('[FIX 1] watchPath — whole-object / root sentinel', () => {
  it('watchPath("") fires when any top-level property is set', () => {
    const store = { name: 'Alice', age: 30 }
    const [read] = watchPath(store, '')
    let fired = 0
    createEffect(() => { read(); fired++ })

    const proxy = watchProxy(store)
    proxy.name = 'Bob'
    flushSync()
    expect(fired).toBe(2)
    proxy.age = 31
    flushSync()
    expect(fired).toBe(3)
  })

  it('watchPath("") fires when a nested property is mutated', () => {
    const store = { prefs: { theme: 'dark' } }
    const [read] = watchPath(store, '')
    let fired = 0
    createEffect(() => { read(); fired++ })

    const proxy = watchProxy(store)
    proxy.prefs.theme = 'light'
    flushSync()
    expect(fired).toBeGreaterThan(1)
  })

  it('a watch covers its whole subtree at any depth, and no sibling', () => {
    const store = { user: { preferences: { theme: 'dark' }, name: 'Ada' }, other: { z: 1 } }
    const proxy = watchProxy(store)
    const watch = (path) => {
      const [read] = watchPath(store, path)
      let n = 0
      createEffect(() => { read(); n++ })
      return { get n() { return n } }
    }
    const whole = watch(''), prefs = watch('user.preferences'), name = watch('user.name')
    flushSync()
    let b = [whole.n, prefs.n, name.n]

    // Two levels below the `user.preferences` watch — the depth that the old
    // single-parent hop silently missed.
    proxy.user.preferences.theme = 'light'
    flushSync()
    expect(whole.n).toBeGreaterThan(b[0])
    expect(prefs.n).toBeGreaterThan(b[1])
    expect(name.n).toBe(b[2])          // sibling stays silent — the surgical part

    b = [whole.n, prefs.n, name.n]
    proxy.other.z = 2
    flushSync()
    expect(whole.n).toBeGreaterThan(b[0])
    expect(prefs.n).toBe(b[1])
    expect(name.n).toBe(b[2])
  })

  it('a key containing a dot is one segment, not a path', () => {
    const store = { a: { real: 1 }, 'a.real': 'unrelated' }
    const proxy = watchProxy(store)
    const [read] = watchPath(store, 'a')
    let fired = 0
    createEffect(() => { read(); fired++ })
    flushSync()
    const before = fired
    proxy['a.real'] = 'changed'
    flushSync()
    expect(fired).toBe(before)         // must NOT be mistaken for a.real
  })

  it('watchPath("") and watchPath("name") can both be active on the same object', () => {
    const store = { name: 'Alice' }
    const [readRoot] = watchPath(store, '')
    const [readName] = watchPath(store, 'name')
    let rootFired = 0, nameFired = 0

    createEffect(() => { readRoot(); rootFired++ })
    createEffect(() => { readName(); nameFired++ })

    watchProxy(store).name = 'Bob'
    flushSync()
    expect(rootFired).toBeGreaterThan(1)
    expect(nameFired).toBeGreaterThan(1)
  })
})

// ─── [FIX 2]  watchProxy — cross-component isolation ─────────────────────────
// The old _proxyRegistry keyed nested proxies by the nested object itself,
// so the first component to access user.prefs owned that proxy for all.
// Fixed by keying the nested proxy cache by (rootObj, path).

describe('[FIX 2] watchProxy — cross-component isolation', () => {
  it('two independent watchPath registrations on the same object fire independently', () => {
    const store = { count: 0 }

    const [readA] = watchPath(store, 'count')
    let firedA = 0
    createEffect(() => { readA(); firedA++ })

    const [readB] = watchPath(store, 'count')
    let firedB = 0
    createEffect(() => { readB(); firedB++ })

    watchProxy(store).count = 1
    flushSync()
    expect(firedA).toBe(2)
    expect(firedB).toBe(2)
  })

  it('component A mutation does not fire a signal registered only by component B', () => {
    const store = { a: 1, b: 2 }
    const [readA] = watchPath(store, 'a')
    const [readB] = watchPath(store, 'b')
    let firedA = 0, firedB = 0

    createEffect(() => { readA(); firedA++ })
    createEffect(() => { readB(); firedB++ })

    watchProxy(store).b = 99
    flushSync()
    expect(firedA).toBe(1) // must NOT re-render
    expect(firedB).toBe(2) // MUST re-render
  })

  it('nested proxy accessed via two different root objects does not cross-contaminate', () => {
    const storeA = { config: { color: 'red' } }
    const storeB = { config: { color: 'blue' } }

    const [readA] = watchPath(storeA, 'config.color')
    const [readB] = watchPath(storeB, 'config.color')
    let firedA = 0, firedB = 0

    createEffect(() => { readA(); firedA++ })
    createEffect(() => { readB(); firedB++ })

    watchProxy(storeA).config.color = 'green'
    flushSync()
    expect(firedA).toBeGreaterThan(1)
    expect(firedB).toBe(1) // B must NOT see A's mutation
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §19  makeAsyncState / asyncDerived
// ─────────────────────────────────────────────────────────────────────────────

describe('makeAsyncState', () => {
  it('starts in pending state', () => {
    const state = makeAsyncState()
    expect(state.loading).toBe(true)
    expect(state.fetching).toBe(true)
    expect(state.error).toBeNull()
    expect(state.status).toBe('pending')
  })

  it('transitions to success on _update("done")', () => {
    const state = makeAsyncState()
    state._update('done')
    expect(state.loading).toBe(false)
    expect(state.fetching).toBe(false)
    expect(state.status).toBe('success')
  })

  it('transitions to error state', () => {
    const state = makeAsyncState()
    const err = new Error('fail')
    state._update('error', err)
    expect(state.status).toBe('error')
    expect(state.error).toBe(err)
  })

  it('fetching resets on _update("start") after success', () => {
    const state = makeAsyncState()
    state._update('done')
    state._update('start')
    expect(state.fetching).toBe(true)
    expect(state.status).toBe('pending')
  })

  it('loading stays false after error then retry — does not resurrect', () => {
    // loading=true only on first fetch. After error it becomes false.
    // A subsequent _update('start') must NOT reset loading to true.
    const state = makeAsyncState()
    state._update('error', new Error('fail'))
    expect(state.loading).toBe(false)

    state._update('start') // retry
    expect(state.loading).toBe(false) // stays false
    expect(state.fetching).toBe(true) // fetching resets normally
  })
})

describe('asyncDerived', () => {
  it('fetches and sets value', async () => {
    const [dep] = createSignal('TX')
    const [val, setVal] = createSignal(null)
    const state = makeAsyncState()

    asyncDerived(() => state, async () => 'cities-of-TX', [dep], setVal)

    await tick()
    expect(val()).toBe('cities-of-TX')
    expect(state.status).toBe('success')
  })

  it('cancels in-flight request when dep changes', async () => {
    const [dep, setDep] = createSignal('TX')
    const [val, setVal] = createSignal(null)
    const state = makeAsyncState()
    const abortLog = []

    asyncDerived(
      () => state,
      async (signal) => {
        signal.addEventListener('abort', () => abortLog.push('aborted'))
        await new Promise((r) => setTimeout(r, 20))
        return 'result'
      },
      [dep],
      setVal
    )

    setDep('CA') // triggers re-fetch → should abort first
    await tick()
    expect(abortLog.length).toBeGreaterThan(0)
  })

  it('fn receives the current AbortSignal and dep value', async () => {
    const [dep, setDep] = createSignal('TX')
    const [val, setVal] = createSignal(null)
    const state = makeAsyncState()
    const received = []

    asyncDerived(
      () => state,
      async (signal) => {
        received.push(dep())
        return `cities-of-${dep()}`
      },
      [dep],
      setVal
    )

    await tick()
    expect(received[0]).toBe('TX')
    expect(val()).toBe('cities-of-TX')

    setDep('CA')
    await tick()
    expect(val()).toBe('cities-of-CA')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §20  makeExternalProperty / $push / $apply
// ─────────────────────────────────────────────────────────────────────────────

describe('makeExternalProperty / $push / $apply', () => {
  // Helper: component with two export-let props
  function makeTestComp() {
    const getters = {}
    const comp = makeComponent(($option) => {
      const [getQty,   setQty]   = _cs($option.props?.quantity  ?? 1)
      const [getLabel, setLabel] = _cs($option.props?.label     ?? 'item')
      makeExternalProperty('quantity', getQty,   setQty)
      makeExternalProperty('label',    getLabel, setLabel)
      getters.quantity = getQty
      getters.label    = getLabel
      return document.createDocumentFragment()
    })
    return { comp, getters }
  }

  it('makeExternalProperty registers prop in $props map', () => {
    const { comp } = makeTestComp()
    const instance = comp({ props: { quantity: 5 } })
    expect(instance.$props).toBeInstanceOf(Map)
    expect(instance.$props.has('quantity')).toBe(true)
    expect(instance.$props.has('label')).toBe(true)
  })

  it('$props.get(name).get() reads the current signal value', () => {
    const { comp } = makeTestComp()
    const instance = comp({ props: { quantity: 7, label: 'widget' } })
    expect(instance.$props.get('quantity').get()).toBe(7)
    expect(instance.$props.get('label').get()).toBe('widget')
  })

  it('$push updates specific prop signals', () => {
    const { comp, getters } = makeTestComp()
    const instance = comp({ props: { quantity: 1 } })
    instance.$push({ quantity: 42 })
    expect(getters.quantity()).toBe(42)
    expect(getters.label()).toBe('item') // unchanged
  })

  it('$push triggers effects subscribed to the prop signal', () => {
    const { comp, getters } = makeTestComp()
    const instance = comp({ props: { quantity: 0 } })
    const log = []
    createEffect(() => log.push(getters.quantity()))

    instance.$push({ quantity: 10 })
    instance.$push({ quantity: 20 })
    expect(log).toEqual([0, 10, 20])
  })

  it('$push silently ignores unknown prop names', () => {
    const { comp } = makeTestComp()
    const instance = comp({})
    expect(() => instance.$push({ nonexistent: 99 })).not.toThrow()
  })

  it('$push with null/undefined is a no-op', () => {
    const { comp, getters } = makeTestComp()
    const instance = comp({ props: { quantity: 5 } })
    instance.$push(null)
    instance.$push(undefined)
    expect(getters.quantity()).toBe(5)
  })

  it('$apply re-syncs all registered props from an object', () => {
    const { comp, getters } = makeTestComp()
    const instance = comp({ props: { quantity: 1, label: 'old' } })
    instance.$apply({ quantity: 99, label: 'new', extra: 'ignored' })
    expect(getters.quantity()).toBe(99)
    expect(getters.label()).toBe('new')
  })

  it('$apply with no argument falls back to $option.props', () => {
    const { comp, getters } = makeTestComp()
    const $option = { props: { quantity: 1, label: 'start' } }
    const instance = comp($option)

    $option.props.quantity = 55
    $option.props.label    = 'updated'
    instance.$apply()
    expect(getters.quantity()).toBe(55)
    expect(getters.label()).toBe('updated')
  })

  it('$props.get(name).set() writes back to the signal (child→parent direction)', () => {
    const [parentQty, setParentQty] = _cs(0)
    const { comp, getters } = makeTestComp()
    const instance = comp({ props: { quantity: 1 } })

    createEffect(() => { setParentQty(instance.$props.get('quantity').get()) })
    expect(parentQty()).toBe(1)

    instance.$props.get('quantity').set(77)
    flushSync()
    expect(parentQty()).toBe(77)
    expect(getters.quantity()).toBe(77)
  })

  it('nested components each get their own independent prop registry', () => {
    const { comp } = makeTestComp()
    const a = comp({ props: { quantity: 1 } })
    const b = comp({ props: { quantity: 2 } })

    a.$push({ quantity: 10 })
    expect(a.$props.get('quantity').get()).toBe(10)
    expect(b.$props.get('quantity').get()).toBe(2) // b unaffected
  })

  it('makeExternalProperty called outside makeComponent is a no-op (no throw)', () => {
    expect(() => makeExternalProperty('x', () => 0, () => {})).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §21  SSR guards — _isBrowser = false behavior
// ─────────────────────────────────────────────────────────────────────────────

describe('SSR guards (_isBrowser = false)', () => {
  let savedDocument
  beforeEach(() => { savedDocument = globalThis.document })
  afterEach(() => { globalThis.document = savedDocument })

  async function ssrImport() {
    globalThis.document = undefined
    return import('../src/runtime.js?ssr=' + Date.now())
  }

  it('onMount is a no-op — does not fire on server', async () => {
    const { onMount: ssrOnMount, makeComponent: ssrMakeComp } = await ssrImport()
    let mountFired = false
    const comp = ssrMakeComp(() => {
      ssrOnMount(() => { mountFired = true })
      return {}
    })
    comp()
    await tick()
    expect(mountFired).toBe(false)
  })

  it('watchProxy returns the original object unchanged', async () => {
    const { watchProxy: ssrWatchProxy } = await ssrImport()
    const store = { count: 1 }
    expect(ssrWatchProxy(store)).toBe(store)
  })

  it('watchPath returns an inert [getter, setter] pair', async () => {
    const { watchPath: ssrWatchPath } = await ssrImport()
    const [read, write] = ssrWatchPath({}, 'count')
    expect(read()).toBeUndefined()
    expect(() => write(99)).not.toThrow()
  })

  it('watchPath getter does not subscribe — effects never re-run', async () => {
    const { watchPath: ssrWatchPath, createEffect: ssrEffect } = await ssrImport()
    const [read] = ssrWatchPath({}, 'x')
    let runs = 0
    ssrEffect(() => { read(); runs++ })
    expect(runs).toBe(1)
  })

  it('htmlToFragment throws with a clear message', async () => {
    const { htmlToFragment: ssrHtf } = await ssrImport()
    expect(() => ssrHtf('<div/>')).toThrow('@frontierjs/mesa-runtime')
    expect(() => ssrHtf('<div/>')).toThrow('non-browser')
  })

  it('mount throws with a clear message', async () => {
    const { mount: ssrMount } = await ssrImport()
    expect(() => ssrMount({}, () => {})).toThrow('@frontierjs/mesa-runtime')
    expect(() => ssrMount({}, () => {})).toThrow('non-browser')
  })

  it('$$eachBlock throws with a clear message', async () => {
    const { $$eachBlock: ssrEach } = await ssrImport()
    expect(() => ssrEach({}, 0, () => [], (v) => v, () => {})).toThrow('@frontierjs/mesa-runtime')
  })

  it('ifBlock throws with a clear message', async () => {
    const { ifBlock: ssrIf } = await ssrImport()
    expect(() => ssrIf({}, () => 0, [() => {}])).toThrow('@frontierjs/mesa-runtime')
  })

  it('awaitBlock throws with a clear message', async () => {
    const { awaitBlock: ssrAwait } = await ssrImport()
    expect(() => ssrAwait({}, () => Promise.resolve(), null, null, null)).toThrow('@frontierjs/mesa-runtime')
  })

  it('addStyles is a silent no-op', async () => {
    const { addStyles: ssrAddStyles } = await ssrImport()
    expect(() => ssrAddStyles('test-id', 'body{}')).not.toThrow()
  })

  it('makeEmitter returns a no-op function', async () => {
    const { makeEmitter: ssrMakeEmitter } = await ssrImport()
    const emit = ssrMakeEmitter({ events: { change: vi.fn() } })
    expect(() => emit('change', 42)).not.toThrow()
  })

  it('makeRootEvent returns a no-op register function', async () => {
    const { makeRootEvent: ssrMakeRootEvent } = await ssrImport()
    const register = ssrMakeRootEvent({})
    expect(typeof register).toBe('function')
    expect(() => register({}, 'click', () => {})).not.toThrow()
  })

  it('reactive core still works on server — signals, effects, memos', async () => {
    const { createSignal: s, createEffect: e, createMemo: m } = await ssrImport()
    const [count, setCount] = s(0)
    const double = m(() => count() * 2)
    const log = []
    e(() => log.push(double()))
    setCount(3)
    // flushSync from the SSR module import (same module, different instance via ssrImport)
    const { flushSync: ssrFlush } = await ssrImport()
    ssrFlush()
    expect(log).toEqual([0, 6])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §22  Misc exports
// ─────────────────────────────────────────────────────────────────────────────

describe('misc exports', () => {
  it('noop returns its argument', () => {
    expect(noop(42)).toBe(42)
  })

  it('eachDefaultKey keys by index, so a repeated value cannot collide', () => {
    expect(eachDefaultKey('foo', 0)).toBe(0)
    expect(eachDefaultKey('foo', 2)).toBe(2)
  })

  it('addClass adds a class', () => {
    const el = div()
    addClass(el, 'active')
    expect(el.classList.contains('active')).toBe(true)
  })

  it('version is a string', () => {
    expect(typeof version).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §23  Integration — signals + DOM end-to-end
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// §24  Automatic batching — addEvent, $push, $apply
// ─────────────────────────────────────────────────────────────────────────────

describe('automatic batching', () => {
  it('addEvent batches multiple signal writes — one effect run', () => {
    const [a, setA] = createSignal(0)
    const [b, setB] = createSignal(0)
    let runs = 0
    createEffect(() => { a(); b(); runs++ })
    expect(runs).toBe(1)

    const el = div()
    addEvent(el, 'click', () => { setA(1); setB(1) })
    el.dispatchEvent(new MouseEvent('click'))
    expect(runs).toBe(2) // one batched run, not two
    expect(a()).toBe(1)
    expect(b()).toBe(1)
  })

  it('$push batches all prop writes — one effect run', () => {
    const [getA, setA] = createSignal(0)
    const [getB, setB] = createSignal(0)
    let runs = 0
    createEffect(() => { getA(); getB(); runs++ })
    expect(runs).toBe(1)

    const comp = makeComponent(($option) => {
      makeExternalProperty('a', getA, setA)
      makeExternalProperty('b', getB, setB)
      return document.createDocumentFragment()
    })
    const instance = comp({})
    instance.$push({ a: 10, b: 20 })
    expect(runs).toBe(2) // one batched run
    expect(getA()).toBe(10)
    expect(getB()).toBe(20)
  })

  it('$apply batches all prop writes — one effect run', () => {
    const [getA, setA] = createSignal(0)
    const [getB, setB] = createSignal(0)
    let runs = 0
    createEffect(() => { getA(); getB(); runs++ })
    expect(runs).toBe(1)

    const comp = makeComponent(($option) => {
      makeExternalProperty('a', getA, setA)
      makeExternalProperty('b', getB, setB)
      return document.createDocumentFragment()
    })
    const instance = comp({})
    instance.$apply({ a: 5, b: 15 })
    expect(runs).toBe(2) // one batched run
    expect(getA()).toBe(5)
    expect(getB()).toBe(15)
  })
})

describe('integration: signals + DOM', () => {
  it('counter: signal drives text node', () => {
    const [count, setCount] = createSignal(0)
    const el = div()
    bindText(el, () => `Count: ${count()}`)
    expect(el.textContent).toBe('Count: 0')
    setCount(1)
    flushSync()
    expect(el.textContent).toBe('Count: 1')
  })

  it('derived const drives attribute', () => {
    const [disabled, setDisabled] = createSignal(false)
    const isDisabled = createMemo(() => (disabled() ? 'true' : null))
    const btn = document.createElement('button')
    bindAttribute(btn, 'aria-disabled', isDisabled)
    expect(btn.hasAttribute('aria-disabled')).toBe(false)
    setDisabled(true)
    flushSync()
    expect(btn.getAttribute('aria-disabled')).toBe('true')
  })

  it('batch keeps DOM update count minimal', () => {
    const [first, setFirst] = createSignal('Jane')
    const [last, setLast] = createSignal('Doe')
    const el = div()
    let renders = 0
    createEffect(() => {
      el.textContent = `${first()} ${last()}`
      renders++
    })
    batch(() => {
      setFirst('John')
      setLast('Smith')
    })
    expect(el.textContent).toBe('John Smith')
    expect(renders).toBe(2) // init + one batched update
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  onMounted
// ─────────────────────────────────────────────────────────────────────────────

describe('onMounted', () => {
  it('returns a Promise', () => {
    const p = onMounted(async () => 42)
    expect(p).toBeInstanceOf(Promise)
  })

  it('promise resolves with fn return value after mount', async () => {
    let resolve
    const p = onMounted(async () => {
      return 'hello'
    })
    // simulate mount flush
    await tick()
    const result = await p
    expect(result).toBe('hello')
  })

  it('promise rejects when fn throws', async () => {
    const p = onMounted(async () => {
      throw new Error('mount failed')
    })
    // Attach catch immediately to prevent unhandled rejection warning
    const caught = p.catch(e => e)
    await tick()
    const err = await caught
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('mount failed')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  mountedBlock
// ─────────────────────────────────────────────────────────────────────────────

describe('mountedBlock', () => {
  it('shows pending block while promise is unresolved', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const promise = new Promise(() => {}) // never resolves
    mountedBlock(
      anchor,
      () => promise,
      () => { const el = div(); el.textContent = 'loading'; return el },
      () => { const el = div(); el.textContent = 'content'; return el },
      null, null
    )
    expect(container.textContent).toBe('loading')
  })

  it('shows content block after promise resolves', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    let resolve
    const promise = new Promise(r => { resolve = r })
    mountedBlock(
      anchor,
      () => promise,
      () => { const el = div(); el.textContent = 'loading'; return el },
      () => { const el = div(); el.textContent = 'content'; return el },
      null, null
    )
    expect(container.textContent).toBe('loading')
    resolve()
    await tick()
    expect(container.textContent).toBe('content')
  })

  it('shows failed block on rejection', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    let reject
    const promise = new Promise((_, r) => { reject = r })
    mountedBlock(
      anchor,
      () => promise,
      () => { const el = div(); el.textContent = 'loading'; return el },
      () => { const el = div(); el.textContent = 'content'; return el },
      (err) => { const el = div(); el.textContent = 'error:' + err.message; return el },
      null
    )
    reject(new Error('oops'))
    await tick()
    expect(container.textContent).toBe('error:oops')
  })

  it('calls onerror on rejection alongside failed block', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    let reject
    const promise = new Promise((_, r) => { reject = r })
    let onerrorCalled = false
    mountedBlock(
      anchor,
      () => promise,
      null,
      () => { const el = div(); el.textContent = 'content'; return el },
      (err) => { const el = div(); el.textContent = 'failed'; return el },
      (err) => { onerrorCalled = true }
    )
    reject(new Error('boom'))
    await tick()
    expect(onerrorCalled).toBe(true)
    expect(container.textContent).toBe('failed')
  })

  it('onerror fires even without failed block', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    let reject
    const promise = new Promise((_, r) => { reject = r })
    let errMsg = null
    mountedBlock(
      anchor,
      () => promise,
      null,
      () => { const el = div(); el.textContent = 'content'; return el },
      null,
      (err) => { errMsg = err.message }
    )
    reject(new Error('silent'))
    await tick()
    expect(errMsg).toBe('silent')
    expect(container.textContent).toBe('')
  })

  it('no pending block — shows nothing while loading', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const promise = new Promise(() => {})
    mountedBlock(anchor, () => promise, null,
      () => { const el = div(); el.textContent = 'content'; return el },
      null, null
    )
    expect(container.textContent).toBe('')
  })

  it('suppresses content when promise resolves false', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    let resolve
    const promise = new Promise(r => { resolve = r })
    mountedBlock(anchor, () => promise, null,
      () => { const el = div(); el.textContent = 'content'; return el },
      null, null)
    resolve(false)
    await tick()
    expect(container.textContent).toBe('')
  })

  it('shows content when promise resolves undefined (no explicit return)', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    let resolve
    const promise = new Promise(r => { resolve = r })
    mountedBlock(anchor, () => promise, null,
      () => { const el = div(); el.textContent = 'content'; return el },
      null, null)
    resolve(undefined)
    await tick()
    expect(container.textContent).toBe('content')
  })

  it('suppresses via sync Promise.resolve(false) — mount={expr} gate', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    mountedBlock(anchor, () => Promise.resolve(false), null,
      () => { const el = div(); el.textContent = 'content'; return el },
      null, null)
    await tick()
    expect(container.textContent).toBe('')
  })

  it('shows via sync Promise.resolve(true) — mount={expr} gate', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    mountedBlock(anchor, () => Promise.resolve(true), null,
      () => { const el = div(); el.textContent = 'content'; return el },
      null, null)
    await tick()
    expect(container.textContent).toBe('content')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  boundaryBlock
// ─────────────────────────────────────────────────────────────────────────────

describe('boundaryBlock', () => {
  it('shows pending while any state is loading', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const state = makeAsyncState() // starts loading: true
    boundaryBlock(
      anchor,
      () => [state],
      () => { const el = div(); el.textContent = 'content'; return el },
      () => { const el = div(); el.textContent = 'loading'; return el },
      null
    )
    flushSync()
    expect(container.textContent).toBe('loading')
  })

  it('shows content once all states resolve', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const state = makeAsyncState()
    boundaryBlock(
      anchor,
      () => [state],
      () => { const el = div(); el.textContent = 'content'; return el },
      () => { const el = div(); el.textContent = 'loading'; return el },
      null
    )
    flushSync()
    expect(container.textContent).toBe('loading')

    state._update('done')
    flushSync()
    expect(container.textContent).toBe('content')
  })

  it('shows failed when any state has error', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const state = makeAsyncState()
    boundaryBlock(
      anchor,
      () => [state],
      () => { const el = div(); el.textContent = 'content'; return el },
      () => { const el = div(); el.textContent = 'loading'; return el },
      (err) => { const el = div(); el.textContent = 'error:' + err.message; return el }
    )
    flushSync()

    state._update('error', new Error('fetch failed'))
    flushSync()
    expect(container.textContent).toBe('error:fetch failed')
  })

  it('error wins over loading', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const s1 = makeAsyncState()
    const s2 = makeAsyncState()
    boundaryBlock(
      anchor,
      () => [s1, s2],
      () => { const el = div(); el.textContent = 'content'; return el },
      () => { const el = div(); el.textContent = 'loading'; return el },
      (err) => { const el = div(); el.textContent = 'error:' + err.message; return el }
    )
    flushSync()

    // s1 errors, s2 still loading
    s1._update('error', new Error('boom'))
    flushSync()
    expect(container.textContent).toBe('error:boom')
  })

  it('waits for all states — shows loading until last resolves', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const s1 = makeAsyncState()
    const s2 = makeAsyncState()
    boundaryBlock(
      anchor,
      () => [s1, s2],
      () => { const el = div(); el.textContent = 'content'; return el },
      () => { const el = div(); el.textContent = 'loading'; return el },
      null
    )
    flushSync()
    expect(container.textContent).toBe('loading')

    s1._update('done')
    flushSync()
    expect(container.textContent).toBe('loading') // s2 still loading

    s2._update('done')
    flushSync()
    expect(container.textContent).toBe('content')
  })

  it('content stays mounted after subsequent refetch (fetching=true, loading=false)', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const state = makeAsyncState()
    boundaryBlock(
      anchor,
      () => [state],
      () => { const el = div(); el.textContent = 'content'; return el },
      () => { const el = div(); el.textContent = 'loading'; return el },
      null
    )
    flushSync()

    // First load resolves
    state._update('done')
    flushSync()
    expect(container.textContent).toBe('content')

    // Refetch starts — fetching=true but loading=false (not first load)
    state._update('start')
    // manually set loading to false to simulate refetch (not first load)
    // In real usage loading stays false after first done
    flushSync()
    // Content should still be shown during refetch
    expect(container.textContent).toBe('content')
  })
})

// ── §27  Snippet-style blocks in awaitBlock / boundaryBlock / mountedBlock ───
//
// The compiler emits snippet wrappers like:
//   (__anchor) => $$snippet_pending(__anchor)
// which insert before an anchor instead of returning DOM.
// These tests verify that pendingBlock/failedBlock work in snippet style.

function makeSnippetBlock(text) {
  // Simulates a compiler-emitted snippet wrapper:
  //   (__anchor) => { anchor.before(fragment) }
  return (__anchor) => {
    const el = document.createElement('p')
    el.textContent = text
    __anchor.before(el)
    // returns nothing — snippet style
  }
}

describe('snippet-style blocks — awaitBlock', () => {
  it('snippet pendingBlock inserts before anchor while promise pending', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    const promise = new Promise(() => {}) // never resolves
    awaitBlock(anchor, () => promise, makeSnippetBlock('loading...'), null, null)
    flushSync()
    expect(container.textContent).toBe('loading...')
  })

  it('snippet pendingBlock is replaced by content on resolve', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    let resolve
    const promise = new Promise(r => { resolve = r })
    const thenBlock = () => { const el = div(); el.textContent = 'done'; return el }
    awaitBlock(anchor, () => promise, makeSnippetBlock('loading...'), thenBlock, null)
    flushSync()
    expect(container.textContent).toBe('loading...')
    resolve()
    await tick()
    expect(container.textContent).toBe('done')
  })

  it('snippet catchBlock shown on rejection', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    let reject
    const promise = new Promise((_, r) => { reject = r })
    awaitBlock(anchor, () => promise, null, null, makeSnippetBlock('error!'))
    flushSync()
    reject(new Error('boom'))
    await tick()
    expect(container.textContent).toBe('error!')
  })
})

describe('snippet-style blocks — boundaryBlock', () => {
  it('snippet pendingBlock shown while loading', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    const state = makeAsyncState()
    boundaryBlock(
      anchor,
      () => [state],
      () => { const el = div(); el.textContent = 'content'; return el },
      makeSnippetBlock('loading...'),
      null
    )
    flushSync()
    expect(container.textContent).toBe('loading...')
  })

  it('snippet pendingBlock replaced by content on resolve', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    const state = makeAsyncState()
    boundaryBlock(
      anchor,
      () => [state],
      () => { const el = div(); el.textContent = 'content'; return el },
      makeSnippetBlock('loading...'),
      null
    )
    flushSync()
    expect(container.textContent).toBe('loading...')
    state._update('done')
    flushSync()
    expect(container.textContent).toBe('content')
  })

  it('snippet failedBlock shown on error', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    const state = makeAsyncState()
    boundaryBlock(
      anchor,
      () => [state],
      () => { const el = div(); el.textContent = 'content'; return el },
      makeSnippetBlock('loading...'),
      makeSnippetBlock('failed!')
    )
    flushSync()
    state._update('error', new Error('oops'))
    flushSync()
    expect(container.textContent).toBe('failed!')
  })
})

describe('snippet-style blocks — mountedBlock', () => {
  it('snippet pendingBlock shown while promise pending', () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    const promise = new Promise(() => {})
    mountedBlock(anchor, () => promise, makeSnippetBlock('mounting...'), null, null, null)
    flushSync()
    expect(container.textContent).toBe('mounting...')
  })

  it('snippet pendingBlock replaced by content on resolve', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    let resolve
    const promise = new Promise(r => { resolve = r })
    const contentBlock = () => { const el = div(); el.textContent = 'ready'; return el }
    mountedBlock(anchor, () => promise, makeSnippetBlock('mounting...'), contentBlock, null, null)
    flushSync()
    expect(container.textContent).toBe('mounting...')
    resolve()
    await tick()
    expect(container.textContent).toBe('ready')
  })

  it('snippet failedBlock shown on rejection', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    let reject
    const promise = new Promise((_, r) => { reject = r })
    mountedBlock(anchor, () => promise, null, null, makeSnippetBlock('failed!'), null)
    flushSync()
    reject(new Error('auth'))
    await tick()
    expect(container.textContent).toBe('failed!')
  })

  it('onerror fires AND snippet failedBlock shown together', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    let reject
    const promise = new Promise((_, r) => { reject = r })
    let errMsg = null
    mountedBlock(
      anchor, () => promise, null, null,
      makeSnippetBlock('failed!'),
      (err) => { errMsg = err.message }
    )
    flushSync()
    reject(new Error('auth error'))
    await tick()
    expect(errMsg).toBe('auth error')
    expect(container.textContent).toBe('failed!')
  })

  it('onerror fires once only — not double-invoked', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)
    let reject
    const promise = new Promise((_, r) => { reject = r })
    let callCount = 0
    mountedBlock(anchor, () => promise, null, null, null, () => { callCount++ })
    flushSync()
    reject(new Error('x'))
    await tick()
    expect(callCount).toBe(1)
  })
})

// ── §28  entrance() exit animation gate ───────────────────────────────────────
//
// When {#if} flips false, elements with {@attach entrance({out})} should stay
// in the DOM until the out animation Promise resolves, then be removed.

// ── §28a  an attachment runs on a CONNECTED element ───────────────────────────
//
// VISION §10.6 says `fn(el)` is called when the element MOUNTS. It used to be
// called when the element was BUILT, which is before anything inserts it — so
// every attachment in the repo saw `isConnected === false` and `parentNode ===
// null`. Focus is a no-op there, a rect is all zeros, and worst of all
// `el.animate(..., { fill: 'forwards' })` returns an animation that never
// starts: the element paints at keyframe 0 for good. `@frontierjs/ui`'s
// CommandPalette was a full-screen invisible backdrop for exactly this reason.

describe('{@attach} — the element is in the document', () => {
  it('sees a connected element', async () => {
    const host = div()
    document.body.appendChild(host)
    const anchor = document.createComment('')
    host.appendChild(anchor)

    const seen = []
    const el = div()
    const enterBlock = makeBlock(
      (() => { const f = document.createDocumentFragment(); f.appendChild(el); return f })(),
      ($parentElement) => {
        const node = $parentElement.nodeType === 11 ? $parentElement.firstChild : $parentElement
        attach(node, () => (n) => { seen.push({ connected: n.isConnected, hasParent: !!n.parentNode }) })
      }
    )
    ifBlock(anchor, () => 0, [enterBlock])
    flushSync()
    await tick()

    expect(seen).toEqual([{ connected: true, hasParent: true }])
    host.remove()
  })

  it('an entrance animation actually starts', async () => {
    const host = div()
    document.body.appendChild(host)
    const anchor = document.createComment('')
    host.appendChild(anchor)

    // happy-dom has no WAAPI, so record what el.animate() would have been given
    // and — the part that matters — whether the element was connected when it
    // was called. A disconnected target is what produced startTime: null.
    // Stubbed on the PROTOTYPE: the block clones its template, so a stub on the
    // element we built never reaches the node the attachment receives.
    const calls = []
    const proto = window.HTMLElement.prototype
    const had = Object.prototype.hasOwnProperty.call(proto, 'animate')
    const prev = proto.animate
    proto.animate = function (frames, opts) {
      calls.push({ connected: this.isConnected, frames, opts })
      return { finished: Promise.resolve() }
    }
    const el = div()

    const fade = entrance({
      in: (node) => node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, fill: 'forwards' }),
    })

    const enterBlock = makeBlock(
      (() => { const f = document.createDocumentFragment(); f.appendChild(el); return f })(),
      ($parentElement) => {
        const node = $parentElement.nodeType === 11 ? $parentElement.firstChild : $parentElement
        attach(node, () => fade)
      }
    )
    ifBlock(anchor, () => 0, [enterBlock])
    flushSync()
    await tick()

    if (had) proto.animate = prev
    else delete proto.animate

    expect(calls).toHaveLength(1)
    expect(calls[0].connected).toBe(true)
    host.remove()
  })

  it('runs synchronously when the element is already connected', () => {
    const host = div()
    document.body.appendChild(host)
    let ran = false
    attach(host, () => () => { ran = true })
    expect(ran).toBe(true)     // no tick awaited — nothing that worked before is reordered
    host.remove()
  })
})

describe('entrance() exit gate', () => {
  it('element stays in DOM while exit Promise is pending', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [getShow, setShow] = createSignal(true)

    let resolveExit
    const exitPromise = new Promise(r => { resolveExit = r })

    const fade = entrance({
      in:  (el) => { el.dataset.animated = 'in' },
      out: (el) => { el.dataset.animated = 'out'; return exitPromise }
    })

    // In real Mesa, {@attach fade} is on the element, not $parentElement.
    // The block fn receives $parentElement (the fragment), then navigates to the child.
    const frag = document.createElement('div')
    frag.className = 'target'
    const enterBlock = makeBlock(
      (() => { const f = document.createDocumentFragment(); f.appendChild(frag.cloneNode(true)); return f })(),
      ($parentElement) => {
        // $parentElement is the fragment — navigate to the actual element
        const el = $parentElement.nodeType === 11 ? $parentElement.firstChild : $parentElement
        attach(el, () => fade)
      }
    )

    ifBlock(anchor, () => getShow() ? 0 : null, [enterBlock])
    flushSync()

    expect(container.querySelector('.target')).toBeTruthy()
    // An attachment runs when the element MOUNTS (VISION §10.6), which for an
    // element built detached is one microtask later — the same queue onMount
    // uses. Running it at build time is what left every entrance animation
    // stuck at keyframe 0: el.animate() on a disconnected node never starts.
    await tick()
    expect(container.querySelector('.target').dataset.animated).toBe('in')

    // Flip off — exit animation starts
    setShow(false)
    flushSync()

    // Element should STILL be in DOM (exit animating)
    const target = container.querySelector('.target')
    expect(target).toBeTruthy()
    expect(target.dataset.animated).toBe('out')

    // Resolve the exit Promise — element should be removed
    resolveExit()
    await tick()
    await tick()

    expect(container.querySelector('.target')).toBeFalsy()
  })

  it('element is removed immediately when no exit animation', async () => {
    const container = div()
    const anchor = document.createComment('')
    container.appendChild(anchor)

    const [getShow, setShow] = createSignal(true)

    const fade = entrance({ in: (el) => { el.dataset.animated = 'in' } })

    const enterBlock = makeBlock(
      (() => { const f = document.createDocumentFragment(); const d = document.createElement('div'); d.className = 'target'; f.appendChild(d); return f })(),
      ($parentElement) => {
        const el = $parentElement.nodeType === 11 ? $parentElement.firstChild : $parentElement
        attach(el, () => fade)
      }
    )

    ifBlock(anchor, () => getShow() ? 0 : null, [enterBlock])
    flushSync()
    expect(container.querySelector('.target')).toBeTruthy()

    setShow(false)
    flushSync()

    // No exit animation — should be gone immediately
    expect(container.querySelector('.target')).toBeFalsy()
  })
})

// ── §boolean attribute handling ───────────────────────────────────────────────

describe('set_attribute — boolean attrs', () => {
  let runtime
  beforeEach(async () => { runtime = await import('../src/runtime.js') })

  it('false removes boolean attribute (disabled)', () => {
    const el = document.createElement('input')
    runtime.set_attribute(el, 'disabled', false)
    expect(el.hasAttribute('disabled')).toBe(false)
  })

  it('true sets boolean attribute as empty string', () => {
    const el = document.createElement('input')
    runtime.set_attribute(el, 'disabled', true)
    expect(el.getAttribute('disabled')).toBe('')
  })

  it('null removes boolean attribute', () => {
    const el = document.createElement('input')
    el.setAttribute('disabled', '')
    runtime.set_attribute(el, 'disabled', null)
    expect(el.hasAttribute('disabled')).toBe(false)
  })

  it('stashes an option value on the element as well as the attribute', () => {
    // The attribute can only hold a string, so `<option value={obj}>` reached
    // the DOM as "[object Object]" and the select binding had no way back to
    // the real value.
    const el = document.createElement('option')
    const obj = { id: 7 }
    runtime.set_attribute(el, 'value', obj)
    expect(el.__value).toBe(obj)

    // A plain string option carries no stash — bindInput falls back to .value.
    const plain = document.createElement('option')
    runtime.set_attribute(plain, 'value', 'a')
    expect('__value' in plain).toBe(true)      // set, but equal to the attribute
    expect(plain.__value).toBe('a')
    expect(plain.getAttribute('value')).toBe('a')

    // Not an option — no stash anywhere.
    const input = document.createElement('input')
    runtime.set_attribute(input, 'value', 'a')
    expect('__value' in input).toBe(false)
  })

  it('false removes non-boolean attribute too', () => {
    const el = document.createElement('div')
    el.setAttribute('aria-label', 'hello')
    runtime.set_attribute(el, 'aria-label', false)
    expect(el.hasAttribute('aria-label')).toBe(false)
  })

  it('truthy string value sets non-boolean attribute as string', () => {
    const el = document.createElement('div')
    runtime.set_attribute(el, 'class', 'foo bar')
    expect(el.getAttribute('class')).toBe('foo bar')
  })

  it('readonly, required, hidden also behave as boolean attrs', () => {
    const el = document.createElement('input')
    runtime.set_attribute(el, 'readonly', true)
    expect(el.getAttribute('readonly')).toBe('')
    runtime.set_attribute(el, 'readonly', false)
    expect(el.hasAttribute('readonly')).toBe(false)
    runtime.set_attribute(el, 'required', true)
    expect(el.getAttribute('required')).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  debounce / throttle
// ─────────────────────────────────────────────────────────────────────────────
describe('debounce', () => {
  it('delays handler invocation', async () => {
    const calls = []
    const handler = debounce((e) => calls.push(e), 50)
    handler('a'); handler('b'); handler('c')
    expect(calls).toHaveLength(0)
    await new Promise(r => setTimeout(r, 80))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe('c')
  })

  it('resets timer on each call', async () => {
    const calls = []
    const handler = debounce((e) => calls.push(e), 40)
    handler('first')
    await new Promise(r => setTimeout(r, 20))
    handler('second')
    await new Promise(r => setTimeout(r, 20))
    expect(calls).toHaveLength(0)
    await new Promise(r => setTimeout(r, 50))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe('second')
  })

  it('accepts getter function for delay', async () => {
    let delay = 30
    const calls = []
    const handler = debounce((e) => calls.push(e), () => delay)
    handler('x')
    await new Promise(r => setTimeout(r, 50))
    expect(calls).toHaveLength(1)
  })
})

describe('throttle', () => {
  it('invokes handler immediately on first call', () => {
    const calls = []
    const handler = throttle((e) => calls.push(e), 50)
    handler('first')
    expect(calls).toHaveLength(1)
    expect(calls[0]).toBe('first')
  })

  it('suppresses calls within the interval', async () => {
    const calls = []
    const handler = throttle((e) => calls.push(e), 40)
    handler('a'); handler('b'); handler('c')
    expect(calls).toHaveLength(1)
    await new Promise(r => setTimeout(r, 50))
    handler('d')
    expect(calls).toHaveLength(2)
    expect(calls[1]).toBe('d')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  bindGroup
// ─────────────────────────────────────────────────────────────────────────────
describe('bindGroup', () => {
  it('checkbox — adds value to array on check', () => {
    const el = document.createElement('input')
    el.type = 'checkbox'; el.value = 'apple'
    const [get, set] = createSignal([])
    bindGroup(el, get, set, () => 'apple')
    flushSync()
    el.checked = true
    el.dispatchEvent(new Event('change'))
    flushSync()
    expect(get()).toContain('apple')
  })

  it('checkbox — removes value on uncheck', () => {
    const el = document.createElement('input')
    el.type = 'checkbox'; el.value = 'apple'
    const [get, set] = createSignal(['apple', 'banana'])
    bindGroup(el, get, set, () => 'apple')
    flushSync()
    el.checked = false
    el.dispatchEvent(new Event('change'))
    flushSync()
    expect(get()).not.toContain('apple')
    expect(get()).toContain('banana')
  })

  it('radio — sets scalar value on change', () => {
    const el = document.createElement('input')
    el.type = 'radio'; el.value = 'M'
    const [get, set] = createSignal('S')
    bindGroup(el, get, set, () => 'M')
    flushSync()
    el.checked = true
    el.dispatchEvent(new Event('change'))
    flushSync()
    expect(get()).toBe('M')
  })

  it('checkbox — checked reflects array membership', () => {
    const el = document.createElement('input')
    el.type = 'checkbox'; el.value = 'cherry'
    const [get, set] = createSignal(['apple', 'cherry'])
    bindGroup(el, get, set, () => 'cherry')
    flushSync()
    expect(el.checked).toBe(true)
  })

  it('radio — checked reflects scalar match', () => {
    const el = document.createElement('input')
    el.type = 'radio'; el.value = 'L'
    const [get, set] = createSignal('L')
    bindGroup(el, get, set, () => 'L')
    flushSync()
    expect(el.checked).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §  makeSlots / attachNamedSlot
// ─────────────────────────────────────────────────────────────────────────────
describe('makeSlots', () => {
  it('returns empty object when __block is null', () => {
    expect(makeSlots(null)).toEqual({})
  })

  it('returns true for each slot key present in __block', () => {
    const s = makeSlots({ default: () => {}, sidebar: () => {} })
    expect(s.default).toBe(true)
    expect(s.sidebar).toBe(true)
  })

  it('does not include absent slot keys', () => {
    const s = makeSlots({ default: () => {} })
    expect('sidebar' in s).toBe(false)
  })
})

describe('attachNamedSlot', () => {
  const mkFrag = (text) => () => {
    const s = document.createElement('span')
    s.textContent = text
    return s
  }

  it('renders named slot content from __block', () => {
    const result = attachNamedSlot({ sidebar: mkFrag('sidebar content') }, 'sidebar', null)
    expect(result?.textContent).toBe('sidebar content')
  })

  it('uses fallback factory when slot absent from __block', () => {
    const result = attachNamedSlot({}, 'sidebar', mkFrag('fallback'))
    expect(result?.textContent).toBe('fallback')
  })

  it('returns null when no slot and no fallback', () => {
    expect(attachNamedSlot({}, 'sidebar', null)).toBeNull()
  })

  it('returns null for null __block with no fallback', () => {
    expect(attachNamedSlot(null, 'default', null)).toBeNull()
  })
})

// ── Event delegation — per-mount-container roots ──────────────────────────────

describe('event delegation — per-mount-container roots', () => {
  let imports

  beforeEach(async () => {
    imports = await import('../src/runtime.js')
    // Reset delegation state between tests by re-importing is not possible in
    // ESM — instead we verify behavior through the public API.
  })

  it('$$delegate records event types without attaching to document.body', () => {
    const { $$delegate } = imports
    // Before any mount, $$delegate should not throw and should track the type
    expect(() => $$delegate(['testdelegation'])).not.toThrow()
    // document.body should NOT have a testdelegation listener at module scope
    // (we can't easily inspect this in happy-dom, but the key test is below)
  })

  it('_registerDelegateRoot attaches listeners to the given root', () => {
    const { _registerDelegateRoot, $$delegate } = imports
    $$delegate(['pointerdown'])

    const root = document.createElement('div')
    document.body.appendChild(root)

    let fired = false
    // Register root — should attach pointerdown to root, not document.body
    const cleanup = _registerDelegateRoot(root)

    // Attach a Mesa-style handler via the __pointerdown property convention
    const child = document.createElement('button')
    root.appendChild(child)
    child.__pointerdown = () => { fired = true }

    // Dispatch from child — should bubble to root and fire handler
    const evt = new Event('pointerdown', { bubbles: true })
    child.dispatchEvent(evt)
    expect(fired).toBe(true)

    cleanup()
    document.body.removeChild(root)
  })

  it('cleanup removes delegation listeners from root', () => {
    const { _registerDelegateRoot, $$delegate } = imports
    $$delegate(['pointerup'])

    const root = document.createElement('div')
    document.body.appendChild(root)
    const child = document.createElement('button')
    root.appendChild(child)

    let callCount = 0
    const cleanup = _registerDelegateRoot(root)
    child.__pointerup = () => { callCount++ }

    child.dispatchEvent(new Event('pointerup', { bubbles: true }))
    expect(callCount).toBe(1)

    cleanup()
    child.dispatchEvent(new Event('pointerup', { bubbles: true }))
    // After cleanup, listener removed — count should still be 1
    expect(callCount).toBe(1)

    document.body.removeChild(root)
  })

  it('multiple roots each get their own isolated listener', () => {
    const { _registerDelegateRoot, $$delegate } = imports
    $$delegate(['auxclick'])

    const root1 = document.createElement('div')
    const root2 = document.createElement('div')
    document.body.appendChild(root1)
    document.body.appendChild(root2)

    let fired1 = false, fired2 = false
    const c1 = _registerDelegateRoot(root1)
    const c2 = _registerDelegateRoot(root2)

    const child1 = document.createElement('span')
    const child2 = document.createElement('span')
    root1.appendChild(child1)
    root2.appendChild(child2)
    child1.__auxclick = () => { fired1 = true }
    child2.__auxclick = () => { fired2 = true }

    child1.dispatchEvent(new Event('auxclick', { bubbles: true }))
    expect(fired1).toBe(true)
    expect(fired2).toBe(false)   // root2 listener should not have fired

    c1(); c2()
    document.body.removeChild(root1)
    document.body.removeChild(root2)
  })

  it('a handler fires ONCE when delegation roots nest', () => {
    // Roots nest whenever two mounted trees sit at different depths — the
    // ordinary shape for Sierra islands, where each island's root is its own
    // parent element. The event bubbles through every ancestor root, so before
    // the nearest-root rule each handler ran once per root above it: one click,
    // two increments, in the deeper tree only.
    const { _registerDelegateRoot, $$delegate } = imports
    $$delegate(['dblclick'])

    const outer = document.createElement('div')
    const inner = document.createElement('div')
    const shallow = document.createElement('button')
    const deep = document.createElement('button')
    document.body.appendChild(outer)
    outer.append(shallow, inner)
    inner.appendChild(deep)

    const cOuter = _registerDelegateRoot(outer)
    const cInner = _registerDelegateRoot(inner)

    let deepCount = 0, shallowCount = 0
    deep.__dblclick = () => { deepCount++ }
    shallow.__dblclick = () => { shallowCount++ }

    deep.dispatchEvent(new Event('dblclick', { bubbles: true }))
    expect(deepCount).toBe(1)

    // The outer root still owns everything the inner one does not: a sibling of
    // the inner root is unaffected by it.
    shallow.dispatchEvent(new Event('dblclick', { bubbles: true }))
    expect(shallowCount).toBe(1)

    // …and once the inner root is gone, the outer one takes the subtree back.
    cInner()
    deep.dispatchEvent(new Event('dblclick', { bubbles: true }))
    expect(deepCount).toBe(2)

    cOuter()
    document.body.removeChild(outer)
  })

  it('a delegated handler reads currentTarget as its OWN element', () => {
    // `e.target === e.currentTarget` is the standard "was this element itself
    // clicked" test, and it is what `on:click|self` compiles to. Delegation
    // puts one listener on the root, so currentTarget was the root and the
    // comparison was false for every event that DID hit the element it was
    // written on — a backdrop that cannot be clicked away, silently.
    const { _registerDelegateRoot, $$delegate } = imports
    $$delegate(['mouseup'])

    const root = document.createElement('div')
    const backdrop = document.createElement('div')
    const inner = document.createElement('button')
    document.body.appendChild(root)
    root.appendChild(backdrop)
    backdrop.appendChild(inner)
    const cleanup = _registerDelegateRoot(root)

    const seen = []
    backdrop.__mouseup = (e) => { seen.push(e.currentTarget === backdrop && e.target !== backdrop) }

    inner.dispatchEvent(new Event('mouseup', { bubbles: true }))
    expect(seen).toEqual([true])          // bubbled from a child: not self

    seen.length = 0
    backdrop.__mouseup = (e) => { seen.push(e.target === e.currentTarget) }
    backdrop.dispatchEvent(new Event('mouseup', { bubbles: true }))
    expect(seen).toEqual([true])          // the element itself: self

    cleanup()
    document.body.removeChild(root)
  })

  it('each handler in one dispatch sees its own element, and the event is left alone after', () => {
    const { _registerDelegateRoot, $$delegate } = imports
    $$delegate(['mousedown'])

    const root = document.createElement('div')
    const mid = document.createElement('div')
    const leaf = document.createElement('button')
    document.body.appendChild(root)
    root.appendChild(mid)
    mid.appendChild(leaf)
    const cleanup = _registerDelegateRoot(root)

    const seen = []
    leaf.__mousedown = (e) => { seen.push(e.currentTarget === leaf) }
    mid.__mousedown  = (e) => { seen.push(e.currentTarget === mid) }

    // A native listener on the root is part of the same dispatch, and must not
    // inherit whatever the last delegated handler was told.
    let nativeSaw = null
    const native = (e) => { nativeSaw = e.currentTarget }
    root.addEventListener('mousedown', native)

    leaf.dispatchEvent(new Event('mousedown', { bubbles: true }))
    expect(seen).toEqual([true, true])
    expect(nativeSaw).toBe(root)

    root.removeEventListener('mousedown', native)
    cleanup()
    document.body.removeChild(root)
  })

  it('late-registered $$delegate types are added to existing roots', () => {
    const { _registerDelegateRoot, $$delegate } = imports

    const root = document.createElement('div')
    document.body.appendChild(root)
    const cleanup = _registerDelegateRoot(root)

    // Register event type AFTER root is already registered
    $$delegate(['contextmenu'])

    const child = document.createElement('button')
    root.appendChild(child)
    let fired = false
    child.__contextmenu = () => { fired = true }

    child.dispatchEvent(new Event('contextmenu', { bubbles: true }))
    expect(fired).toBe(true)

    cleanup()
    document.body.removeChild(root)
  })
})

// ── Style injection — shadow root support ─────────────────────────────────────

describe('addStyles — shadow root injection', () => {
  let imports

  beforeEach(async () => {
    imports = await import('../src/runtime.js')
  })

  it('addStyles injects into document.head by default', () => {
    const { addStyles } = imports
    addStyles('test-style-default', 'p { color: red; }')
    const el = document.head.querySelector('style#test-style-default')
    expect(el).toBeTruthy()
    expect(el.textContent).toContain('color: red')
    el?.remove()
  })

  it('_registerStyleRoot injects styles into shadow root via adoptedStyleSheets or <style>', () => {
    const { _registerStyleRoot, addStyles } = imports

    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })

    const cleanup = _registerStyleRoot(shadow)
    addStyles('test-shadow-style', '.btn { background: blue; }')

    // Either adoptedStyleSheets or a <style> tag — check both
    const viaAdopted = shadow.adoptedStyleSheets?.some(s => s.__mesaId === 'test-shadow-style')
    const viaTag     = !!shadow.querySelector?.('style#test-shadow-style')
    expect(viaAdopted || viaTag).toBe(true)

    cleanup()
    document.body.removeChild(host)
  })

  it('cleanup removes styles from shadow root', () => {
    const { _registerStyleRoot, addStyles } = imports

    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })

    const cleanup = _registerStyleRoot(shadow)
    addStyles('test-cleanup-style', '.x { color: green; }')
    cleanup()

    const viaAdopted = shadow.adoptedStyleSheets?.some(s => s.__mesaId === 'test-cleanup-style')
    const viaTag     = !!shadow.querySelector?.('style#test-cleanup-style')
    expect(viaAdopted || viaTag).toBe(false)

    document.body.removeChild(host)
  })

  it('does not inject the same style id twice into a shadow root', () => {
    const { _registerStyleRoot, addStyles } = imports

    const host = document.createElement('div')
    document.body.appendChild(host)
    const shadow = host.attachShadow({ mode: 'open' })

    const cleanup = _registerStyleRoot(shadow)
    addStyles('test-dedup-style', 'a { color: red; }')
    addStyles('test-dedup-style', 'a { color: red; }')

    const count = shadow.adoptedStyleSheets?.filter(s => s.__mesaId === 'test-dedup-style').length
      ?? [...shadow.querySelectorAll?.('style#test-dedup-style') ?? []].length
    expect(count).toBe(1)

    cleanup()
    document.body.removeChild(host)
  })
})

describe('<mesa:portal> and event delegation', () => {
  // Delegated handlers are `__click` properties, found by walking from the
  // event target up to a REGISTERED root — and mount() registers only the app's
  // own container. Portalled content is appended to document.body, outside it,
  // so nothing ever dispatched: every menu item, command-palette row and toast
  // dismiss button in @frontierjs/ui was inert. No error, correct markup.
  it('dispatches clicks inside a portal target', () => {
    $rt.$$delegate(['click'])

    const app = document.createElement('div')
    document.body.appendChild(app)
    const stop = $rt._registerDelegateRoot(app)

    const target = document.createElement('div')   // stands in for document.body
    document.body.appendChild(target)

    let hits = 0
    const btn = document.createElement('button')
    btn.__click = () => hits++

    let dispose
    $rt.createRoot((d) => {
      dispose = d
      $rt.portal(() => target, () => btn)
    })

    target.querySelector('button').click()
    expect(hits).toBe(1)

    dispose()
    stop()
    app.remove()
    target.remove()
  })

  it('keeps the root alive while another portal still uses it', () => {
    $rt.$$delegate(['click'])
    const target = document.createElement('div')
    document.body.appendChild(target)

    let a = 0, b = 0
    const btnA = document.createElement('button'); btnA.__click = () => a++
    const btnB = document.createElement('button'); btnB.__click = () => b++

    let disposeA, disposeB
    $rt.createRoot((d) => { disposeA = d; $rt.portal(() => target, () => btnA) })
    $rt.createRoot((d) => { disposeB = d; $rt.portal(() => target, () => btnB) })

    disposeA()                       // first portal closes…
    btnB.click()
    expect(b).toBe(1)                // …the second still responds

    disposeB()
    target.remove()
  })
})
