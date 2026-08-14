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

/** Every derived name, counted per method. */
function derivedCounts(svc: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const [method, list] of Object.entries(hooksOf(svc))) {
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
    expect(Object.keys(counts.find  ?? {}).sort()).toEqual(['autoFilter', 'autoSort', 'gateAuth'])
    expect(Object.keys(counts.create ?? {}).sort()).toEqual(['autoValidate', 'gateAuth'])
    expect(Object.keys(counts.remove ?? {}).sort()).toEqual(['gateAuth'])
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

  test("the user's own hook still runs first", () => {
    const mine = function authenticate(_ctx: ServiceContext) {}
    const svc  = createService({
      name: 'leads', model: 'lead', db,
      hooks: { before: { create: [mine] } },
    })
    expect(hooksOf(svc).create?.[0]).toBe(mine)
  })

  test('a USER hook named gateAuth does not suppress the real one', () => {
    // The reason the mark exists. Dedupe by name alone would read this as
    // "gateAuth is already here" and drop the only copy that enforces @@gate.
    const impostor = function gateAuth(_ctx: ServiceContext) {}
    const svc = createService({
      name: 'leads', model: 'lead', db,
      hooks: { before: { find: [impostor] } },
    })

    const find = hooksOf(svc).find ?? []
    expect(find[0]).toBe(impostor)
    expect(find.filter(h => isDerivedHook(h) && h.name === 'gateAuth')).toHaveLength(1)
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
