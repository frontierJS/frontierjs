/**
 * tests/resource-shapes.test.js
 *
 * createResource's service methods are a PASS-THROUGH of the Junction client.
 * Junction's rule — a list keeps its envelope, a single unwraps to the record —
 * therefore reaches app code unchanged, while the stores hold rows.
 *
 * Nothing asserted this. When Junction's find() changed from returning a bare
 * array to returning the list envelope, every Sierra test still passed: the
 * only tests that touch createResource use a stub proxy, so they asserted
 * whatever the stub returned. An app doing `(await svc.find()).map(...)` would
 * have started getting undefined with no failure anywhere in this package.
 *
 * These pin both halves — envelope out of service.find(), rows out of the
 * stores — against a stub that returns exactly what the real client returns.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

// The shape the real Junction client hands back from find(), verbatim.
const envelope = (rows) => ({
  kind:   'list',
  object: 'leads',
  data:   rows,
  errors: [],
  total:  rows.length + 100,   // deliberately != data.length, so a pass-through
  limit:  rows.length,          // that silently substituted data.length is caught
  offset: 0,
})

const ROWS = [{ id: '1', name: 'Ada' }, { id: '2', name: 'Grace' }]

let _proxy

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      // Junction's own resource().load() takes .data off the envelope before
      // touching the store — mirror that here.
      load: async (query, params) => (await _proxy.find(query, params)).data,
    }),
  }),
}))

const { createResource, createStore } = await import('../src/junction/resource.js')

beforeEach(() => {
  _proxy = {
    find:    async () => envelope(ROWS),
    get:     async (id) => ({ id, name: 'Ada' }),
    create:  async (data) => ({ id: '9', ...data }),
    patch:   async (id, data) => ({ id, ...data }),
    remove:  async (id) => ({ id, name: 'Ada' }),
    restore: async (id) => ({ id, name: 'Ada' }),
    on:      () => {},
    call:    async () => ({}),
  }
})

describe('service methods pass Junction shapes through unchanged', () => {

  test('find() yields the list envelope, not a bare array', async () => {
    const { service } = createResource('leads')
    const res = await service.find({})

    expect(Array.isArray(res)).toBe(false)
    expect(res.kind).toBe('list')
    expect(res.data).toEqual(ROWS)
  })

  test('find() preserves the pagination metadata', async () => {
    const { service } = createResource('leads')
    const res = await service.find({})

    expect(res.total).toBe(102)
    expect(res.offset).toBe(0)
    expect(res.object).toBe('leads')
  })

  test('getOptions() is a find, so it is an envelope too', async () => {
    const { service } = createResource('leads')
    expect((await service.getOptions()).kind).toBe('list')
  })

  test('single-record methods yield the record, not an envelope', async () => {
    const { service } = createResource('leads')

    expect(await service.get('1')).toEqual({ id: '1', name: 'Ada' })
    expect(await service.create({ name: 'Hopper' })).toEqual({ id: '9', name: 'Hopper' })
    expect(await service.patch('1', { name: 'Byron' })).toEqual({ id: '1', name: 'Byron' })
    expect(await service.remove('1')).toEqual({ id: '1', name: 'Ada' })
    expect(await service.restore('1')).toEqual({ id: '1', name: 'Ada' })
  })

  test('after hooks see the envelope on find and the record on get', async () => {
    const seen = {}
    const { service } = createResource('leads', {
      hooks: {
        after: {
          find: [ctx => { seen.find = ctx.result }],
          get:  [ctx => { seen.get  = ctx.result }],
        },
      },
    })
    await service.find({})
    await service.get('1')

    expect(seen.find.kind).toBe('list')
    expect(seen.get).toEqual({ id: '1', name: 'Ada' })
  })
})

describe('stores hold rows, never envelopes', () => {

  test('load() resolves to the rows', async () => {
    const { load } = createResource('leads')
    const rows = await load({})

    expect(Array.isArray(rows)).toBe(true)
    expect(rows).toEqual(ROWS)
  })

  test('createStore().find() leaves rows in the store', async () => {
    const { service } = createResource('leads')
    const store = createStore(service)
    await store.find({})

    expect(Array.isArray(store.get())).toBe(true)
    expect(store.get()).toEqual(ROWS)
  })

  test('createStore() still accepts a service that returns a bare array', async () => {
    // Not every service is a Junction model service — a custom action or a
    // hand-rolled proxy may return rows directly. The store must not turn that
    // into an empty list.
    const { service } = createResource('leads')
    const store = createStore({ ...service, find: async () => ROWS })
    await store.find({})

    expect(store.get()).toEqual(ROWS)
  })
})
