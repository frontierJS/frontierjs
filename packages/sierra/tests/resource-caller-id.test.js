/**
 * tests/resource-caller-id.test.js
 *
 * `save({ mode: 'auto' })` and whose key it is.
 *
 * *Is the id present* answers *does this row exist* only where the SERVER
 * assigns the key. Litestone deliberately emits a caller-supplied `@id` in the
 * create schema so a generated form has a box to type it into (`FJS-608`), and
 * `save()` then routed what the person had just typed into a patch: a create
 * form over `Sku { code String @id }` could never create a row — it threw
 * *Unknown field 'id' in where for Sku.update* — and left EMPTY it was worse,
 * because `make()` seeds `''` and `'' != null`, so an empty create form issued
 * a patch over the whole COLLECTION (`FJS-808`).
 *
 * The schema already carries the fact: a server-assigned `@id` is absent from
 * create mode and a caller-supplied one is present. So this file builds its
 * schemas through `generateSchemas()`, the build's own function, rather than
 * hand-writing a `properties` table that could say either thing.
 *
 * The fake here is the NETWORK and nothing else.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const _calls = []
let _proxy

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
      load: (q, d) => _proxy.find(q, d).then(r => r?.data ?? []),
    }),
  }),
}))

const { generateSchemas } = await import('../src/build/schema-plugin.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')
const { createResource } = await import('../src/junction/resource.js')

const SOURCE = `
model Sku  { code String @id   name String  @@gate("0.0.0.0") }
model Doc  { id   String @id   name String  @@gate("0.0.0.0") }
model Auto { id   Int    @id @default(autoincrement())  name String  @@gate("0.0.0.0") }
`

let ROWS = []

beforeEach(async () => {
  _calls.length = 0
  ROWS = []
  _proxy = {
    find:    (q, p)  => { _calls.push(['find', q, p]);   return Promise.resolve({ data: ROWS, total: ROWS.length }) },
    get:     (id)    => { _calls.push(['get', id]);      return Promise.resolve(ROWS[0] ?? {}) },
    create:  (data)  => { _calls.push(['create', data]); return Promise.resolve(data) },
    patch:   (id, d) => { _calls.push(['patch', id, d]); return Promise.resolve(d) },
    remove:  (id)    => { _calls.push(['remove', id]);   return Promise.resolve({}) },
    restore: (id)    => { _calls.push(['restore', id]);  return Promise.resolve({}) },
    invoke:  ()      => Promise.resolve({}),
    on: () => {}, call: () => Promise.resolve(),
  }

  const dir  = mkdtempSync(join(tmpdir(), 'sierra-callerid-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)
})

const verb = () => _calls.at(-1)[0]

describe('a caller-supplied @id', () => {
  test('a filled create form CREATES — both spellings of the key', async () => {
    const skus = createResource('skus', { model: 'Sku', idField: 'code' })
    await skus.save({ code: 'TYPED-BY-A-PERSON', name: 'Widget' })
    expect(verb()).toBe('create')

    const docs = createResource('docs', { model: 'Doc' })
    await docs.save({ id: 'TYPED-BY-A-PERSON', name: 'Widget' })
    expect(verb()).toBe('create')
  })

  test('a row this resource has READ patches', async () => {
    // Which is what `auto` was trying to reconstruct: an edit form is opened on
    // a row this resource fetched. This is the negative control for the test
    // above — a fix that always created would satisfy that one on its own and
    // would turn every edit into a duplicate row (`FJS-351`).
    ROWS = [{ code: 'ALREADY-THERE', name: 'Widget' }]
    const skus = createResource('skus', { model: 'Sku', idField: 'code' })
    await skus.load({})
    await skus.save({ code: 'ALREADY-THERE', name: 'renamed' })
    expect(verb()).toBe('patch')
    expect(_calls.at(-1)[1]).toBe('ALREADY-THERE')
  })

  test('a row read one at a time patches too', async () => {
    ROWS = [{ id: 'FETCHED', name: 'Widget' }]
    const docs = createResource('docs', { model: 'Doc' })
    await docs.service.get('FETCHED')
    await docs.save({ id: 'FETCHED', name: 'renamed' })
    expect(verb()).toBe('patch')
  })
})

describe('a server-assigned @id', () => {
  test('presence still decides, and a read is not needed', async () => {
    // The other half of the negative control: the common case must not have
    // changed, and it must not depend on this resource having read the row —
    // an id the caller did not have and now does came from somewhere.
    const autos = createResource('autos', { model: 'Auto' })
    await autos.save({ name: 'new' })
    expect(verb()).toBe('create')

    await autos.save({ id: 7, name: 'edited' })
    expect(verb()).toBe('patch')
    expect(_calls.at(-1)[1]).toBe(7)
  })

  test('an id of 0 is an id — upsert used to read it as absent', async () => {
    const autos = createResource('autos', { model: 'Auto' })
    await autos.service.upsert({ id: 0, name: 'zero' })
    expect(verb()).toBe('patch')
  })
})

describe('a blank id is not an id', () => {
  test('an empty create form creates rather than patching the collection', async () => {
    // `make()` seeds `''` and `'' != null`, so this issued a patch with no id —
    // a write over every row the caller can reach, with nothing between the
    // form and the wire standing in its way.
    const skus  = createResource('skus', { model: 'Sku', idField: 'code' })
    const draft = skus.make()
    expect(draft.code).toBe('')
    await skus.save(draft).catch(() => {})
    expect(verb()).toBe('create')
    expect(_calls.map(c => c[0])).not.toContain('patch')
  })

  test("mode: 'patch' with no id is refused by name, not sent", async () => {
    const autos = createResource('autos', { model: 'Auto' })
    await expect(autos.save({ name: 'x' }, { mode: 'patch' }))
      .rejects.toThrow(/needs a value for 'id'/)
    await expect(autos.save({ id: '', name: 'x' }, { mode: 'patch' }))
      .rejects.toThrow(/empty one/)
    expect(_calls).toHaveLength(0)
  })

  test("mode: 'create' is still forced, id or no id", async () => {
    // The guard must refuse the collection patch and nothing else: one that
    // refused every stated mode would satisfy the assertion above.
    const autos = createResource('autos', { model: 'Auto' })
    await autos.save({ id: 9, name: 'x' }, { mode: 'create' })
    expect(verb()).toBe('create')
  })
})
