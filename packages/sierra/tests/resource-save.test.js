/**
 * tests/resource-save.test.js
 *
 * `save()` is the one owner of "write this record" (`FJS-D114`). Every caller
 * that used to answer create-or-patch for itself — `<Form>`, a hand-written
 * button, the generated CRUD page — asks the resource instead, because the
 * question is about the MODEL's id field and only the resource knows it. A
 * caller answering it with the literal `id` on a model keyed by anything else
 * creates a duplicate row while looking like an edit (`FJS-316`).
 *
 * `detailQuery` is the read half of the same argument: the include/select shape
 * a detail view needs, declared once beside the model rather than at 80 call
 * sites.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

const _calls = []
let _proxy

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: () => _proxy,
    resource: () => ({
      service: _proxy,
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: () => Promise.resolve([]),
    }),
  }),
}))

const { createResource } = await import('../src/junction/resource.js')

beforeEach(() => {
  _calls.length = 0
  _proxy = {
    find:    (query, params) => { _calls.push(['find', query, params]); return Promise.resolve([]) },
    get:     (id, params)    => { _calls.push(['get', id, params]);     return Promise.resolve({}) },
    create:  (data)          => { _calls.push(['create', data]);        return Promise.resolve(data) },
    patch:   (id, data)      => { _calls.push(['patch', id, data]);     return Promise.resolve(data) },
    remove:  (id)            => { _calls.push(['remove', id]);          return Promise.resolve({}) },
    restore: (id)            => { _calls.push(['restore', id]);         return Promise.resolve({}) },
    upsert:  (data)          => { _calls.push(['upsert', data]);        return Promise.resolve(data) },
    on:      () => {},
    call:    () => Promise.resolve(),
  }
})

describe('save() decides create vs patch', () => {

  test('no id → create', async () => {
    const leads = createResource('leads')
    await leads.save({ name: 'Ada' })

    expect(_calls[0]).toEqual(['create', { name: 'Ada' }])
  })

  test('id present → patch, addressed by that id', async () => {
    const leads = createResource('leads')
    await leads.save({ id: 7, name: 'Ada' })

    expect(_calls[0]).toEqual(['patch', 7, { id: 7, name: 'Ada' }])
  })

  test('the id field is the MODEL\'s, not the literal `id`', async () => {
    const lenses = createResource('lenses', { model: 'Lens', idField: 'sku' })
    await lenses.save({ sku: 'AB-1', name: 'Wide' })

    // The defect this closes: keyed off `id`, this row has none, so it would
    // have been created a second time.
    expect(_calls[0]).toEqual(['patch', 'AB-1', { sku: 'AB-1', name: 'Wide' }])
  })

  test('a stated mode wins over the id', async () => {
    const leads = createResource('leads')
    await leads.save({ id: 7, name: 'Ada' }, { mode: 'create' })

    expect(_calls[0][0]).toBe('create')
  })

  test('`upsert` is an alias of `auto`, never a service method', async () => {
    const leads = createResource('leads')
    await leads.save({ id: 7, name: 'Ada' }, { mode: 'upsert' })
    await leads.save({ name: 'Grace' },      { mode: 'upsert' })

    expect(_calls.map(c => c[0])).toEqual(['patch', 'create'])
  })

  test('the record handed in is not modified', async () => {
    // A form is still editing that object while the request is in flight: the
    // pipeline coerces, blank-strips and stamps a version on the way out, and
    // every one of those has to land on a copy. Asserted on the live object
    // rather than on anything rendered from it — an in-place mutation changes
    // no binding, so a check that reads a rendered copy passes against the
    // mutation it exists to refuse.
    const leads = createResource('leads')
    const record = { id: 7, name: 'Ada', tags: ['x'] }
    const before = JSON.stringify(record)

    await leads.save(record)

    expect(JSON.stringify(record)).toBe(before)
  })

  test('the row the server answered comes back', async () => {
    const leads = createResource('leads')
    const row   = await leads.save({ name: 'Ada' })

    expect(row).toEqual({ name: 'Ada' })
  })
})

describe('detailQuery — the read shape declared beside the model', () => {

  test('get() with no directives uses the declared ones', async () => {
    const leads = createResource('leads', {
      detailQuery: { directives: { select: ['id', 'name'], populate: ['company'] } },
    })
    await leads.service.get(3)

    expect(_calls[0]).toEqual(['get', 3, { select: ['id', 'name'], populate: ['company'] }])
  })

  test('a caller who states directives wins', async () => {
    const leads = createResource('leads', {
      detailQuery: { directives: { select: ['id', 'name'] } },
    })
    await leads.service.get(3, { select: ['id'] })

    expect(_calls[0]).toEqual(['get', 3, { select: ['id'] }])
  })

  test('a resource declaring none is unchanged', async () => {
    const leads = createResource('leads')
    await leads.service.get(3)

    expect(_calls[0]).toEqual(['get', 3, {}])
  })
})
