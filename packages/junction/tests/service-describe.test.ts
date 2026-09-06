// tests/service-describe.test.ts — one source, four readers.
//
// /manifest, the OpenAPI generator and /metrics each used to reach into
// `_meta`, `_schemas`, `_hookMap` and the action rule directly, through casts.
// Three readers of four internals is three chances to describe a different
// service than the one that answers the request — and /metrics did exactly that
// for custom methods, reporting `[]` for every service while /manifest listed them.
//
// describe() is the one answer now. These assert the readers agree with it
// rather than restating what each should say.

import { describe, test, expect } from 'bun:test'
import { createService, createBaseService, isBuiltService } from '../src/core/service.ts'
import { createTestApp, request } from '../src/testing/index.ts'
import { manifestPlugin } from '../src/plugins/manifest/index.ts'
import { healthPlugin } from '../src/transport/health.ts'
import { openapi } from '../src/plugins/openapi/index.ts'

const noop = async () => ({ ok: true })

function mkService() {
  return createService({
    name:       'widgets',
    model:      'Widget',
    methods:    ['find', 'get', 'create', 'reboot'],
    softDelete: 'deletedAt',
    idField:    'ref',
    allowBulk:  true,
    async find() { return [] },
    async get()  { return { ref: '1' } },
    reboot: noop,
    prune:  noop,          // exists, undeclared
    hooks:  { before: { find: [function mine() {}] } },
  })
}

describe('describe()', () => {

  test('reports the service as configured', () => {
    const d = mkService().describe()
    expect(d.name).toBe('widgets')
    expect(d.model).toBe('Widget')
    expect(d.customMethods).toEqual(['reboot'])
    expect(d.methods).toEqual(['find', 'get', 'create', 'reboot'])
    expect(d.softDelete).toBe('deletedAt')
    expect(d.idField).toBe('ref')
    expect(d.allowBulk).toBe(true)
    expect(d.hooks.before?.find?.some(h => h.name === 'mine')).toBe(true)
  })

  test('a plain service reports the defaults rather than undefined', () => {
    const d = createService({ name: 'plain', model: 'plain' }).describe()
    expect(d.softDelete).toBeNull()
    expect(d.cache).toBe(false)
    expect(d.idField).toBe('id')
    expect(d.customMethods).toEqual([])
  })

  test('/manifest, /metrics and the OpenAPI spec all agree with it', async () => {
    const app = await createTestApp({ services: [mkService] })
    app.configure(manifestPlugin())
    app.configure(healthPlugin())
    const spec = openapi({ title: 'T', version: '1' })
    await spec.register!(app)

    const d = app.services.get('widgets')!.describe()

    const manifest = (await request(app).get('/manifest')).body as {
      services: { name: string; methods: string[]; softDelete: boolean; idField: string }[]
    }
    const metrics = (await request(app).get('/metrics')).body as {
      services: { details: Record<string, { customMethods: string[]; methods: string[]; allowBulk: boolean }> }
    }
    const oa = (await request(app).get('/openapi.json')).body as { paths: Record<string, unknown> }

    const m = manifest.services.find(s => s.name === 'widgets')!
    expect(m.methods).toEqual(d.methods)
    expect(m.idField).toBe(d.idField)
    expect(m.softDelete).toBe(!!d.softDelete)

    expect(metrics.services.details.widgets!.customMethods).toEqual(d.customMethods)
    expect(metrics.services.details.widgets!.methods).toEqual(d.methods)
    expect(metrics.services.details.widgets!.allowBulk).toBe(d.allowBulk)

    // A custom method is named in the `X-Service-Method` enum rather than in a
    // path, because the path form was one the wire does not serve. Asked of the
    // whole document, which is stronger than asking the path keys: `prune` must
    // appear NOWHERE, not merely in no path.
    const doc = JSON.stringify(oa)
    for (const a of d.customMethods) expect(doc).toContain(a)
    expect(doc).not.toContain('prune')
  })
})

describe('the built-service marker', () => {

  test('createService is idempotent — building twice returns the same object', () => {
    const once  = createService({ name: 'things', model: 'thing', reboot: noop })
    const twice = createService(once as never)
    expect(twice).toBe(once)
  })

  test('a base is not marked, so the loader still wraps it', () => {
    expect(isBuiltService(createBaseService({ model: 'thing' }))).toBe(false)
    expect(isBuiltService(createService({ name: 'things', model: 'thing' }))).toBe(true)
  })

  test('a SPREAD copy is not a built service', () => {
    // The marker is non-enumerable on purpose: `{...svc}` is a copy of the
    // fields, not a service, and wrapping it is the right call.
    const svc  = createService({ name: 'things', model: 'thing', reboot: noop })
    const copy = { ...svc }
    expect(isBuiltService(copy)).toBe(false)
    expect(isBuiltService(createService(copy as never))).toBe(true)
  })
})
