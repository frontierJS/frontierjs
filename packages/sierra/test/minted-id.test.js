/**
 * test/minted-id.test.js — the client states the key, for a model that asked.
 *
 * Phase 2 of the Homestead work (`IDEAS/homestead.md`). A row written with no
 * server reachable is referenced by its children before any INSERT has happened,
 * so something has to name it, and the only party present is the browser.
 *
 * **It mints on EVERY create, not only on one that turns out to be held.** A
 * screen cannot know whether its parent reached the server before it needs the
 * parent's id, and an id whose origin depends on the network is an id that is
 * sometimes there and sometimes not — which is the bug this exists to prevent
 * rather than a saving. So the online case is asserted first.
 *
 * **And only where the schema said so.** `x-mint` crosses only for a model that
 * declares `@@sync` and whose single `@id` has a generated default. A minted
 * uuid sent to an `Int @id` would be refused by the server, and a model nobody
 * marked syncable must keep the create surface it had.
 *
 * The fake here is the NETWORK and nothing else — the schemas come from the
 * build's own `generateSchemas`, so what the browser reads is what litestone
 * actually emits.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const _calls = []
let _proxy

vi.mock('@frontierjs/sierra/resource', () => ({
  getClient: () => ({
    service: () => _proxy,
    callHeaders: () => ({}),
    resource: () => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
      load: (q, d) => _proxy.find(q, d).then(r => r?.data ?? []),
    }),
  }),
}))

const { generateSchemas } = await import('../src/build/schema-plugin.js')
const { registerSchemas } = await import('../src/resource/schema-registry.js')
const { createResource }  = await import('../src/resource/resource.js')

const SOURCE = `
model Sheet  { id String @id @default(uuid())   name String  @@gate("0.0.0.0")  @@sync(server) }
model Tag    { id String @id @default(nanoid()) name String  @@gate("0.0.0.0")  @@sync(server) }
model Ledger { id Int    @id                    name String  @@gate("0.0.0.0")  @@sync(server) }
model Plain  { id String @id @default(uuid())   name String  @@gate("0.0.0.0") }
`

beforeEach(async () => {
  _calls.length = 0
  _proxy = {
    find:    (q, p)  => { _calls.push(['find', q, p]);   return Promise.resolve({ data: [], total: 0 }) },
    get:     (id)    => { _calls.push(['get', id]);      return Promise.resolve({}) },
    create:  (d, p, o) => { _calls.push(['create', d, o]); return Promise.resolve({ ...d }) },
    patch:   (id, d) => { _calls.push(['patch', id, d]); return Promise.resolve(d) },
    remove:  (id)    => { _calls.push(['remove', id]);   return Promise.resolve({}) },
    restore: (id)    => { _calls.push(['restore', id]);  return Promise.resolve({}) },
    invoke:  ()      => Promise.resolve({}),
    on: () => {}, call: () => Promise.resolve(),
  }

  const dir  = mkdtempSync(join(tmpdir(), 'sierra-mint-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)
})

const sent = () => _calls.at(-1)[1]

describe('a syncable model with a generated id', () => {
  test('the create carries a key the browser made, with the network up', async () => {
    const sheets = createResource('sheets', { model: 'Sheet' })
    await sheets.save({ name: 'Tuesday' })

    expect(_calls.at(-1)[0]).toBe('create')
    expect(sent().id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  test('the generator named in the schema is the one used', async () => {
    const tags = createResource('tags', { model: 'Tag' })
    await tags.save({ name: 'damaged' })
    // nanoid, not a uuid: 21 url-safe characters and no dashes in uuid places.
    expect(sent().id).toMatch(/^[A-Za-z0-9_-]{21}$/)
  })

  test('two creates never get the same key', async () => {
    const sheets = createResource('sheets', { model: 'Sheet' })
    const seen = new Set()
    for (let i = 0; i < 50; i++) {
      await sheets.save({ name: 'n' + i })
      seen.add(sent().id)
    }
    expect(seen.size).toBe(50)
  })

  test('a key the caller stated is kept', async () => {
    // The same rule the server follows for a create that carries one. A screen
    // that has already written the id down — a child holding its parent's key —
    // must not have it replaced underneath.
    const sheets = createResource('sheets', { model: 'Sheet' })
    await sheets.save({ id: 'STATED-BY-THE-CALLER', name: 'Tuesday' })
    expect(sent().id).toBe('STATED-BY-THE-CALLER')
  })

  test('only a create is minted for — a patch carries the id it was given', async () => {
    const sheets = createResource('sheets', { model: 'Sheet' })
    await sheets.service.patch('ALREADY-THERE', { name: 'renamed' })
    expect(_calls.at(-1)[0]).toBe('patch')
    expect(_calls.at(-1)[1]).toBe('ALREADY-THERE')
  })
})

describe('a model the schema did not mark', () => {
  test('a server-keyed id under @@sync is left to the server', async () => {
    // A minted uuid in an Int @id would be refused at the boundary, and the
    // advisor warns about this shape where it has children. Here the create
    // simply goes as it always did.
    const ledgers = createResource('ledgers', { model: 'Ledger' })
    await ledgers.save({ name: 'opening' })
    expect('id' in sent()).toBe(false)
  })

  test('a uuid id WITHOUT @@sync is left to the server', async () => {
    // The declaration is what widens the create surface. Without it the id is
    // not even in create mode, so minting one would send a field the server
    // refuses by name.
    const plains = createResource('plains', { model: 'Plain' })
    await plains.save({ name: 'x' })
    expect('id' in sent()).toBe(false)
  })
})
