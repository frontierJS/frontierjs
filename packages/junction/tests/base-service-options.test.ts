// tests/base-service-options.test.ts
//
// createBaseService used to destructure only { model, db, paginate, allowBulk }
// and return the seven CRUD methods, dropping everything else. That made the
// documented service shape silently wrong:
//
//   export default createBaseService({
//     name:  'leads',
//     model: 'lead',
//     hooks: { before: { create: [authenticate] } },
//   })
//
// It type-checked. The loader registered it — deriving the name from the
// filename — and it served requests. With no hooks. For `authenticate` that is
// an authorization hole that produces no error, no warning, and a service that
// looks correct in review.
//
// Only the spread form worked:
//
//   export default { ...createBaseService({ model: 'lead' }), hooks: {...} }
//
// because the loader reads hooks off the object you export, via
// createService({ name: deriveName(filename), ...service }).
//
// Both forms work now. These tests pin that, and pin the things that must NOT
// leak onto the service alongside it.

import { describe, test, expect } from 'bun:test'
import { createBaseService } from '../src/core/service.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const authenticate = () => {}
const CRUD = ['find', 'get', 'create', 'update', 'patch', 'remove', 'restore'] as const

describe('createBaseService — option pass-through', () => {

  test('carries name through', () => {
    const svc = createBaseService({ name: 'leads', model: 'lead' })
    expect(svc.name).toBe('leads')
  })

  test('carries hooks through', () => {
    const svc = createBaseService({
      model: 'lead',
      hooks: { before: { create: [authenticate] } },
    })
    // The user's hook survives AND runs first. createBaseService appends the
    // hooks derived from the model — gateAuth(@@gate) + autoValidate(field
    // rules) — after it, so a before/create hook can still shape ctx.data
    // before validation sees it. (See CHANGES.md "Authentication is derived
    // from @@gate".) This asserted length 1 back when no derived layer existed.
    const create = svc.hooks?.before?.create
    expect(create?.[0]).toBe(authenticate)
    expect(create!.length).toBeGreaterThan(1)
  })

  test('still returns every CRUD method', () => {
    const svc = createBaseService({ name: 'leads', model: 'lead', hooks: {} })
    for (const m of CRUD) expect(typeof (svc as Record<string, unknown>)[m]).toBe('function')
  })

  test('carries custom methods through', () => {
    const summary = async (_ctx: ServiceContext) => ({ ok: true })
    const svc = createBaseService({ model: 'lead', summary })
    expect((svc as Record<string, unknown>).summary).toBe(summary)
  })
})

describe('createBaseService — what must not leak', () => {

  test('omitting name adds no name key', () => {
    // An explicit `name: undefined` would override the loader's
    // filename-derived name with nothing.
    const svc = createBaseService({ model: 'lead' })
    expect('name' in svc).toBe(false)
  })

  test('omitting hooks still yields the derived hook layer, as data not a function', () => {
    // Originally asserted `'hooks' in svc === false`. A model service now
    // ALWAYS carries the derived gateAuth + autoValidate layer, so the key is
    // always present — that layer is the point, and omitting `hooks:` must not
    // opt out of it. What still matters is the loader's branch:
    // `typeof service.hooks !== 'function'` distinguishes a HookMap (config to
    // merge) from a built service's `.hooks(map)` registration method.
    const svc = createBaseService({ model: 'lead' })
    expect(typeof svc.hooks).not.toBe('function')
    expect(svc.hooks?.before?.create?.length).toBeGreaterThan(0)
  })

  test('reserved options are not exposed as service methods', () => {
    const svc = createBaseService({
      model:     'lead',
      db:        () => ({}),
      allowBulk: true,
      paginate:  { default: 5, max: 10 },
    }) as Record<string, unknown>

    // The invariant that matters: no config key may become CALLABLE. `db` is a
    // function, so without the reserved-key check it would be picked up as a
    // custom method and served over HTTP. (allowBulk is deliberately carried
    // through as a value — createService and the loader read it back off the
    // base — so assert on callability, not on absence.)
    expect(typeof svc.db).not.toBe('function')
    expect(typeof svc.allowBulk).not.toBe('function')
    expect(typeof svc.paginate).not.toBe('function')
  })

  test('non-function options are not treated as methods', () => {
    const svc = createBaseService({
      model: 'lead',
      label: 'not a method',
    }) as Record<string, unknown>
    expect(typeof svc.label).not.toBe('function')
  })
})

describe('createBaseService — the spread form still works', () => {

  test('spread values win over anything the base returned', () => {
    const svc = {
      ...createBaseService({ name: 'ignored', model: 'lead' }),
      name:  'leads',
      hooks: { before: { find: [authenticate] } },
    }
    expect(svc.name).toBe('leads')
    expect(svc.hooks.before.find).toHaveLength(1)
    for (const m of CRUD) expect(typeof (svc as Record<string, unknown>)[m]).toBe('function')
  })
})
