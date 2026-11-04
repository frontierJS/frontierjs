/*
 * engine-count.mjs — count the statements a workload executes, at the engine.
 *
 * `$tapQuery` fires once per ORM verb (and per include), not per statement: the
 * `@sequence` counter upsert, the trail's writes and BEGIN/COMMIT never reach
 * it, so a tap-based count under-reports exactly the declarations a bench is
 * pricing (FJS-3822). Wrapping `prepare`/`query` on every connection the engine
 * opens sees all of them, read or write, and trusts nothing to report itself.
 * The wrapper is installed before a client opens, because a statement is cached
 * after its first prepare and one prepared earlier is never counted.
 *
 *   const counter = installEngineCounter()
 *   const n = await counter.during(async () => { ... })   // statements executed
 */
import { setEngine }  from '../src/core/engine.js'
import bunSqlite      from '../src/engines/bun-sqlite.js'

const EXEC = ['all', 'get', 'run', 'values', 'iterate']

export function installEngineCounter() {
  let counting = false
  let count    = 0
  // `query()` answers the SAME cached statement on every call, so wrapping it
  // per call stacks a counter per call and its Nth run counts N times — a
  // statement run once per write read as O(size) per write (FJS-3963).
  const wrapped = new WeakSet()

  const wrap = (st) => {
    if (!st || wrapped.has(st)) return st
    wrapped.add(st)
    for (const m of EXEC) {
      const o = st[m]
      if (typeof o !== 'function') continue
      st[m] = function (...a) { if (counting) count++; return o.apply(this, a) }
    }
    return st
  }

  setEngine(Object.assign(Object.create(bunSqlite), {
    name: 'bun:sqlite (counting)',
    open(path, options) {
      const raw = bunSqlite.open(path, options)
      for (const m of ['prepare', 'query']) {
        const orig = raw[m]
        raw[m] = function (sql, ...r) { return wrap(orig.call(this, sql, ...r)) }
      }
      // A connection's own `run` executes without a prepare the wrapper sees.
      const run = raw.run
      if (typeof run === 'function') raw.run = function (...a) { if (counting) count++; return run.apply(this, a) }
      return raw
    },
  }))

  return {
    /** Statements `fn` executed, counted from its first call to its return. */
    async during(fn) {
      count = 0; counting = true
      try { await fn() } finally { counting = false }
      return count
    },
  }
}
