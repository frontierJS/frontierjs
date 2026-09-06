// tests/service-custom-methods.test.ts — a custom method is declared, or
// scanned for, ONCE.
//
// "Is this key an option or an action" used to be answered by exclusion — a
// function whose key is in neither reserved set — and six consumers re-applied
// that rule: dispatch twice, the method policy, /manifest, the OpenAPI spec and
// /metrics. The deny-lists had already drifted across five copies once.
//
// It is answered at construction now and lands in `_customMethods`; everything else
// reads the table. `methods:` DECLARES, which is what makes an action nameable
// after an option key — `async cache(ctx)` was previously eaten as config with
// no error at any point.

import { describe, test, expect } from 'bun:test'
import { createService, createBaseService, collectCustomMethods, customMethodNames, allowedMethodNames, callService } from '../src/core/service.ts'
import { resultData } from '../src/core/envelope.ts'
import { createTestApp, request } from '../src/testing/index.ts'
import { manifestPlugin } from '../src/plugins/manifest/index.ts'
import { openapi } from '../src/plugins/openapi/index.ts'
import { healthPlugin } from '../src/transport/health.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const noop = async () => ({ ok: true })

function ctx(over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'things', method: 'find', id: undefined, data: null,
    params: {}, query: {}, auth: {}, client: {}, locals: {}, app: {}, result: null,
    ...over,
  } as unknown as ServiceContext
}

// ─── the table ────────────────────────────────────────────────────────────

describe('the action table', () => {

  test('scanned: inline function keys, and nothing else', () => {
    const svc = createService({
      name: 'things', model: 'thing',
      channel: 'things',                 // an option, not an action
      allowBulk: true,
      reboot: noop,
      drain:  noop,
    })
    expect(customMethodNames(svc).sort()).toEqual(['drain', 'reboot'])
  })

  test('CRUD, the bypass twins and the internals never enter it', () => {
    const svc = createService({ name: 'things', model: 'thing', reboot: noop })
    const keys = customMethodNames(svc)
    for (const k of ['find', 'get', 'create', 'update', 'patch', 'remove', 'restore',
                     '_find', '_get', '_hookMap', '_meta', '_customMethods', 'hooks', 'name', 'model']) {
      expect(keys).not.toContain(k)
    }
  })

  test('declared: `methods:` says what the custom methods are', () => {
    const svc = createService({
      name: 'things', model: 'thing',
      methods: ['find', 'get', 'reboot'],
      reboot: noop,
      drain:  noop,            // present, undeclared — not offered
    })
    expect(customMethodNames(svc)).toEqual(['reboot'])
  })

  test('a `channel` FUNCTION is an option, not an action', () => {
    // publish accepts a function, so the scan has to keep letting the deny-list
    // win here — this is the case the list was widened for.
    const svc = createService({
      name: 'things', model: 'thing',
      channel: () => 'things',
    })
    expect(customMethodNames(svc)).toEqual([])
  })

  test('an action may NOT be named after an option key, declared or not', () => {
    // This used to assert the opposite, and the capability it claimed was
    // measured false (`FJS-942`): declaring `cache` put the name in the table
    // and in `describe().methods`, so it was routed and advertised — while
    // `app.service('reports').cache` stayed undefined, `describe().cache`
    // answered false, and `if (def.cache)` read the FUNCTION as a truthy cache
    // declaration and cached find and get. One name, three answers.
    const scanned = createService({
      name: 'reports', model: 'report',
      cache: (async () => ({ warmed: true })) as never,
    })
    expect(customMethodNames(scanned)).toEqual([])       // eaten as config, as before

    const findings: string[] = []
    const declared = createService({
      name: 'reports', model: 'report',
      methods: ['find', 'cache'],
      cache: (async () => ({ warmed: true })) as never,
    })
    for (const f of (declared as { _authoringFindings?: string[] })._authoringFindings ?? [])
      findings.push(f)
    expect(customMethodNames(declared)).toEqual([])
    expect(findings.join('\n')).toContain('is a service OPTION and cannot also be a method')

    // The control, one name away: a name that is NOT an option is a method,
    // which is what stops the refusal being "declaring never works".
    const fine = createService({
      name: 'reports', model: 'report',
      methods: ['find', 'warm'], warm: noop,
    })
    expect(customMethodNames(fine)).toEqual(['warm'])
    expect((fine as { _authoringFindings?: string[] })._authoringFindings).toEqual([])
  })

  test('a declared name with no function is REPORTED, naming what IS available', () => {
    // Reported rather than thrown at construction: an app has a config, N
    // service files and a hook table, and start()'s `check-authoring` phase
    // refuses with every finding at once (`FJS-D199`).
    const svc = createService({ name: 'things', model: 'thing', methods: ['find', 'rebot'], reboot: noop })
    const msg = ((svc as { _authoringFindings?: string[] })._authoringFindings ?? []).join('\n')
    expect(msg).toContain("'rebot'")
    expect(msg).toContain('not defined')
    expect(msg).toContain('reboot')          // the name they meant
    // And it is left OUT of the table — it is a 405 either way, and shipping
    // the name would be the wrong half of the answer. `reboot` is not there
    // either: a declared list is the whole offer, which the undeclared-function
    // case above already pins.
  })

  test('a declared name that is a non-function option says a name cannot be both', () => {
    const svc = createService({ name: 'things', model: 'thing', methods: ['find', 'cache'], cache: true })
    const msg = ((svc as { _authoringFindings?: string[] })._authoringFindings ?? []).join('\n')
    expect(msg).toContain("'cache'")
    expect(msg).toContain('cannot be both')
  })

  test("'readOnly' narrows what is OFFERED, not what exists", () => {
    // The action stays in the table and the policy refuses it — 405, not 404,
    // which is the distinction method-policy.test.ts pins. A service that
    // pretended the method did not exist would be lying about its own shape.
    const svc = createService({ name: 'audit', model: 'audit', methods: 'readOnly', purge: noop })
    expect(customMethodNames(svc)).toEqual(['purge'])
    expect(allowedMethodNames(svc)).toEqual(['find', 'get'])
  })

  test('collectCustomMethods is callable on a bare object — the one parse step', () => {
    expect(Object.keys(collectCustomMethods({ reboot: noop, name: 'x' }, 'things'))).toEqual(['reboot'])
    expect(Object.keys(collectCustomMethods({ reboot: noop }, 'things', ['find', 'reboot']))).toEqual(['reboot'])
  })
})

// ─── the loader's spread ──────────────────────────────────────────────────

describe('a base reached through the loader keeps its custom methods', () => {

  test('the table survives the spread + re-wrap', () => {
    const base = createBaseService({ model: 'thing', reboot: noop } as never)
    const svc  = createService({ name: 'things', ...(base as object) } as never)
    expect(customMethodNames(svc)).toEqual(['reboot'])
  })

  test('and the action is still callable', async () => {
    const base = createBaseService({ model: 'thing', reboot: noop } as never)
    const svc  = createService({ name: 'things', ...(base as object) } as never)
    const c    = ctx({ service: 'things', method: 'reboot' })
    await callService(svc, c)
    expect(resultData(c.result)).toEqual({ ok: true })
  })
})

// ─── dispatch reads the table ─────────────────────────────────────────────

describe('dispatch', () => {

  test('an action in the table dispatches', async () => {
    const svc = createService({ name: 'things', model: 'thing', reboot: noop })
    const c   = ctx({ service: 'things', method: 'reboot' })
    await callService(svc, c)
    expect(resultData(c.result)).toEqual({ ok: true })
  })

  test('a name in neither the table nor the object is a 404', async () => {
    const svc = createService({ name: 'things', model: 'thing', reboot: noop })
    const err = await callService(svc, ctx({ service: 'things', method: 'nope' })).catch(e => e)
    expect((err as Error).message).toContain("'nope'")
  })

  test('an action attached AFTER construction does not dispatch (FJS-690)', async () => {
    // The table is the whole answer. While an own key was a fallback,
    // `X-Service-Method` was an allow-list written as a block-list — six CRUD
    // names refused and every other own function callable, `_create` and
    // `pipelines` included.
    const svc = createService({ name: 'things', model: 'thing' })
    ;(svc as unknown as Record<string, unknown>).late = noop

    const err = await callService(svc, ctx({ service: 'things', method: 'late' })).catch(e => e)
    expect((err as { code?: number }).code).toBe(404)
    expect((err as Error).message).toContain("'late'")
  })

  test('the internals are not methods (FJS-690)', async () => {
    // Each of these resolved to a function before the table became the only
    // answer: two skip the derived hooks, two describe the service, and the
    // last two are Object.prototype's, reached because the table is an object
    // literal and bare indexing walks the prototype chain.
    const svc = createService({ name: 'things', model: 'thing', reboot: noop })
    for (const method of ['_create', '_find', 'describe', 'pipelines', 'hooks', 'constructor', 'toString', '__proto__']) {
      const err = await callService(svc, ctx({ service: 'things', method })).catch(e => e)
      expect([404, 405]).toContain((err as { code?: number }).code ?? 0)
      expect((err as Error).message).toContain(method)
    }
  })
})

// ─── one fixture, three readers ───────────────────────────────────────────

describe('what the app advertises comes from the same table', () => {

  test('/manifest, the OpenAPI spec and /metrics agree', async () => {
    const app = await createTestApp({
      services: [() => createService({
        name: 'things', model: 'thing',
        methods: ['find', 'get', 'reboot', 'drain'],
        async find() { return [] },
        async get()  { return { id: '1' } },
        reboot: noop,
        drain:  noop,
        prune:  noop,          // present, undeclared — must appear nowhere
      })],
    })
    app.configure(manifestPlugin())
    app.configure(healthPlugin())
    const spec = openapi({ title: 'T', version: '1' })
    await spec.register!(app)

    const manifest = (await request(app).get('/manifest')).body as {
      services: { name: string; methods: string[] }[]
    }
    const metrics = (await request(app).get('/metrics')).body as {
      services: { details: Record<string, { customMethods: string[] }> }
    }
    const oa = (await request(app).get('/openapi.json')).body as { paths: Record<string, unknown> }

    const fromManifest = manifest.services.find(s => s.name === 'things')!.methods
    const fromMetrics  = metrics.services.details.things!.customMethods

    expect(fromMetrics.sort()).toEqual(['drain', 'reboot'])
    expect(fromManifest).toContain('reboot')
    expect(fromManifest).not.toContain('prune')

    // In the `X-Service-Method` enum now, not in a path of its own — the path
    // form answered 404. The whole document is searched, so an undeclared
    // method appearing anywhere at all fails.
    const doc = JSON.stringify(oa)
    expect(doc).toContain('reboot')
    expect(doc).not.toContain('prune')
  })
})
