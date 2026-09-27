/**
 * test/attachment-queue.test.js — the bytes, which are not a row.
 *
 * Phase 2 of the Homestead work, ruled by `FJS-D301`: two queues. What is
 * asserted here is the SPLIT and nothing about uploading — that a write the
 * network could not carry leaves the row in one queue without its bytes and the
 * bytes in another naming that row, and that the two settle and fail together
 * when they travelled together.
 *
 * The network is the only fake. The schemas come from the build's own
 * `generateSchemas`, so a File column here is the shape litestone really emits.
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
    callHeaders: () => ({}),
    resource: () => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      stale: { get: () => 0, subscribe: (fn) => { fn(0); return () => {} }, reset: () => {} },
      load: (q, d) => _proxy.find(q, d).then(r => r?.data ?? []),
    }),
  }),
}))

const { generateSchemas }   = await import('../src/build/schema-plugin.js')
const { registerSchemas }   = await import('../src/junction/schema-registry.js')
const { createResource }    = await import('../src/junction/resource.js')
const { pendingQueue, _resetPendingQueue }       = await import('../src/junction/pending.js')
const { attachmentQueue, drainAttachments, _resetAttachmentQueue } = await import('../src/junction/attachments.js')

const SOURCE = `
model Shot   { id String @id @default(uuid())  name String  damage File?  @@gate("0.0.0.0")  @@sync(server) }
model Keyed  { id Int    @id                   name String  damage File?  @@gate("0.0.0.0")  @@sync(server) }
model Note   { id String @id @default(uuid())  name String  damage File?  version Int @version  @@gate("0.0.0.0")  @@sync(field) }
`

/** A failure the client attaches no code to — a request that never got a reply. */
const offline = () => Promise.reject(new TypeError('Failed to fetch'))
/** A failure the server ANSWERED with. */
const refused = () => Promise.reject(Object.assign(new Error('no'), { code: 422 }))

const blob = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })

let creating = (d) => Promise.resolve({ ...d })

beforeEach(async () => {
  _calls.length = 0
  _resetPendingQueue()
  _resetAttachmentQueue()
  creating = (d) => Promise.resolve({ ...d })
  _proxy = {
    find:    ()      => Promise.resolve({ data: [], total: 0 }),
    get:     ()      => Promise.resolve({}),
    create:  (d)     => { _calls.push(['create', d]); return creating(d) },
    patch:   (id, d) => { _calls.push(['patch', id, d]); return Promise.resolve(d) },
    remove:  ()      => Promise.resolve({}),
    restore: ()      => Promise.resolve({}),
    invoke:  ()      => Promise.resolve({}),
    on: () => {}, call: () => Promise.resolve(),
  }

  const dir  = mkdtempSync(join(tmpdir(), 'sierra-attach-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)
})

describe('a write the network could not carry, carrying bytes', () => {
  test('the row is queued WITHOUT them and the bytes are queued naming the row', async () => {
    creating = offline
    const shots = createResource('shots', { model: 'Shot' })

    let thrown = null
    try { await shots.save({ name: 'crushed', damage: blob() }) } catch (e) { thrown = e }

    expect(thrown?.queued).toBe(true)
    expect(thrown?.attachments).toBe(1)

    const write = pendingQueue().pending()
    expect(write.length).toBe(1)
    // The whole argument for two queues: a 4MB photograph must not be sitting
    // in front of the next 200-byte write in one FIFO.
    expect('damage' in write[0].data).toBe(false)
    expect(write[0].data.name).toBe('crushed')

    const bytes = attachmentQueue().pending()
    expect(bytes.length).toBe(1)
    expect(bytes[0].field).toBe('damage')
    expect(bytes[0].type).toBe('image/png')
    expect(bytes[0].size).toBe(4)
    // Naming the row is the point, and the id is the one the BROWSER minted —
    // there is no other, since the server has never seen this row.
    expect(bytes[0].id).toBe(write[0].data.id)
    expect(bytes[0].id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('a model whose key only the server assigns queues neither half', async () => {
    // There would be nothing for the patch to name. Failing here is the honest
    // answer, and the schema advisor says so before anyone gets this far.
    creating = offline
    const keyed = createResource('keyeds', { model: 'Keyed' })

    let thrown = null
    try { await keyed.save({ name: 'crushed', damage: blob() }) } catch (e) { thrown = e }

    expect(thrown?.queued).toBeUndefined()
    expect(pendingQueue().pending().length).toBe(0)
    expect(attachmentQueue().pending().length).toBe(0)
  })

  test('the server refusing the row rejects the bytes with it', async () => {
    // They were parked against a row the boundary declined, so replaying them
    // would patch a row that does not exist.
    creating = refused
    const shots = createResource('shots', { model: 'Shot' })
    await shots.save({ name: 'crushed', damage: blob() }).catch(() => {})

    expect(pendingQueue().rejected().length).toBe(1)
    expect(attachmentQueue().rejected().length).toBe(1)
    expect(attachmentQueue().pending().length).toBe(0)
  })
})

describe('a working network', () => {
  test('is still one call, and both queues come out empty', async () => {
    // The online path must not become two round trips to pay for the offline
    // one. The bytes travel on the create exactly as they did, and the same
    // acknowledgement settles both entries.
    const shots = createResource('shots', { model: 'Shot' })
    await shots.save({ name: 'crushed', damage: blob() })

    expect(_calls.filter(c => c[0] === 'create').length).toBe(1)
    expect(_calls.filter(c => c[0] === 'patch').length).toBe(0)
    expect(_calls[0][1].damage instanceof Blob).toBe(true)
    expect(pendingQueue().list().length).toBe(0)
    expect(attachmentQueue().list().length).toBe(0)
  })
})

describe('the queue itself', () => {
  test('bytes() is what a screen shows before asking to upload on data', async () => {
    creating = offline
    const shots = createResource('shots', { model: 'Shot' })
    await shots.save({ name: 'a', damage: blob() }).catch(() => {})
    await shots.save({ name: 'b', damage: blob() }).catch(() => {})
    expect(attachmentQueue().pending().length).toBe(2)
    expect(attachmentQueue().bytes()).toBe(8)
  })

  test('an attachment with no row to name is refused rather than stored', async () => {
    await expect(attachmentQueue().add({ service: 's', model: 'M', field: 'f', blob: blob() }))
      .rejects.toThrow(/needs the id/)
    await expect(attachmentQueue().add({ service: 's', model: 'M', id: 'x', blob: blob() }))
      .rejects.toThrow(/needs the field/)
  })
})

describe('draining the bytes onto a @version row', () => {
  // Litestone refuses a patch on a `@version` model that carries no version
  // (`FJS-1298`), so bytes drained as `{ damage: blob }` alone were parked
  // `rejected` on exactly the models two people edit. The version the patch
  // needs is the one the row is at AFTER the write queue drained, which only
  // the server knows.
  const client = () => ({ service: () => _proxy })

  async function parkOne() {
    creating = offline
    const notes = createResource('notes', { model: 'Note' })
    await notes.save({ name: 'scratched', damage: blob() }).catch(() => {})
    expect(attachmentQueue().pending().length).toBe(1)
    return attachmentQueue().pending()[0]
  }

  test('reads the row and patches with the version it is at', async () => {
    const entry = await parkOne()
    _proxy.get = (id) => { _calls.push(['get', id]); return Promise.resolve({ id, name: 'scratched', version: 3 }) }

    const out = await drainAttachments(client())

    expect(out).toEqual({ settled: 1, rejected: 0 })
    const patch = _calls.find(c => c[0] === 'patch')
    expect(patch[1]).toBe(entry.id)
    expect(patch[2].version).toBe(3)
    expect(patch[2].damage instanceof Blob).toBe(true)
  })

  test('a re-send carries the version the first send read', async () => {
    // A send whose answer was lost may have landed and moved the row, and
    // the idempotency key is refused `422` under a different payload — so the
    // re-send must be the same bytes AND the same version, not a fresh read.
    await parkOne()
    let at = 3
    _proxy.get = (id) => Promise.resolve({ id, version: at })
    _proxy.patch = (id, d) => { _calls.push(['patch', id, d]); at = 4; return offline() }
    await drainAttachments(client())
    expect(attachmentQueue().pending().length).toBe(1)

    _proxy.patch = (id, d) => { _calls.push(['patch', id, d]); return Promise.resolve(d) }
    const out = await drainAttachments(client())

    expect(out.settled).toBe(1)
    const patches = _calls.filter(c => c[0] === 'patch')
    expect(patches.map(p => p[2].version)).toEqual([3, 3])
  })

  test('a stale version is read again rather than rejecting the photograph', async () => {
    await parkOne()
    let at = 3
    _proxy.get = (id) => Promise.resolve({ id, version: at })
    let first = true
    _proxy.patch = (id, d) => {
      _calls.push(['patch', id, d])
      if (first) { first = false; at = 5; return Promise.reject(Object.assign(new Error('stale'), { code: 409, retryable: true })) }
      return Promise.resolve(d)
    }

    const out = await drainAttachments(client())

    expect(out).toEqual({ settled: 1, rejected: 0 })
    expect(_calls.filter(c => c[0] === 'patch').map(p => p[2].version)).toEqual([3, 5])
  })

  test('a model with no @version is patched without a read', async () => {
    creating = offline
    const shots = createResource('shots', { model: 'Shot' })
    await shots.save({ name: 'crushed', damage: blob() }).catch(() => {})
    _proxy.get = (id) => { _calls.push(['get', id]); return Promise.resolve({ id }) }

    await drainAttachments(client())

    expect(_calls.some(c => c[0] === 'get')).toBe(false)
    expect(Object.keys(_calls.find(c => c[0] === 'patch')[2])).toEqual(['damage'])
  })
})
