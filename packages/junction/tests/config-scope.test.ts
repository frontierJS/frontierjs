/**
 * tests/config-scope.test.ts — configuration read at CALL scope (`FJS-D126`, the
 * read half).
 *
 * There is no resolver behind this yet and that is the point: `$.config` and
 * `app.configFor()` answer `app.config` for every caller, identically, so an app
 * adopting them changes nothing today and becomes tenant-aware for free once the
 * source is ruled.
 *
 * So what these grade is not *what value comes back* — it is the two properties
 * that make the boundary safe to fill in later: the read goes through one owner,
 * and the view CANNOT be written. Every mature implementation of per-tenant
 * config rebinds a global instead and pays for it with a rule that each
 * singleton must save the central value before the rebind. A view that could be
 * written is that rebind wearing a different word.
 */

import { describe, test, expect } from 'bun:test'

import { createApp }              from '../src/core/app.ts'
import { $, enterCall }           from '../src/core/context.ts'
import { readOnlyConfig }         from '../src/core/config-scope.ts'
import { withLitestoneDb }        from '../src/core/litestone.ts'

const build = () => createApp({ config: { name: 'shop', version: '2.1.0', http: { cors: { origin: 'https://a.test' } } } as never })

describe('app.configFor()', () => {
  test('answers the floor with no resolver behind it — adoption changes nothing', () => {
    const app = build()
    expect(app.configFor().name).toBe('shop')
    expect(app.configFor().version).toBe('2.1.0')
    expect(app.configFor('any-tenant').name).toBe('shop')
  })

  test('is reachable with no service call, which is the half `$` refuses', () => {
    const app = build()
    expect(() => $.config).toThrow(/outside a service call/)
    expect(app.configFor().name).toBe('shop')          // same question, no call
  })
})

describe('the view is read-only, deep', () => {
  test('a top-level write throws by name rather than landing', () => {
    const app = build()
    expect(() => { (app.configFor() as { name: string }).name = 'other' })
      .toThrow(/\$\.config\.name' cannot be assigned/)
    expect(app.config.name).toBe('shop')               // and nothing moved
  })

  test('a NESTED write throws too — the shallow version admits the one people write', () => {
    const app = build()
    const cfg = app.configFor() as unknown as { http: { cors: { origin: string } } }
    expect(() => { cfg.http.cors.origin = 'https://evil.test' })
      .toThrow(/cannot be assigned/)
    expect((app.config as unknown as { http: { cors: { origin: string } } }).http.cors.origin)
      .toBe('https://a.test')
  })

  test('delete and defineProperty are refused on the same ground', () => {
    const app = build()
    const cfg = app.configFor() as unknown as Record<string, unknown>
    expect(() => { delete cfg.name }).toThrow(/cannot be assigned/)
    expect(() => Object.defineProperty(cfg, 'name', { value: 'x' })).toThrow(/cannot be assigned/)
  })

  test('the refusal names the ways in, because a read-only error with no next step is a dead end', () => {
    const app = build()
    let msg = ''
    try { (app.configFor() as { name: string }).name = 'x' } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('junction.config.js')
    expect(msg).toContain('createApp({ config })')
    expect(msg).toContain('FJS-D126')
  })

  test('boot-time writes to app.config still work — the view is the read, not a freeze', () => {
    const app = build()
    ;(app.config as { name: string }).name = 'renamed at boot'
    expect(app.configFor().name).toBe('renamed at boot')
  })
})

describe('the view is stable', () => {
  test('two reads answer the same object, so `===` still holds on a hot path', () => {
    const app = build()
    expect(app.configFor()).toBe(app.configFor())
    const a = app.configFor() as unknown as { http: unknown }
    expect(a.http).toBe((app.configFor() as unknown as { http: unknown }).http)
  })

  test('readOnlyConfig leaves a non-object value alone, functions included', () => {
    const fn = () => 'kept'
    const view = readOnlyConfig({ n: 1, s: 'x', f: fn, nil: null } as Record<string, unknown>)
    expect(view.n).toBe(1)
    expect(view.s).toBe('x')
    expect(view.nil).toBeNull()
    // A function on a config object is a callback the app supplied; wrapping it
    // would change its identity for a caller comparing it.
    expect(view.f).toBe(fn)
  })
})

describe('$.config — the ambient read', () => {
  const inCall = <T>(app: unknown, locals: Record<string, unknown>, fn: () => T): T =>
    enterCall({ app, locals, auth: { user: null }, client: {}, route: {} } as never, fn)

  test('answers the same view the app does, inside a call', () => {
    const app = build()
    expect(inCall(app, {}, () => $.config.name)).toBe('shop')
    expect(inCall(app, {}, () => $.config)).toBe(app.configFor())
  })

  test('resolves through the TENANT on the call, which is the wiring phase 4 fills', () => {
    // The value cannot differ yet — there is no resolver — so what is asserted
    // is that the tenant reaches the owner at all. Without this the seam looks
    // finished and quietly resolves every tenant as none.
    const app = build()
    const seen: Array<string | null> = []
    const spied = Object.create(app, { configFor: { value: (t: string | null) => { seen.push(t); return app.configFor(t) } } })

    inCall(spied, { tenantId: 'acme' }, () => $.config.name)
    inCall(spied, {},                   () => $.config.name)
    expect(seen).toEqual(['acme', null])
  })

  test('cannot be assigned, like every other derived accessor on `$`', () => {
    const app = build()
    expect(() => inCall(app, {}, () => { ($ as unknown as { config: unknown }).config = {} }))
      .toThrow(/cannot be assigned/)
  })

  test('a spread of `$` does not evaluate it', () => {
    // `db` and `me` are absent from ownKeys for this reason: enumerating a
    // derived accessor makes `{ ...$ }` evaluate it, and one of them throws on
    // an app that has no client. `config` joins them.
    const app = build()
    const keys = inCall(app, {}, () => Object.keys({ ...$ }))
    expect(keys).not.toContain('config')
    expect(inCall(app, {}, () => 'config' in $)).toBe(true)
  })

  test('a hand-built context with no app says so rather than answering undefined', () => {
    expect(() => inCall(undefined, {}, () => $.config.name)).toThrow(/this call has no app on it/)
  })
})

// ─── the source (FJS-D126, clause 3) ─────────────────────────────────────────

describe('createApp({ tenantConfig })', () => {
  const withTenants = (over: Record<string, Record<string, unknown>>, keys = ['name', 'mail.from']) =>
    createApp({
      config: { name: 'floor', version: '1.0.0', mail: { from: 'noreply@floor.test', replyTo: 'x@floor.test' } } as never,
      tenantConfig:     async (id: string) => over[id] ?? {},
      tenantConfigKeys: keys,
    })

  test('a tenant reads its own value and the floor for everything else', async () => {
    const app = withTenants({ acme: { name: 'Acme', mail: { from: 'hi@acme.test' } } })
    await app.loadTenantConfig('acme')

    expect(app.configFor('acme').name).toBe('Acme')
    expect((app.configFor('acme') as unknown as { mail: { from: string; replyTo: string } }).mail)
      .toEqual({ from: 'hi@acme.test', replyTo: 'x@floor.test' })   // the floor's sibling survives
  })

  test('a tenant that overrides nothing costs nothing', async () => {
    const app = withTenants({ acme: {} })
    await app.loadTenantConfig('acme')
    expect(app.configFor('acme').name).toBe('floor')
  })

  test('the floor is never mutated — the next tenant is not the previous one', async () => {
    const app = withTenants({ a: { name: 'A' }, b: { name: 'B' } })
    await app.loadTenantConfig('a')
    await app.loadTenantConfig('b')

    expect(app.configFor('a').name).toBe('A')
    expect(app.configFor('b').name).toBe('B')
    expect(app.config.name).toBe('floor')
    expect(app.configFor(null).name).toBe('floor')
  })

  test('an unloaded tenant reads the floor rather than a stale or invented answer', () => {
    const app = withTenants({ acme: { name: 'Acme' } })
    expect(app.configFor('acme').name).toBe('floor')     // never loaded
  })

  test('the resolved view is still read-only', async () => {
    const app = withTenants({ acme: { name: 'Acme' } })
    await app.loadTenantConfig('acme')
    expect(() => { (app.configFor('acme') as { name: string }).name = 'x' }).toThrow(/cannot be assigned/)
  })
})

describe('the allow-list is the safe half', () => {
  test('a reserved path is refused at BOOT, not per request', () => {
    expect(() => createApp({
      config: {} as never,
      tenantConfig:     async () => ({}),
      tenantConfigKeys: ['name', 'database.url'],
    })).toThrow(/'database\.url'.*may never override/s)
  })

  test('every reserved root is refused, and so is a path under one', () => {
    for (const key of ['port', 'database', 'http.cors.origin', 'auth.cookie', 'apiPrefix'])
      expect(() => createApp({ config: {} as never, tenantConfig: async () => ({}), tenantConfigKeys: [key] }))
        .toThrow(/may never override/)
  })

  test('a resolver with no keys at all is refused — the list is not optional', () => {
    expect(() => createApp({ config: {} as never, tenantConfig: async () => ({}) }))
      .toThrow(/needs tenantConfigKeys/)
  })

  test('a key the list does not name is REFUSED, not dropped', async () => {
    const app = createApp({
      config: { name: 'floor' } as never,
      tenantConfig:     async () => ({ name: 'Acme', sneaky: 'value' }),
      tenantConfigKeys: ['name'],
    })
    // Dropping it means a tenant whose configuration silently does not apply,
    // which reads as *the feature is broken* and is a support ticket rather than
    // a stack trace.
    await expect(app.loadTenantConfig('acme')).rejects.toThrow(/answered 'sneaky'.*does not name/s)
  })
})

describe('memoisation and invalidation', () => {
  test('resolves once per tenant, and concurrent callers share one resolve', async () => {
    let calls = 0
    const app = createApp({
      config: { name: 'floor' } as never,
      tenantConfig:     async () => { calls++; return { name: 'Acme' } },
      tenantConfigKeys: ['name'],
    })

    await Promise.all([app.loadTenantConfig('acme'), app.loadTenantConfig('acme'), app.loadTenantConfig('acme')])
    await app.loadTenantConfig('acme')
    expect(calls).toBe(1)
  })

  test('invalidate() is the way out — a memo with none needs a restart', async () => {
    let name = 'First'
    const app = createApp({
      config: { name: 'floor' } as never,
      tenantConfig:     async () => ({ name }),
      tenantConfigKeys: ['name'],
    })

    await app.loadTenantConfig('acme')
    expect(app.configFor('acme').name).toBe('First')

    name = 'Second'
    await app.loadTenantConfig('acme')
    expect(app.configFor('acme').name).toBe('First')     // memoised, as designed

    app.invalidateTenantConfig('acme')
    await app.loadTenantConfig('acme')
    expect(app.configFor('acme').name).toBe('Second')
  })

  test('a FAILED resolve is not memoised — the row may be a second from existing', async () => {
    let fail = true
    const app = createApp({
      config: { name: 'floor' } as never,
      tenantConfig:     async () => { if (fail) throw new Error('no row yet'); return { name: 'Acme' } },
      tenantConfigKeys: ['name'],
    })

    await expect(app.loadTenantConfig('acme')).rejects.toThrow('no row yet')
    fail = false
    await app.loadTenantConfig('acme')
    expect(app.configFor('acme').name).toBe('Acme')
  })

  test('an app with no resolver still answers, so adopting nothing costs nothing', async () => {
    const app = createApp({ config: { name: 'floor' } as never })
    expect(app.configFor('anything').name).toBe('floor')
    expect((await app.loadTenantConfig('anything')).name).toBe('floor')
    expect(() => app.invalidateTenantConfig()).not.toThrow()
  })
})

describe('the hook warms it, which is what makes the sync read correct', () => {
  // The integration the whole design turns on: `$.config` is a property read
  // and a resolver is async, so they can only meet where the tenant is already
  // known. If the hook does not warm, every read silently answers the floor —
  // one tenant's mail going out under another's name, with nothing saying so.
  const appFor = (over: Record<string, Record<string, unknown>>) => createApp({
    config: { name: 'floor', mail: { from: 'noreply@floor.test' } } as never,
    tenantConfig:     async (id: string) => over[id] ?? {},
    tenantConfigKeys: ['name', 'mail.from'],
  })

  test('a call carrying a tenant reads that tenant inside the method', async () => {
    const app  = appFor({ acme: { name: 'Acme', mail: { from: 'hi@acme.test' } } })
    const hook = withLitestoneDb({} as never)

    let seen = ''
    const ctx = { app, locals: { tenantId: 'acme' }, auth: { user: null }, client: {}, route: {} }
    await hook(ctx as never, async () => {
      seen = enterCall(ctx as never, () =>
        ($.config as unknown as { mail: { from: string } }).mail.from)
    })

    expect(seen).toBe('hi@acme.test')
  })

  test('a call carrying no tenant reads the floor', async () => {
    const app  = appFor({ acme: { name: 'Acme' } })
    const hook = withLitestoneDb({} as never)

    let seen = ''
    const ctx = { app, locals: {}, auth: { user: null }, client: {}, route: {} }
    await hook(ctx as never, async () => {
      seen = enterCall(ctx as never, () => $.config.name)
    })

    expect(seen).toBe('floor')
  })

  test('a resolver that throws fails the call rather than quietly serving the floor', async () => {
    const app = createApp({
      config: { name: 'floor' } as never,
      tenantConfig:     async () => { throw new Error('settings row unreadable') },
      tenantConfigKeys: ['name'],
    })
    const hook = withLitestoneDb({} as never)
    const ctx  = { app, locals: { tenantId: 'acme' }, auth: { user: null }, client: {}, route: {} }

    await expect(hook(ctx as never, async () => {})).rejects.toThrow('settings row unreadable')
  })

  test('runAs warms it, so a job that names a tenant finds it resolved', async () => {
    const app = appFor({ acme: { name: 'Acme' } })
    const seen = await app.runAs(null, { tenant: 'acme' }, () => app.configFor('acme').name)
    expect(seen).toBe('Acme')
  })
})
