/**
 * tests/sync-policies.test.js — what `@@sync`'s argument actually does.
 *
 * `FJS-D304` ruled that `append` and `refuse` ship next. The risk in shipping a
 * vocabulary is the one `FJS-D298` closed the set against: **a policy that
 * parses and resolves nothing reads exactly like one that works.** So every
 * test here is a BEHAVIORAL difference between two policies on the same write,
 * and the file would be worthless without the pairings.
 *
 * All three policies are identical on a reachable network, and that is asserted
 * too — the argument decides what happens to a write nobody is standing over
 * when it lands, and a policy that changed an online write would be changing
 * something its author did not ask about.
 *
 *   server  the operation replays against whatever the row holds by then, so
 *           the revision the device read is DROPPED from the held write
 *   append  only a create may be held; a held patch is refused by name
 *   refuse  the held write carries its revision and the boundary refuses it
 *
 * `server` dropping the version is the one that changed existing behavior, and
 * it is a fix rather than a feature: the resource stamps the version onto every
 * patch so that a stale edit is refused, which is right for a write somebody is
 * standing over and wrong for a held one. Under `server` the declaration IS
 * *replay against whatever is there*, and a carried revision turns that into a
 * refusal the person who made the write has long since walked away from.
 *
 * The network is the only fake; the schemas come from the build's own
 * `generateSchemas`, so `x-sync` and `x-version` are what litestone emits.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const SIERRA_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

let _proxy
const _calls = []

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
const { createResource }  = await import('../src/junction/resource.js')
const { pendingQueue, _resetPendingQueue } = await import('../src/junction/pending.js')
const { attachmentQueue, _resetAttachmentQueue } = await import('../src/junction/attachments.js')

// Three models differing ONLY in the policy, plus one with no `@@sync` at all.
// `Ledger` has no `@version` on purpose: `append` needs none, and the parser
// refuses `refuse` without one (asserted in litestone's own suite).
const SOURCE = `
model Served { id String @id @default(uuid())  name String  v Int @version  @@gate("0.0.0.0")  @@sync(server) }
model Guard  { id String @id @default(uuid())  name String  v Int @version  @@gate("0.0.0.0")  @@sync(refuse) }
model Ledger { id String @id @default(uuid())  name String                  @@gate("0.0.0.0")  @@sync(append) }
model Plain  { id String @id @default(uuid())  name String  v Int @version  @@gate("0.0.0.0") }
model Photo  { id String @id @default(uuid())  name String  damage File?    @@gate("0.0.0.0")  @@sync(append) }
model Merge  { id String @id @default(uuid())  name String  v Int @version  @@gate("0.0.0.0")  @@sync(field) }
`

/** A failure the client attaches no code to — a request that never got a reply. */
const offline = () => Promise.reject(new TypeError('Failed to fetch'))

let patching = (id, d) => Promise.resolve({ ...d })

beforeEach(async () => {
  _calls.length = 0
  _resetPendingQueue()
  _resetAttachmentQueue()
  patching = (id, d) => Promise.resolve({ ...d })
  _proxy = {
    find:    ()      => Promise.resolve({ data: [], total: 0 }),
    get:     (id)    => Promise.resolve({ id, name: 'as read', v: 7 }),
    create:  (d)     => { _calls.push(['create', d]); return Promise.resolve({ ...d }) },
    patch:   (id, d) => { _calls.push(['patch', id, d]); return patching(id, d) },
    remove:  (id)    => { _calls.push(['remove', id]); return Promise.resolve({}) },
    restore: ()      => Promise.resolve({}),
    invoke:  ()      => Promise.resolve({}),
    on: () => {}, call: () => Promise.resolve(),
  }

  const dir  = mkdtempSync(join(tmpdir(), 'sierra-sync-'))
  const path = join(dir, 'schema.lite')
  writeFileSync(path, SOURCE)
  const g = await generateSchemas(path, () => {}, SIERRA_ROOT)
  registerSchemas(g.defs, g.models, g.updatePatch)
})

// Put a record in the resource's read cache so the version stamp has something
// to read, which is how a real screen reaches a patch: it rendered the row.
async function withRow(service, model) {
  const r = createResource(service, { model })
  await r.service.get('ROW-1')
  await r.load()
  return r
}

const held = () => pendingQueue().pending()

// ─── the crossing ─────────────────────────────────────────────────────────

describe('the policy reaches the browser as itself', () => {
  test('each model carries its own word, and a model that said nothing carries none', async () => {
    const { schemaFor } = await import('../src/junction/schema-registry.js')
    expect(schemaFor('Served')['x-sync']).toBe('server')
    expect(schemaFor('Guard')['x-sync']).toBe('refuse')
    expect(schemaFor('Ledger')['x-sync']).toBe('append')
    expect(schemaFor('Plain')['x-sync']).toBeUndefined()
    expect(schemaFor('Merge')['x-sync']).toBe('field')
  })
})

// ─── append ───────────────────────────────────────────────────────────────

describe('append — rows are only ever added', () => {
  test('a create is held like any other', async () => {
    _proxy.create = offline
    const ledger = createResource('ledgers', { model: 'Ledger' })
    await ledger.save({ name: 'opening' }).catch(() => {})
    expect(held().length).toBe(1)
    expect(held()[0].method).toBe('create')
  })

  test('a patch is refused BY NAME, and nothing is held', async () => {
    const ledger = createResource('ledgers', { model: 'Ledger' })
    await expect(ledger.service.patch('ROW-1', { name: 'corrected' }))
      .rejects.toThrow(/@@sync\(append\)/)
    expect(held().length).toBe(0)
  })

  test('the refusal names the model, the method and a code', async () => {
    const ledger = createResource('ledgers', { model: 'Ledger' })
    const err = await ledger.service.patch('ROW-1', { name: 'x' }).catch(e => e)
    expect(err.code).toBe('APPEND_ONLY')
    expect(err.model).toBe('Ledger')
    expect(err.method).toBe('patch')
  })

  test('a remove is refused for the same reason', async () => {
    const ledger = createResource('ledgers', { model: 'Ledger' })
    await expect(ledger.service.remove('ROW-1')).rejects.toThrow(/APPEND_ONLY|append/)
  })

  // **The custom verb, and this is the row the drive paid for.** `example`
  // writes its ledger through `adjust()`, which computes a delta and APPENDS a
  // movement — and an earlier version of this rule refused everything that was
  // not a create, which broke offline writes on the very model whose schema
  // says `append` is a statement of fact. Sierra cannot read a custom method;
  // judging one is a rule about something this layer does not know.
  test('a custom method is held, not refused', async () => {
    _proxy.invoke = offline
    const ledger = createResource('ledgers', { model: 'Ledger' })
    await ledger.service.invoke('adjust', 'ROW-1', { delta: 3 }).catch(() => {})
    expect(held().length).toBe(1)
    expect(held()[0].method).toBe('adjust')
  })

  // ── field — built at the boundary, not yet reachable from here ────────────
  //
  // `@@sync(field)` merges a held write column by column against the row it was
  // made against, and the comparison lives at the Data boundary (`FJS-D334`).
  // Nothing here carries that row yet, so a held write would go up with its
  // revision and no base and be refused on the revision alone — which is
  // `refuse` behaving correctly under a declaration that promises more.
  //
  // The refusal is what keeps that from being a green screen over a feature
  // that is off: a policy that parses and resolves nothing reads exactly like
  // one that works, which is why `FJS-D298` closed the set in the first place.
  test('a held patch is refused BY NAME while the base cannot travel', async () => {
    const merge = createResource('merges', { model: 'Merge' })
    const err = await merge.service.patch('ROW-1', { name: 'mine' }).catch(e => e)
    expect(err.code).toBe('NO_BASE_CARRIED')
    expect(String(err.message)).toMatch(/@@sync\(field\)/)
    expect(String(err.message)).toMatch(/behave as @@sync\(refuse\)/)
    expect(held().length).toBe(0)
  })

  test('a create is held — it was made against no row', async () => {
    _proxy.create = offline
    const merge = createResource('merges', { model: 'Merge' })
    await merge.save({ name: 'first' }).catch(() => {})
    expect(held().length).toBe(1)
    expect(held()[0].method).toBe('create')
  })

  // The control. A refusal that fired on reads would break every screen, and
  // `find`/`get` are never queued for any policy.
  test('reading is untouched', async () => {
    const ledger = createResource('ledgers', { model: 'Ledger' })
    await expect(ledger.service.get('ROW-1')).resolves.toBeTruthy()
    await expect(ledger.service.find({})).resolves.toBeTruthy()
  })

  // And the pairing that makes the rule mean something: the identical call on
  // a model that did not declare `append` is held, not refused.
  test('the same patch on a server-policy model is held instead', async () => {
    const served = await withRow('serveds', 'Served')
    _proxy.patch = offline
    await served.service.patch('ROW-1', { name: 'corrected' }).catch(() => {})
    expect(held().length).toBe(1)
    expect(held()[0].method).toBe('patch')
  })
})

// The bytes are the exception, and they have to be. `FJS-D301` drains a held
// file as a `patch` naming the row — but through the RAW client, not through
// this dispatch, because the bytes of a row THIS device created are not a
// second writer editing it. Pinned, because the day somebody routes the
// attachment drain through the resource for consistency, an append-only model
// silently stops accepting its own photographs.
describe('append and the attachment queue', () => {
  test('a held create still parks its bytes', async () => {
    _proxy.create = offline
    const photos = createResource('photos', { model: 'Photo' })
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' })
    await photos.save({ name: 'shelf', damage: blob }).catch(() => {})

    expect(held().length).toBe(1)
    expect('damage' in held()[0].data).toBe(false)
    expect(attachmentQueue().list().length).toBe(1)
    expect(attachmentQueue().list()[0].field).toBe('damage')
  })
})

// ─── server vs refuse ─────────────────────────────────────────────────────

describe('server drops the revision, refuse keeps it', () => {
  test('a held patch under `server` carries no version', async () => {
    const served = await withRow('serveds', 'Served')
    _proxy.patch = offline
    await served.service.patch('ROW-1', { name: 'corrected' }).catch(() => {})

    expect(held().length).toBe(1)
    expect('v' in held()[0].data).toBe(false)
  })

  test('a held patch under `refuse` carries the version the device read', async () => {
    const guard = await withRow('guards', 'Guard')
    _proxy.patch = offline
    await guard.service.patch('ROW-1', { name: 'corrected' }).catch(() => {})

    expect(held().length).toBe(1)
    expect(held()[0].data.v).toBe(7)
  })

  // The control, and the one that says the policy is about HELD writes only.
  // A reachable network must see the identical request under both words —
  // otherwise the argument is silently changing optimistic concurrency for
  // every online screen, which nobody asked it to do.
  test('with the network up, both send the version', async () => {
    const served = await withRow('serveds', 'Served')
    await served.service.patch('ROW-1', { name: 'corrected' })
    const underServer = _calls.at(-1)[2]

    _calls.length = 0
    const guard = await withRow('guards', 'Guard')
    await guard.service.patch('ROW-1', { name: 'corrected' })
    const underRefuse = _calls.at(-1)[2]

    expect(underServer.v).toBe(7)
    expect(underRefuse.v).toBe(7)
  })

  test('a create is unaffected by either — there is no revision to carry', async () => {
    _proxy.create = offline
    const served = createResource('serveds', { model: 'Served' })
    await served.save({ name: 'new' }).catch(() => {})
    expect(held()[0].data.name).toBe('new')
    expect('v' in held()[0].data).toBe(false)
  })
})
