// ============================================================
// Conduit — observer guard
// The one place an observer is called. A throw or a rejection is
// caught here, since an observer receives and cannot act.
// ============================================================

/**
 * A broken observer fails on every request, so printing its stack each time
 * buries the log in one line repeated per call. The first failure of a name
 * prints the whole error; later ones print its message.
 */
export function createObserverGuard(): (name: string, fn: () => unknown) => void {
  const reported = new Set<string>()

  function report(name: string, verb: 'threw' | 'rejected', err: unknown): void {
    if (!reported.has(name)) {
      reported.add(name)
      console.error(`[conduit] observer '${name}' ${verb}:`, err)
      return
    }
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[conduit] observer '${name}' ${verb} again: ${message}`)
  }

  // Declared `=> void` at the type level so `(req) => arr.push(req)` stays
  // legal, but an async observer really does return a promise at runtime, and
  // it is never awaited: its latency must not join every request.
  return (name, fn) => {
    try {
      const result = fn()
      if (result instanceof Promise) result.catch(err => report(name, 'rejected', err))
    } catch (err) {
      report(name, 'threw', err)
    }
  }
}
