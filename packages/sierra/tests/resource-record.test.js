/**
 * tests/resource-record.test.js — one row, live, and what a live row must NOT move
 *
 * `resource.record(id)` is a view of ONE over the same nodes a list is a view
 * over (`FJS-D138`). It exists because `service.get(id)` answers a plain object
 * no announcement can reach, so every detail screen in this repo went stale the
 * moment somebody else wrote the row (`FJS-518`).
 *
 * The assertion this file is really for is the second one: **a push moves the
 * value and does not move the version this screen has READ.** `FJS-341` was a
 * live store answering a patch with a revision nobody on the screen had read,
 * which won the race `@version` exists to lose — measured in basecamp, the
 * other writer's change erased with the guard in place and no error anywhere.
 * Making the row live is exactly the change that could bring it back.
 *
 * The client is Junction's REAL one, reached by relative path — `bun install`
 * resolves `workspace:*` to a copy, so a package-name import would test
 * yesterday's client, and a hand-built fake would not have nodes at all.
 */

import { describe, test, expect, vi, beforeEach, afterAll } from 'vitest'
import { createJunctionClient } from '../../junction/src/client/index.ts'

const rows = new Map()
const calls = []
let client

// Junction talks over fetch when no socket is up, so the server is a fetch.
const original = globalThis.fetch
globalThis.fetch = (async (url, init) => {
  const path   = new URL(String(url)).pathname
  const method = init?.method ?? 'GET'
  const id     = Number(path.split('/').pop())
  calls.push([method, path])

  if (method === 'GET' && Number.isFinite(id)) {
    const row = rows.get(id)
    return new Response(JSON.stringify(row ?? null), {
      status: row ? 200 : 404, headers: { 'Content-Type': 'application/json' },
    })
  }
  if (method === 'GET') {
    return new Response(JSON.stringify({
      kind: 'list', object: 'orders', data: [...rows.values()], errors: [],
      total: rows.size, limit: 20, offset: 0,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
})

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => client,
}))

const { createResource } = await import('../src/junction/resource.js')
const { registerSchemas } = await import('../src/junction/schema-registry.js')
const { parse } = await import('../../litestone/src/core/parser.js')
const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

const LITE = `
  model Order {
    id      Int    @id
    status  String
    version Int    @version
  }
`
const { schema, valid, errors } = parse(LITE)
if (!valid) throw new Error(`fixture schema is invalid: ${errors.join('; ')}`)
const DEFS = generateJsonSchema(schema, { mode: 'update' }).$defs

beforeEach(() => {
  registerSchemas(DEFS, ['Order'])
  client = createJunctionClient({ url: 'http://localhost:3000' })
  calls.length = 0
  rows.clear()
  rows.set(1, { id: 1, status: 'pending', version: 3 })
})

describe('resource.record(id)', () => {
  test('reads the row and answers it', async () => {
    const orders = createResource('orders', { model: 'Order' })
    const row = orders.record(1)
    expect(await row.ready).toEqual({ id: 1, status: 'pending', version: 3 })
    expect(row.get()).toEqual({ id: 1, status: 'pending', version: 3 })
  })

  test('the read goes through the resource, so the version is remembered', async () => {
    const orders = createResource('orders', { model: 'Order' })
    await orders.record(1).ready
    expect(orders.version(1)).toBe(3)
  })

  test('a push moves the row with nothing refetched', async () => {
    const orders = createResource('orders', { model: 'Order' })
    const row = orders.record(1)
    await row.ready
    const before = calls.length

    const seen = []
    row.subscribe(v => seen.push(v?.status ?? null))
    client.service('orders')._receive('patched', { id: 1, status: 'paid', version: 4 })

    expect(row.get().status).toBe('paid')
    expect(seen).toEqual(['pending', 'paid'])
    expect(calls.length).toBe(before)
  })

  test('and the push does NOT move the version this screen read — FJS-341', async () => {
    const orders = createResource('orders', { model: 'Order' })
    const row = orders.record(1)
    await row.ready
    expect(orders.version(1)).toBe(3)

    client.service('orders')._receive('patched', { id: 1, status: 'paid', version: 4 })

    expect(row.get().version).toBe(4)   // the value moved
    expect(orders.version(1)).toBe(3)   // what this screen READ did not
  })

  test('a list and a record view of one row are one row', async () => {
    const orders = createResource('orders', { model: 'Order' })
    await orders.load()
    const before = calls.length
    const row = orders.record(1)

    // Already read by the list, so nothing is asked for a second time.
    expect(await row.ready).toEqual({ id: 1, status: 'pending', version: 3 })
    expect(calls.length).toBe(before)

    client.service('orders')._receive('patched', { id: 1, status: 'paid', version: 4 })
    expect(orders.store.get()[0].status).toBe('paid')
    expect(row.get().status).toBe('paid')
  })

  test('answers null once the row is removed', async () => {
    const orders = createResource('orders', { model: 'Order' })
    const row = orders.record(1)
    await row.ready
    client.service('orders')._receive('removed', { id: 1 })
    expect(row.get()).toBeNull()
  })

  test('an optimistic patch shows before it lands and rolls back when refused', async () => {
    const orders = createResource('orders', { model: 'Order' })
    await orders.load()

    let refuse
    const gate = new Promise((_, rej) => { refuse = rej })
    const done = orders.mutate(1, { status: 'paid' }, () => gate)

    expect(orders.store.get()[0].status).toBe('paid')
    refuse(new Error('403'))
    await expect(done).rejects.toThrow('403')
    expect(orders.store.get()[0].status).toBe('pending')
  })

  test('the optimistic value is not committed as the version this screen read', async () => {
    // The overlay is a submitted intent, not a read. Recording a version off it
    // would be `FJS-341` wearing a new hat.
    const orders = createResource('orders', { model: 'Order' })
    await orders.record(1).ready
    expect(orders.version(1)).toBe(3)

    let release
    const gate = new Promise(res => { release = res })
    const done = orders.mutate(1, { status: 'paid', version: 99 }, () => gate)
    expect(orders.store.get()[0]?.status ?? orders.record(1).get().status).toBe('paid')
    expect(orders.version(1)).toBe(3)

    release({ id: 1, status: 'paid', version: 4 })
    await done
    expect(orders.version(1)).toBe(3)   // still: nothing here READ revision 4
  })

  test('save({ optimistic }) refuses a create by name — there is no row to show it against', async () => {
    const orders = createResource('orders', { model: 'Order' })
    await expect(orders.save({ status: 'pending' }, { optimistic: true }))
      .rejects.toThrow(/needs an existing record/)
  })

  test('a resource with no client answers a view that is simply empty', async () => {
    client = null
    const orders = createResource('orders', { model: 'Order' })
    const row = orders.record(1)
    expect(await row.ready).toBeNull()
    expect(row.get()).toBeNull()
  })
})

// Restored in a hook, not at module scope: the bottom of this file runs during
// collection, so putting it there handed every test the real fetch back before
// a single one had run.
afterAll(() => { globalThis.fetch = original })
