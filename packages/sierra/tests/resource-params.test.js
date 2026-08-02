/**
 * tests/resource-params.test.js
 *
 * createResource wraps a Junction service proxy in the 4-phase hook pipeline.
 * Its find/get signatures mirror Junction's — `(query, params)` where params is
 * a FindParams: { limit, offset, orderBy, select }. That second argument used to
 * be accepted and dropped: _call took only a query and called `proxy.find(query)`
 * with no params at all. Every list paged through a resource silently came back
 * as the server's default page, in the server's default order.
 *
 * These tests pin the threading — resource → proxy — and the hook seam that lets
 * a before-hook set pagination.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

// getClient lives in the package entry, which pulls in the Mesa runtime and the
// router. The resource factory only needs the client, so stub the module.
const _calls = []
let _proxy

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: (name, idField) => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: (query, params) => {
        _calls.push(['load', query, params])
        return Promise.resolve([])
      },
    }),
  }),
}))

const { createResource, createStore } = await import('../src/junction/resource.js')

beforeEach(() => {
  _calls.length = 0
  _proxy = {
    find:    (query, params) => { _calls.push(['find', query, params]);   return Promise.resolve([]) },
    get:     (id, params)    => { _calls.push(['get', id, params]);       return Promise.resolve({}) },
    create:  (data)          => { _calls.push(['create', data]);          return Promise.resolve(data) },
    patch:   (id, data)      => { _calls.push(['patch', id, data]);       return Promise.resolve(data) },
    remove:  (id)            => { _calls.push(['remove', id]);            return Promise.resolve({}) },
    restore: (id)            => { _calls.push(['restore', id]);           return Promise.resolve({}) },
    on:      () => {},
    call:    () => Promise.resolve(),
  }
})

describe('FindParams threading', () => {

  test('find() forwards params to the service proxy', async () => {
    const { service } = createResource('leads')
    await service.find({ status: 'new' }, { limit: 50, offset: 100, orderBy: 'name' })

    expect(_calls[0]).toEqual([
      'find',
      { status: 'new' },
      { limit: 50, offset: 100, orderBy: 'name' },
    ])
  })

  test('get() forwards params to the service proxy', async () => {
    const { service } = createResource('leads')
    await service.get('lead-1', { select: ['id', 'name'] })

    expect(_calls[0]).toEqual(['get', 'lead-1', { select: ['id', 'name'] }])
  })

  test('omitting params sends an empty object, never undefined', async () => {
    const { service } = createResource('leads')
    await service.find({ status: 'new' })

    expect(_calls[0][2]).toEqual({})
  })

  test('getOptions() falls back to optionsQuery.params', async () => {
    const { service } = createResource({
      service: 'categories',
      optionsQuery: { query: { active: true }, params: { orderBy: 'name', limit: 500 } },
    })
    await service.getOptions()

    expect(_calls[0]).toEqual([
      'find',
      { active: true },
      { orderBy: 'name', limit: 500 },
    ])
  })

  test('an explicit getOptions() argument overrides optionsQuery', async () => {
    const { service } = createResource({
      service: 'categories',
      optionsQuery: { query: { active: true }, params: { limit: 500 } },
    })
    await service.getOptions({ active: false }, { limit: 10 })

    expect(_calls[0]).toEqual(['find', { active: false }, { limit: 10 }])
  })

  test('createStore().find() threads params through to the proxy', async () => {
    const { service } = createResource('leads')
    const store = createStore(service)
    await store.find({ type: 'client' }, { limit: 25 })

    expect(_calls[0]).toEqual(['find', { type: 'client' }, { limit: 25 }])
  })
})

describe('findParams on the hook context', () => {

  test('a before hook can set pagination', async () => {
    const { service } = createResource('leads', {
      hooks: { before: { find: [ctx => { ctx.findParams.limit = 50 }] } },
    })
    await service.find({})

    expect(_calls[0][2]).toEqual({ limit: 50 })
  })

  test('ctx.params stays client-side — it never reaches the proxy', async () => {
    const seen = []
    const { service } = createResource('leads', {
      hooks: {
        before: { find: [ctx => { ctx.params.loading = true }] },
        after:  { find: [ctx => { seen.push(ctx.params.loading) }] },
      },
    })
    await service.find({ status: 'new' })

    expect(seen).toEqual([true])
    expect(_calls[0][1]).toEqual({ status: 'new' })  // query — unpolluted
    expect(_calls[0][2]).toEqual({})                 // findParams — unpolluted
  })
})
