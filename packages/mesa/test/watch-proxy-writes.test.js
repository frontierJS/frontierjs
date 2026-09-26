/**
 * Two ways a write through the watch proxy went unreported (`FJS-884`).
 *
 * A symbol-keyed write and a symbol `delete` fired NOTHING — not even the
 * whole-object watch, which the same write with a string key wakes. A symbol
 * cannot be a watch segment and the get trap never subscribes to one, so it is
 * not a change at a PATH; it is still a change to the object.
 *
 * And a write the target refuses — `Object.freeze` is the ordinary cause — came
 * back as the native `Cannot assign to read only property 'b' of object
 * '#<Object>'`, which on a store of any size tells the reader that some `b`
 * somewhere is read-only.
 */
import { describe, it, expect } from 'vitest'
import { watchProxy, watchPath, createEffect, flushSync, createRoot } from '../src/runtime.js'

const TAG = Symbol('tag')

/** A store with the whole-object watch declared, and a count of its firings. */
function whole(raw) {
  const p = watchProxy(raw)
  const [read] = watchPath(p, '')
  let runs = 0
  createEffect(() => { read(); runs++ })
  flushSync()
  return { p, hits: () => runs, settle: () => flushSync() }
}

describe('a symbol-keyed change reaches the whole-object watch', () => {
  it('a write fires it, as a string write does', () => {
    createRoot(() => {
      const w = whole({ a: 1 })
      const before = w.hits()
      w.p[TAG] = 'x'
      w.settle()
      expect(w.hits()).toBeGreaterThan(before)
      expect(w.p[TAG]).toBe('x')
    })
  })

  it('a delete fires it too', () => {
    createRoot(() => {
      const w = whole({ a: 1 })
      w.p[TAG] = 'x'
      w.settle()
      const before = w.hits()
      delete w.p[TAG]
      w.settle()
      expect(w.hits()).toBeGreaterThan(before)
      expect(TAG in w.p).toBe(false)
    })
  })

  it('deleting a symbol that was never there fires nothing', () => {
    createRoot(() => {
      const w = whole({ a: 1 })
      const before = w.hits()
      delete w.p[TAG]
      w.settle()
      expect(w.hits()).toBe(before)
    })
  })

  it('the string forms still behave — the controls', () => {
    createRoot(() => {
      const w = whole({ a: 1 })
      let before = w.hits()
      w.p.a = 2
      w.settle()
      expect(w.hits()).toBeGreaterThan(before)

      before = w.hits()
      w.p.b = 3
      w.settle()
      expect(w.hits()).toBeGreaterThan(before)

      before = w.hits()
      delete w.p.b
      w.settle()
      expect(w.hits()).toBeGreaterThan(before)
    })
  })

  it('a symbol READ still subscribes to nothing', () => {
    // Unchanged on purpose: `Symbol.iterator` and friends are protocol lookups,
    // and subscribing to them would make every spread a dependency.
    createRoot(() => {
      const w = whole({ a: 1 })
      const before = w.hits()
      void w.p[Symbol.iterator]
      w.settle()
      expect(w.hits()).toBe(before)
    })
  })
})

describe('a write the target refuses', () => {
  const failing = (fn) => {
    try { fn(); return null } catch (e) { return e }
  }

  it('names the path and says the object is frozen', () => {
    createRoot(() => {
      const p = watchProxy({ settings: { theme: Object.freeze({ name: 'dark' }) } })
      const e = failing(() => { p.settings.theme.name = 'light' })
      expect(e).toBeInstanceOf(TypeError)
      expect(e.message).toContain('settings.theme.name')
      expect(e.message).toContain('frozen')
    })
  })

  it('keeps the original as the cause', () => {
    createRoot(() => {
      const p = watchProxy({ inner: Object.freeze({ b: 1 }) })
      const e = failing(() => { p.inner.b = 2 })
      expect(e.cause).toBeInstanceOf(TypeError)
      expect(e.cause.message).toContain('read only')
    })
  })

  it('an ordinary write is untouched — the control', () => {
    createRoot(() => {
      const p = watchProxy({ inner: { b: 1 } })
      expect(failing(() => { p.inner.b = 2 })).toBeNull()
      expect(p.inner.b).toBe(2)
    })
  })
})

/**
 * A read through a frozen parent (`FJS-1337`).
 *
 * A Proxy's get trap must return a non-writable, non-configurable property's
 * own value, so wrapping the object it held threw a TypeError on the READ —
 * `$: config` over `Object.freeze(config)` failed at `config.tax.rate`.
 */
import { vi } from 'vitest'

describe('a read through a frozen parent', () => {
  it('reads a nested value without throwing', () => {
    createRoot(() => {
      const p = watchProxy(Object.freeze({ tax: Object.freeze({ rate: 0.2 }) }))
      expect(p.tax.rate).toBe(0.2)
    })
  })

  it('reads through a watched path', () => {
    createRoot(() => {
      const cfg = Object.freeze({ tax: Object.freeze({ rate: 0.2 }) })
      const [read] = watchPath(cfg, 'tax.rate')
      const p = watchProxy(cfg)
      let seen
      createEffect(() => { read(); seen = p.tax.rate })
      flushSync()
      expect(seen).toBe(0.2)
    })
  })

  it('a locked property defined on an unfrozen object reads too', () => {
    createRoot(() => {
      const raw = {}
      Object.defineProperty(raw, 'k', { value: Object.freeze({ v: 1 }), writable: false, configurable: false })
      expect(watchProxy(raw).k.v).toBe(1)
    })
  })

  it('warns once when the value under a frozen parent is itself mutable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      createRoot(() => {
        const p = watchProxy(Object.freeze({ inner: { b: 1 } }))
        p.inner; p.inner
      })
      const hits = warn.mock.calls.filter(c => String(c[0]).includes('inner'))
      expect(hits).toHaveLength(1)
    } finally { warn.mockRestore() }
  })

  it('a writable property holding a frozen value is still wrapped — the control', () => {
    createRoot(() => {
      const inner = Object.freeze({ b: 1 })
      const p = watchProxy({ inner })
      expect(p.inner).not.toBe(inner)
      expect(p.inner.b).toBe(1)
    })
  })

  it('the locked value is handed back as itself', () => {
    createRoot(() => {
      const tax = Object.freeze({ rate: 0.2 })
      expect(watchProxy(Object.freeze({ tax })).tax).toBe(tax)
    })
  })
})

/**
 * A write from inside a derivation (`FJS-884`).
 *
 * A memo is lazy: it stops recomputing the moment nothing reads it, and a
 * derivation written for its side effect stops with it — silently. Warned
 * rather than refused, because a write to the memo's OWN dependency is a
 * handled case here that Svelte's outright ban would contradict.
 */
import { createMemo, resetDerivedWriteWarnings } from '../src/runtime.js'

describe('a write from inside a derivation', () => {
  const warnings = (fn) => {
    resetDerivedWriteWarnings()
    const seen = []
    const real = console.warn
    console.warn = (...a) => seen.push(a.join(' '))
    try { fn() } finally { console.warn = real }
    return seen.filter((w) => w.includes('[Mesa]'))
  }

  it('is named, with the reason it will stop working', () => {
    createRoot(() => {
      const p = watchProxy({ n: 1, log: 0 })
      const w = warnings(() => { createMemo(() => { p.log = p.n * 2; return p.n })() })
      expect(w.length).toBe(1)
      expect(w[0]).toContain('log')
      expect(w[0]).toContain('lazy')
      expect(p.log).toBe(2)          // it is a warning, not a refusal
    })
  })

  it('once per path, because a derivation reruns', () => {
    createRoot(() => {
      const p = watchProxy({ n: 1, log: 0 })
      const w = warnings(() => {
        const m = createMemo(() => { p.log = p.n * 2; return p.n })
        m(); p.n = 2; m(); p.n = 3; m()
      })
      expect(w.length).toBe(1)
    })
  })

  it('a write from an EFFECT says nothing — the control', () => {
    createRoot(() => {
      const p = watchProxy({ n: 1, log: 0 })
      const w = warnings(() => {
        createEffect(() => { p.log = p.n * 2 })
        flushSync()
      })
      expect(w).toEqual([])
      expect(p.log).toBe(2)
    })
  })

  it('an ordinary write outside anything says nothing', () => {
    createRoot(() => {
      const p = watchProxy({ n: 1 })
      expect(warnings(() => { p.n = 5 })).toEqual([])
    })
  })
})

/**
 * A watch over a primitive (`FJS-1338`).
 *
 * The compiler cannot tell `import { count }` from `import { store }`, so
 * `$: count` over an imported number reached `watchPath` with a number, whose
 * registry is a WeakMap: it threw `WeakMap keys must be objects` at mount,
 * naming neither the watch nor its line. RULE 44 says an imported primitive is
 * a constant, so the watch can never fire; it warns by name and does nothing.
 */
import { compileSource } from '../src/compiler.js'

describe('a watch over a primitive', () => {
  const warned = (fn) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try { fn(); return warn.mock.calls.map(c => String(c[0])) } finally { warn.mockRestore() }
  }

  it('does not throw, and names the watch', () => {
    const msgs = warned(() => createRoot(() => {
      const [read] = watchPath(40, '', 'statePrimitive')
      expect(read()).toBeUndefined()
    }))
    const hit = msgs.filter(m => m.includes('$: statePrimitive'))
    expect(hit).toHaveLength(1)
    expect(hit[0]).toContain('number')
  })

  it('names null, which a store left unset at mount is', () => {
    const msgs = warned(() => createRoot(() => { watchPath(null, 'name', 'user') }))
    expect(msgs.some(m => m.includes('$: user.name') && m.includes('null'))).toBe(true)
  })

  it('warns once per watch, not once per mount', () => {
    const msgs = warned(() => createRoot(() => {
      watchPath(7, '', 'mountedTwice')
      watchPath(7, '', 'mountedTwice')
    }))
    expect(msgs.filter(m => m.includes('mountedTwice'))).toHaveLength(1)
  })

  it('the compiler passes the watched name', async () => {
    const { result: js } = await compileSource(`<script>
  import { statePrimitive, store } from './x.js'
  $: statePrimitive
  $: store.count
</script>
<p>{statePrimitive} {store.count}</p>`, { filename: 'P.mesa' })
    expect(js).toContain(`watchPath(statePrimitive, '', 'statePrimitive')`)
    expect(js).toContain(`watchPath(store, 'count', 'store')`)
  })

  it('an object is watched as before — the control', () => {
    const msgs = warned(() => createRoot(() => {
      const [read] = watchPath({ n: 1 }, 'n', 'obj')
      expect(typeof read).toBe('function')
    }))
    expect(msgs.filter(m => m.includes('obj'))).toEqual([])
  })
})
