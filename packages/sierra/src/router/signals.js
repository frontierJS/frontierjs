/**
 * router/signals.js — minimal reactive signal store for the router
 *
 * The router needs reactive signals for params, activeRoute, pendingRoute etc.
 * BUT the router module itself cannot import from @frontierjs/mesa/runtime — that would
 * create a circular dependency (Mesa compiles components that import the router).
 *
 * Instead, Sierra uses a simple pub/sub signal implementation here.
 * When used inside a Mesa component, the component's reactive system
 * will subscribe to these via the normal import mechanism.
 *
 * Mesa signals imported from sierra/router are plain JS objects with
 * a .value property and .subscribe() method — Mesa's compiler handles
 * the reactivity wiring when it sees them used in templates.
 *
 * NOTE: This is the router's own signal implementation.
 * Mesa's @frontierjs/mesa/runtime signals are separate.
 * The bridge between the two happens in the Mesa Vite plugin which
 * wraps these as Mesa-compatible signals at compile time.
 */

/**
 * Create a reactive signal.
 *
 * @template T
 * @param {T} initial
 * @returns {{ get(): T, set(v: T): void, subscribe(fn: (v: T) => void): () => void }}
 */
export function signal(initial) {
  let value = initial
  const subscribers = new Set()

  return {
    get() {
      return value
    },
    set(newValue) {
      if (newValue === value) return
      value = newValue
      for (const fn of subscribers) {
        fn(value)
      }
    },
    subscribe(fn) {
      subscribers.add(fn)
      fn(value)  // immediate call with current value
      return () => subscribers.delete(fn)
    },
    // Allow direct read via .value for convenience
    get value() {
      return value
    },
  }
}

/**
 * Create a derived signal — recomputes whenever any source signal changes.
 *
 * @template T
 * @param {Array<ReturnType<typeof signal>>} sources
 * @param {(...values: any[]) => T} compute
 */
export function derived(sources, compute) {
  const getValues = () => sources.map(s => s.get())
  const result = signal(compute(...getValues()))

  for (const source of sources) {
    source.subscribe(() => {
      result.set(compute(...getValues()))
    })
  }

  return {
    get: result.get.bind(result),
    subscribe: result.subscribe.bind(result),
    get value() { return result.get() },
  }
}
