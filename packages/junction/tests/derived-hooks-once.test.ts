// tests/derived-hooks-once.test.ts — the schema-derived layer installs once.
//
// `createBaseService` returns the MERGED hook map, not the caller's, and the
// autoloader spreads a built base straight back through `createService`
// (loader.ts:52 — its discriminant is `typeof service.hooks !== 'function'`, and
// a base's hooks is a map). `createService` forwards that map into a second
// `createBaseService`, which appended the derived layer again. Every autoloaded
// one-line service therefore graded its @@gate and ran its validator twice per
// request — not wrong on the wire, which is exactly why nothing caught it
// (`FJS-231`).
//
// The dedupe keys on a MARK, never on a name: a user hook called `gateAuth` is
// not ours, and letting it suppress the real one is fail-open on access.

import { describe, test, expect } from 'bun:test'
import { createService, createBaseService } from '../src/core/service.ts'
import { isDerivedHook } from '../src/core/litestone.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const DERIVED = ['gateAuth', 'autoValidate', 'autoFilter', 'autoSort']

function hooksOf(svc: unknown): Record<string, Function[]> {
  return ((svc as { _hookMap?: { before?: Record<string, Function[]> } })._hookMap?.before ?? {})
}

/** The around chain. `gateAuth` lives here — see FJS-403. */
function aroundOf(svc: unknown): Record<string, Function[]> {
  return ((svc as { _hookMap?: { around?: Record<string, Function[]> } })._hookMap?.around ?? {})
}

/** Every derived name, counted per method. */
function derivedCounts(svc: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  const all = { ...hooksOf(svc) }
  for (const [key, list] of Object.entries(aroundOf(svc))) {
    all[`around.${key}`] = list
  }
  for (const [method, list] of Object.entries(all)) {
    const counts: Record<string, number> = {}
    for (const h of list) {
      if (!isDerivedHook(h)) continue
      counts[h.name] = (counts[h.name] ?? 0) + 1
    }
    out[method] = counts
  }
  return out
}

const db = () => ({
  lead: {
    findMany:         async () => [],
    count:            async () => 0,
    findManyAndCount: async () => ({ rows: [], total: 0 }),
    findUnique:       async () => null,
    findFirst:        async () => null,
    create:           async (a: { data: unknown }) => a.data,
  },
})

describe('the derived layer installs once', () => {

  // Exactly what loader.ts:52-56 builds for `export function createLeadsService()
  // { return createBaseService({ model: 'lead' }) }`.
  const throughTheLoader = () => createService({
    name: 'leads',
    ...(createBaseService({ model: 'lead', db }) as object),
  } as never)

  test('the loader shape installs each derived hook once per method', () => {
    for (const [method, counts] of Object.entries(derivedCounts(throughTheLoader()))) {
      for (const [name, n] of Object.entries(counts)) {
        expect(`${method}.${name}=${n}`).toBe(`${method}.${name}=1`)
      }
    }
  })

  test('a direct createService is unchanged, and agrees with the loader shape', () => {
    const direct = createService({ name: 'leads', model: 'lead', db })
    expect(derivedCounts(throughTheLoader())).toEqual(derivedCounts(direct))
  })

  test('every derived hook is still present — dedupe must not delete the layer', () => {
    const counts = derivedCounts(throughTheLoader())
    expect(Object.keys(counts['around.all'] ?? {})).toEqual(['gateAuth'])
    expect(Object.keys(counts.find  ?? {}).sort()).toEqual(['autoFilter', 'autoSort'])
    expect(Object.keys(counts.create ?? {}).sort()).toEqual(['autoValidate'])
    expect(counts.remove).toBeUndefined()
  })

  test('a hand-spread base is the same case', () => {
    const svc = createService({
      name: 'leads',
      ...(createBaseService({ model: 'lead', db }) as object),
    } as never)
    for (const counts of Object.values(derivedCounts(svc))) {
      for (const n of Object.values(counts)) expect(n).toBe(1)
    }
  })

  test('the gate wraps the chain, the validator trails the user hook (FJS-403)', () => {
    // The 401 is an around hook, so it runs before every before hook there is —
    // `before: { all: [...] }` included. The shaping hook still runs before the
    // validator that grades what it shaped.
    const mine = function authenticate(_ctx: ServiceContext) {}
    const svc  = createService({
      name: 'leads', model: 'lead', db,
      hooks: { before: { create: [mine] } },
    })
    expect((aroundOf(svc).all ?? []).map(h => h.name)).toEqual(['gateAuth'])
    expect((hooksOf(svc).create ?? []).map(h => h.name)).toEqual(['authenticate', 'autoValidate'])
  })

  test('a USER hook named gateAuth does not suppress the real one', () => {
    // The reason the mark exists. Dedupe by name alone would read this as
    // "gateAuth is already here" and drop the only copy that enforces @@gate.
    const impostor = function gateAuth(_ctx: ServiceContext) {}
    const svc = createService({
      name: 'leads', model: 'lead', db,
      hooks: { before: { find: [impostor] } },
    })

    expect((hooksOf(svc).find ?? [])[0]).toBe(impostor)
    expect((aroundOf(svc).all ?? []).filter(h => isDerivedHook(h) && h.name === 'gateAuth'))
      .toHaveLength(1)
  })

  test('the mark does not leak onto user hooks', () => {
    const mine = function authenticate(_ctx: ServiceContext) {}
    createService({ name: 'leads', model: 'lead', db, hooks: { before: { find: [mine] } } })
    expect(isDerivedHook(mine)).toBe(false)
  })

  test('a base with no user hooks still marks its derived layer', () => {
    // The `: derivedHooks` branch of the merge. An unmarked layer is invisible
    // to the dedupe, so the second pass would install it again.
    const base = createBaseService({ model: 'lead', db }) as { hooks?: { before?: Record<string, Function[]> } }
    const find = base.hooks?.before?.find ?? []
    expect(find.length).toBeGreaterThan(0)
    expect(find.every(isDerivedHook)).toBe(true)
  })
})
