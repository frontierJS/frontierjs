// test/base-service-options.test.ts
//
// buildBase is buildService's CRUD layer and nothing more: the generated
// methods, the merged hook map and the metadata buildService reads. It is not a
// service definition, so an option it was handed (a name, a channel, a custom
// method) never rides its return (FJS-2995, FJS-D1079).

import { describe, test, expect } from 'bun:test'
import { buildBase, requiredScope, scopeRefusal, buildService } from '../src/core/service.ts'

const authenticate = () => {}
const CRUD = ['find', 'get', 'create', 'update', 'patch', 'remove', 'restore'] as const

describe('buildBase — option pass-through', () => {

  test('carries hooks through', () => {
    const svc = buildBase({
      model: 'lead',
      hooks: { before: { create: [authenticate] } },
    })
    // The user's hook survives and still leads the before chain, with
    // autoValidate behind it — a before/create hook shapes ctx.data before
    // validation sees it. The gate is an around hook now and is not in this
    // list at all (FJS-403). This asserted length 1 back when no derived layer
    // existed.
    const create = svc.hooks?.before?.create
    expect(create?.[0]).toBe(authenticate)
    expect(create!.length).toBeGreaterThan(1)
    expect((svc.hooks?.around?.all ?? []).map(h => h.name)).toEqual(['gateAuth'])
  })

  test('still returns every CRUD method', () => {
    const svc = buildBase({ name: 'leads', model: 'lead', hooks: {} })
    for (const m of CRUD) expect(typeof (svc as Record<string, unknown>)[m]).toBe('function')
  })


  test('scope declared on a definition reaches what the built service grades', () => {
    // Dropped, it fails closed: every scoped key refused at every method.
    const built = buildService({ name: 'leads', model: 'lead', scope: 'crm' })
    expect(requiredScope(built, 'find')).toBe('crm')
    expect(scopeRefusal(built, 'find', { scopes: ['crm'] })).toBeNull()
  })
})

describe('buildBase — the hook map', () => {

  test('omitting hooks still yields the derived hook layer, as data not a function', () => {
    const svc = buildBase({ model: 'lead' })
    expect(typeof svc.hooks).not.toBe('function')
    expect(svc.hooks?.before?.create?.length).toBeGreaterThan(0)
  })
})

describe('buildBase — returns only what buildService reads', () => {

  test('an option it was handed does not ride the return — only the CRUD, hooks and _meta do', () => {
    const svc = buildBase({
      name:       'leads',
      model:      'lead',
      paginate:   { default: 5, max: 10 },
      allowBulk:  true,
      bulkMax:    50,
      idField:    'uid',
      softDelete: 'deleted_at',
    })
    expect(Object.keys(svc).sort()).toEqual(
      [...CRUD, 'aggregate', 'declaredFields', 'hooks', '_meta'].sort())
  })
})
