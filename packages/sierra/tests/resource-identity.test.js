/**
 * tests/resource-identity.test.js
 *
 * Nothing a resource holds may outlive the person it was read for — and the
 * cache must survive everything else (`FJS-786`).
 *
 * A Resource is created once, at import, in a resource file's `<script module>`
 * (Invariant 18), so its live store, its `_versions` map and its `_options`
 * picker cache live for the life of the TAB, while the principal is a thing
 * that changes inside it. Measured against a real stack before the fix:
 *
 *   the store   — after signOut and signIn as somebody else, and before any
 *                 load, it still held `[{ body: 'u1 private', ownerId: 'u1' }]`
 *   `_versions` — `version(1)` answered a revision the new caller never read
 *   `_options`  — with `@@allow("read", ownerId == auth().id)` on `Customer`,
 *                 the second caller was offered `Alice-of-u1` by id and by
 *                 label, permanently: no request is ever made again
 *
 * This package fixed the same class once — `_tokenChanged` calls
 * `invalidatePrefetch()` for `FJS-041` — and the three siblings were never
 * joined to it.
 *
 * ── The negative control is half of every test here ────────────────────────
 *
 * A fix that simply deleted the cache passes *u2 does not see u1's row* and
 * costs a request per render. So every clearing assertion is paired with a
 * HIT inside one session.
 *
 * The wire is faked and the request COUNT is what most of this measures, which
 * is the thing a real stack cannot report more precisely.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let _finds = 0
let _resourceCalls = 0
let _storeRows = []
let ROWS = []
let _proxy

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: () => {
      _resourceCalls++
      return {
        service: _proxy,
        store: {
          get: () => _storeRows,
          subscribe: (fn) => { fn(_storeRows); return () => {} },
          set: (rows) => { _storeRows = rows },
        },
        stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
        load: (q, d) => _proxy.find(q, d).then(r => { _storeRows = r?.data ?? []; return _storeRows }),
      }
    },
  }),
}))

const { generateSchemas } = await import('../src/build/schema-plugin.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')
const { createResource, resetResourcesForIdentityChange } = await import('../src/junction/resource.js')

const SOURCE = `
model Customer {
  id      Int    @id @default(autoincrement())
  name    String
  @@gate("0.0.0.0")
}
model Note {
  id         Int    @id @default(autoincrement())
  body       String
  customerId Int?
  customer   Customer? @relation(fields: [customerId], references: [id])
  version    Int    @version
  @@gate("0.0.0.0")
}
`

beforeEach(async () => {
  _finds = 0
  _resourceCalls = 0
  _storeRows = []
  ROWS = []
  _proxy = {
    find:    (q, p)  => { _finds++; return Promise.resolve({ data: ROWS, total: ROWS.length }) },
    get:     ()      => Promise.resolve(ROWS[0] ?? {}),
    create:  (d)     => Promise.resolve(d),
    patch:   (_i, d) => Promise.resolve(d),
    remove:  ()      => Promise.resolve({}),
    restore: ()      => Promise.resolve({}),
    invoke:  ()      => Promise.resolve({}),
    on: () => {}, call: () => Promise.resolve(),
  }

  const dir  = mkdtempSync(join(tmpdir(), 'sierra-identity-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)
})

describe('the identity epoch', () => {
  test('the export exists — junction/index.js calls it from _tokenChanged', () => {
    // The seam, asserted rather than assumed: this module holds no client, so
    // *when did the identity change* is owned on the other side of the import.
    expect(typeof resetResourcesForIdentityChange).toBe('function')
  })

  test('a picker offers the previous person nothing, and asks again exactly once', async () => {
    ROWS = [{ id: 1, name: 'Alice-of-u1' }]
    const notes = createResource('notes', { model: 'Note' })

    expect((await notes.options('customerId')).options).toEqual([{ value: 1, label: 'Alice-of-u1' }])
    const asked = _finds

    // Within one session the cache is a cache. This is the half a fix that
    // deleted it would fail.
    await notes.options('customerId')
    await notes.options('customerId')
    expect(_finds).toBe(asked)

    // Somebody else signs in on the same tab.
    ROWS = [{ id: 2, name: 'Bob-of-u2' }]
    resetResourcesForIdentityChange()

    expect((await notes.options('customerId')).options).toEqual([{ value: 2, label: 'Bob-of-u2' }])
    expect(_finds).toBe(asked + 1)

    // …and it is a cache again for the new person.
    await notes.options('customerId')
    expect(_finds).toBe(asked + 1)
  })

  test('the live store does not render the previous person’s rows', async () => {
    ROWS = [{ id: 1, body: 'u1 private', version: 1 }]
    const notes = createResource('notes', { model: 'Note' })
    await notes.load({})
    expect(notes.store.get()).toHaveLength(1)

    resetResourcesForIdentityChange()
    expect(notes.store.get()).toEqual([])
  })

  test('version() does not answer a revision the current caller never read', async () => {
    ROWS = [{ id: 1, body: 'u1 private', version: 4 }]
    const notes = createResource('notes', { model: 'Note' })
    await notes.load({})
    expect(notes.version(1)).toBe(4)

    resetResourcesForIdentityChange()
    expect(notes.version(1)).toBeNull()
  })

  test('EVERY live resource is cleared, not the one that asked', async () => {
    // An app declares one per model in `src/resources/`, and `options()` builds
    // more for the relations it pickers over. One reset has to reach all of
    // them, or a screen the person did not navigate to still holds the previous
    // caller's rows when they do.
    ROWS = [{ id: 1, name: 'Alice-of-u1' }]
    const notes     = createResource('notes',     { model: 'Note' })
    const customers = createResource('customers', { model: 'Customer' })
    await notes.load({})
    await notes.options('customerId')
    await customers.load({})
    const asked = _finds
    expect(customers.store.get()).toHaveLength(1)

    resetResourcesForIdentityChange()

    expect(customers.store.get()).toEqual([])
    expect(notes.store.get()).toEqual([])
    ROWS = [{ id: 2, name: 'Bob-of-u2' }]
    expect((await notes.options('customerId')).options).toEqual([{ value: 2, label: 'Bob-of-u2' }])
    expect(_finds).toBe(asked + 1)
  })
})

describe('options() does not build a resource it is about to throw away', () => {
  test('N cached renders construct exactly one related resource', async () => {
    // `createResource` is not a pure call: it makes a Store, binds it to the
    // node registry, opens the socket and registers a `resync` listener that
    // nothing can remove. Built above the cache check, a picker left one per
    // render behind it — measured against a real stack at 501 listeners and
    // +1.4 MB after 500 renders, and after one reconnect that form fires 500
    // identical `find` requests (`FJS-823`).
    ROWS = [{ id: 1, name: 'Alice' }]
    const notes = createResource('notes', { model: 'Note' })
    const built = _resourceCalls          // the resource itself

    for (let i = 0; i < 50; i++) await notes.options('customerId')

    expect(_resourceCalls - built).toBe(1)
    expect(_finds).toBe(1)
  })

  test('the first render still resolves the label column', async () => {
    // What `related` was constructed early for. A fix that moved the cache
    // check up and dropped the construction would answer ids for labels.
    ROWS = [{ id: 1, name: 'Alice' }]
    const notes = createResource('notes', { model: 'Note' })
    const { options } = await notes.options('customerId')
    expect(options).toEqual([{ value: 1, label: 'Alice' }])
  })

  test('a searched picker is still not cached', async () => {
    ROWS = [{ id: 1, name: 'Alice' }]
    const notes = createResource('notes', { model: 'Note' })
    await notes.options('customerId', { search: 'Ali' })
    await notes.options('customerId', { search: 'Ali' })
    expect(_finds).toBe(2)
  })
})
