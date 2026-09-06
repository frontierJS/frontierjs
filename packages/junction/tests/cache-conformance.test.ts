// cache-conformance.test.ts
// One set of assertions, run against BOTH drivers.
//
// The finding this file answers is not any single defect: it is that eleven
// behaviors differed between the memory driver and the SQLite one and nothing
// anywhere said so, so swapping the driver — which is the whole reason there
// is an interface — changed answers (`FJS-898`). A test per driver cannot see
// that by construction; only one body run twice can.
//
// Every refusal below is paired with the acceptance of a value one step away,
// because a codec that refused everything would satisfy any test that only
// asked about the refusal (`FJS-351`).

import { describe, it, expect } from 'bun:test'
import { createMemoryCache, createSqliteCache, CacheValueError, type ICache } from '../src/cache/index.ts'

const DRIVERS: Array<[string, (maxSize?: number) => ICache]> = [
  ['memory', (maxSize) => createMemoryCache({ defaultTtl: '1 hour', maxSize: maxSize ?? 1000 })],
  ['sqlite', ()        => createSqliteCache({ defaultTtl: '1 hour' })],
]

for (const [driver, make] of DRIVERS) {
  describe(`cache contract — ${driver}`, () => {

    // ── a value is isolated from the caller ──────────────────────────────

    it('a mutation after set() does not reach the cache', () => {
      const c = make()
      const row = { n: 1 }
      c.set('k', row)
      row.n = 99
      expect(c.get<unknown>('k')).toEqual({ n: 1 })
      c.destroy()
    })

    it('mutating what get() answered does not reach the cache', () => {
      const c = make()
      c.set('k', { n: 1 })
      const first = c.get<{ n: number }>('k')!
      first.n = 99
      expect(c.get<unknown>('k')).toEqual({ n: 1 })
      c.destroy()
    })

    it('two reads answer two objects', () => {
      const c = make()
      c.set('k', { n: 1 })
      expect(c.get<unknown>('k')).not.toBe(c.get('k'))
      c.destroy()
    })

    // ── what may be stored ───────────────────────────────────────────────

    it('round-trips everything JSON carries', () => {
      const c = make()
      const value = { s: 'x', n: 1.5, b: false, nil: null, arr: [1, { deep: true }], o: { k: 'v' } }
      c.set('k', value)
      expect(c.get<unknown>('k')).toEqual(value)
      c.destroy()
    })

    // Each refusal names the value it would have lost, and sits beside the
    // representable form the advice points at.
    const REFUSED: Array<[string, unknown, unknown]> = [
      ['a Date',   new Date('2020-01-01T00:00:00Z'), '2020-01-01T00:00:00.000Z'],
      ['a Map',    new Map([['a', 1]]),              { a: 1 }],
      ['a Set',    new Set([1, 2]),                  [1, 2]],
      ['a RegExp', /x/g,                             'x'],
      ['a BigInt', 10n,                              '10'],
      ['NaN',      NaN,                              0],
      ['Infinity', Infinity,                         1e308],
    ]

    for (const [kind, bad, good] of REFUSED) {
      it(`refuses ${kind} by name, and accepts what the advice names`, () => {
        const c = make()
        expect(() => c.set('k', bad)).toThrow(CacheValueError)
        expect(() => c.set('k', bad)).toThrow(kind)
        c.set('k', good)
        expect(c.get<unknown>('k')).toEqual(good)
        c.destroy()
      })

      it(`refuses ${kind} NESTED, not only at the top`, () => {
        const c = make()
        expect(() => c.set('k', { rows: [{ at: bad }] })).toThrow(CacheValueError)
        c.set('k', { rows: [{ at: good }] })
        expect(c.get<unknown>('k')).toEqual({ rows: [{ at: good }] })
        c.destroy()
      })
    }

    it('refuses undefined, because get() answers undefined for a miss', () => {
      const c = make()
      expect(() => c.set('k', undefined)).toThrow(CacheValueError)
      c.set('k', null)                       // null is a value and survives
      expect(c.get<unknown>('k')).toBeNull()
      expect(c.has('k')).toBe(true)
      c.destroy()
    })

    it('refuses a function', () => {
      const c = make()
      expect(() => c.set('k', () => 1)).toThrow('a function')
      c.destroy()
    })

    it('a refused set leaves the previous value in place', () => {
      const c = make()
      c.set('k', { n: 1 })
      expect(() => c.set('k', { at: new Date() })).toThrow(CacheValueError)
      expect(c.get<unknown>('k')).toEqual({ n: 1 })
      c.destroy()
    })

    it('the refusal names the key', () => {
      const c = make()
      expect(() => c.set('orders:find:42', 10n)).toThrow('orders:find:42')
      c.destroy()
    })

    // ── clear ────────────────────────────────────────────────────────────

    it('clear() answers how many it removed', () => {
      const c = make()
      c.set('a', 1); c.set('b', 2); c.set('c', 3)
      expect(c.clear()).toBe(3)
      expect(c.size()).toBe(0)
      expect(c.clear()).toBe(0)
      c.destroy()
    })

    it('clear(string) is a PREFIX match, not a substring one', () => {
      const c = make()
      c.set('user:1', 1)
      c.set('user:2', 2)
      c.set('tenant:user:3', 3)      // contains "user:" and is not under it
      expect(c.clear('user:')).toBe(2)
      expect(c.get<unknown>('tenant:user:3')).toBe(3)
      c.destroy()
    })

    it('clear(string) does not read a LIKE wildcard out of the caller', () => {
      const c = make()
      c.set('a%b:1', 1)
      c.set('axb:1', 2)
      expect(c.clear('a%b')).toBe(1)
      expect(c.get<unknown>('axb:1')).toBe(2)
      c.destroy()
    })

    it('clear(RegExp) tests the whole key', () => {
      const c = make()
      c.set('user:1', 1); c.set('post:1', 2)
      expect(c.clear(/^user:/)).toBe(1)
      expect(c.get<unknown>('post:1')).toBe(2)
      c.destroy()
    })

    // ── stats and size ───────────────────────────────────────────────────

    it('stats().size agrees with size()', () => {
      const c = make()
      c.set('a', 1); c.set('b', 2)
      c.remove('a')
      expect(c.stats().size).toBe(c.size())
      expect(c.size()).toBe(1)
      c.destroy()
    })

    it('counts hits, misses and sets', () => {
      const c = make()
      c.set('k', 1)
      c.get('k'); c.get('nope')
      const s = c.stats()
      expect([s.hits, s.misses, s.sets]).toEqual([1, 1, 1])
      c.destroy()
    })

    // ── ttl ──────────────────────────────────────────────────────────────

    it('a value is gone once its ttl has passed', async () => {
      const c = make()
      c.set('k', 1, '1ms')
      await new Promise(r => setTimeout(r, 15))
      expect(c.get<unknown>('k')).toBeUndefined()
      expect(c.has('k')).toBe(false)
      c.destroy()
    })

    // ── getOrSet ─────────────────────────────────────────────────────────

    it('getOrSet runs the factory once and caches the answer', async () => {
      const c = make()
      let runs = 0
      const factory = async () => { runs++; return { n: 7 } }
      expect(await c.getOrSet('k', factory)).toEqual({ n: 7 })
      expect(await c.getOrSet('k', factory)).toEqual({ n: 7 })
      expect(runs).toBe(1)
      c.destroy()
    })

    it('getOrSet runs the factory ONCE for callers that arrive together', async () => {
      const c = make()
      let runs = 0
      const factory = async () => {
        runs++
        await new Promise(r => setTimeout(r, 20))
        return { n: runs }
      }
      const all = await Promise.all(Array.from({ length: 20 }, () => c.getOrSet('k', factory)))
      expect(runs).toBe(1)
      for (const v of all) expect(v).toEqual({ n: 1 })
      c.destroy()
    })

    it('getOrSet does not cache a rejection, and the next caller retries', async () => {
      const c = make()
      let runs = 0
      const factory = async () => {
        runs++
        if (runs === 1) throw new Error('boom')
        return 'ok'
      }
      await expect(c.getOrSet('k', factory)).rejects.toThrow('boom')
      expect(c.has('k')).toBe(false)
      expect(await c.getOrSet('k', factory)).toBe('ok')
      expect(runs).toBe(2)
      c.destroy()
    })

    it('a rejection reaches every caller that was waiting on it', async () => {
      const c = make()
      const factory = async () => { await new Promise(r => setTimeout(r, 10)); throw new Error('boom') }
      const results = await Promise.allSettled([c.getOrSet('k', factory), c.getOrSet('k', factory)])
      expect(results.map(r => r.status)).toEqual(['rejected', 'rejected'])
      c.destroy()
    })

    it('getOrSet refuses a value the cache cannot hold', async () => {
      const c = make()
      await expect(c.getOrSet('k', () => new Date())).rejects.toThrow(CacheValueError)
      c.destroy()
    })

    it('a factory throwing synchronously rejects rather than throwing', async () => {
      const c = make()
      await expect(c.getOrSet('k', () => { throw new Error('sync') })).rejects.toThrow('sync')
      c.destroy()
    })
  })
}

// ─── Bounded driver ───────────────────────────────────────────────────────
// Only the memory driver declares maxSize, so this half is its own. The
// SQLite driver is bounded by TTL and its GC sweep and offers no maxSize
// option, so there is nothing a caller can ask for that goes unanswered.

describe('cache contract — eviction (memory)', () => {

  it('evicts the least recently USED, not the oldest', () => {
    const c = createMemoryCache({ defaultTtl: '1 hour', maxSize: 3 })
    c.set('a', 1); c.set('b', 2); c.set('c', 3)
    c.get('a')            // 'a' is now the most recently used; 'b' is the LRU
    c.set('d', 4)
    expect(c.has('a')).toBe(true)
    expect(c.has('b')).toBe(false)
    expect(c.size()).toBe(3)
    c.destroy()
  })

  it('an overwrite counts as a use', () => {
    const c = createMemoryCache({ defaultTtl: '1 hour', maxSize: 3 })
    c.set('a', 1); c.set('b', 2); c.set('c', 3)
    c.set('a', 10)        // re-inserting must move 'a' off the eviction edge
    c.set('d', 4)
    expect(c.get<unknown>('a')).toBe(10)
    expect(c.has('b')).toBe(false)
    c.destroy()
  })

  it('has() is a probe and does NOT count as a use', () => {
    // Otherwise a scan for one key rewrites the chain and evicts the entries
    // somebody is actually reading.
    const c = createMemoryCache({ defaultTtl: '1 hour', maxSize: 3 })
    c.set('a', 1); c.set('b', 2); c.set('c', 3)
    c.has('a')
    c.set('d', 4)
    expect(c.has('a')).toBe(false)
    c.destroy()
  })

  it('stays at maxSize under sustained writes', () => {
    const c = createMemoryCache({ defaultTtl: '1 hour', maxSize: 10 })
    for (let i = 0; i < 500; i++) c.set('k' + i, i)
    expect(c.size()).toBe(10)
    expect(c.stats().evicts).toBe(490)
    c.destroy()
  })
})
