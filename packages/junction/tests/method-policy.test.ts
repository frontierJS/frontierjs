// tests/method-policy.test.ts
//
// FJS-004 / FJS-D07 — `methods:` narrows what a service answers.
//
// The defect this closes: `createService({ model })` answered every CRUD verb
// through the base *with validation*, whether or not the file declared one. So
// Basecamp's `/audit`, an append-only trail whose service defines only find(),
// accepted `POST /audit` and wrote the row — an admin could forge an entry into
// the record of what admins did. Verified over HTTP before the fix; the
// workaround was four hand-written MethodNotAllowed stubs per service.
//
// The shape ruled: ONE key, two forms.
//
//   methods: ['find', 'get']   an allow-list — the general form
//   methods: 'readOnly'        shorthand for exactly that list
//
// Absent means everything, so no existing service changes.
//
// What these tests are really guarding is WHERE the check lives. A policy
// enforced in the HTTP layer would leave `app.service('audit').create()` free
// to do what the wire is refused, and an in-process caller is exactly how a
// job, an engine or a hook writes. The enforcement point is callService, which
// every caller goes through — so the same refusal has to be provable from both
// directions. That is the pair of tests below that matter.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp, createService, healthPlugin, manifestPlugin, defaultConfig } from '../index.ts'
import { createBaseService, callService } from '../src/core/service.ts'

const PORT = 3389
let app: any

beforeAll(async () => {
  app = createApp({
    config: {
      port: PORT,
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http: { ...defaultConfig.http, drainTimeout: 200 },
    },
  })
  app.configure(healthPlugin())
  app.configure(manifestPlugin({ devOnly: false }))

  // The Basecamp case: an append-only trail.
  app.services.register(createService({
    name:    'audit',
    methods: ['find', 'get'],
    async find() { return [{ id: 'a1' }] },
    async get()  { return { id: 'a1' } },
  }))

  // The same thing said with the shorthand.
  app.services.register(createService({
    name:    'trail',
    methods: 'readOnly',
    async find() { return [] },
  }))

  // A policy that is not "read only" — the case a boolean could not express.
  app.services.register(createService({
    name:    'tickets',
    methods: ['find', 'create', 'approve'],
    async find()    { return [] },
    async create()  { return { id: 't1' } },
    async approve() { return { id: 't1', approved: true } },
    async escalate() { return { id: 't1', escalated: true } },
  }))

  // No policy — the untouched majority.
  app.services.register(createService({
    name: 'open',
    async find()   { return [] },
    async create() { return { id: 'o1' } },
    async ping()   { return { ok: true } },
  }))

  await app.start()
})

afterAll(async () => { await app?.stop() })

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })

describe('methods: the allow-list', () => {

  it('answers a listed method normally', async () => {
    const res = await fetch(`http://localhost:${PORT}/audit`)
    expect(res.status).toBe(200)
  })

  it('refuses an unlisted method with 405, not 404', async () => {
    // 404 would send someone looking for a mounting problem. The service
    // exists and the route is real; the verb is not offered.
    const res = await post('/audit', { action: 'forged' })
    expect(res.status).toBe(405)
  })

  it('does not write the row it refused', async () => {
    // The original defect was not that POST /audit returned something odd —
    // it was that the row landed. A 405 that still wrote would pass the
    // status assertion above and fail the only thing that matters.
    let created = false
    app.services.register(createService({
      name:    'ledger',
      methods: ['find'],
      async find() { return [] },
      async create() { created = true; return { id: 'x' } },
    }))
    await expect(app.service('ledger').create({ any: 'thing' })).rejects.toThrow()
    expect(created).toBe(false)
  })

  it('names what IS allowed in the message', async () => {
    const body = await (await post('/audit', {})).json()
    expect(JSON.stringify(body)).toContain('find')
  })
})

describe('methods: the enforcement point', () => {

  it('refuses an in-process caller too, not just the wire', async () => {
    // The load-bearing one. A policy enforced in the transport would let a
    // job, an engine or a hook do what a request cannot — and in Basecamp the
    // audit trail is written by exactly such a path.
    await expect(app.service('audit').create({ action: 'forged' })).rejects.toThrow()
  })

  it('the in-process refusal carries 405, so a transport maps it correctly', async () => {
    let status: unknown = null
    try { await app.service('audit').create({}) }
    catch (err) { status = (err as { code?: unknown; status?: unknown }).code ?? (err as { status?: unknown }).status }
    expect(status).toBe(405)
  })

  it('still allows a listed method in process', async () => {
    await expect(app.service('audit').find()).resolves.toBeDefined()
  })
})

describe("methods: 'readOnly'", () => {

  it('is exactly the find/get list', async () => {
    expect((await fetch(`http://localhost:${PORT}/trail`)).status).toBe(200)
    expect((await post('/trail', {})).status).toBe(405)
  })
})

describe('methods: custom methods are in the same list', () => {

  it('allows a listed action', async () => {
    const res = await post('/tickets/t1', {}, { 'X-Service-Method': 'approve' })
    expect(res.status).toBe(200)
  })

  it('refuses an action the list omits, though the method exists', async () => {
    // escalate() is defined on the service. Being defined is not being offered
    // — which is the whole difference between this and the NotFound check that
    // already existed for custom methods.
    const res = await post('/tickets/t1', {}, { 'X-Service-Method': 'escalate' })
    expect(res.status).toBe(405)
  })

  it('expresses a mix a boolean could not', async () => {
    // "create yes, patch no, one action yes" — the reason the allow-list is
    // the general form and readOnly is only sugar on it.
    expect((await post('/tickets', {})).status).toBe(201)   // create → 201
    const patch = await fetch(`http://localhost:${PORT}/tickets/t1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    expect(patch.status).toBe(405)
  })
})

describe('methods: absent means everything', () => {

  it('leaves a service with no policy untouched', async () => {
    expect((await fetch(`http://localhost:${PORT}/open`)).status).toBe(200)
    expect((await post('/open', {})).status).toBe(201)   // create → 201
    expect((await post('/open/o1', {}, { 'X-Service-Method': 'ping' })).status).toBe(200)
  })
})

describe('methods: a bad declaration is reported by start()', () => {

  // These used to throw at construction. They are collected now and refused
  // together by `start()`'s `check-authoring` phase, because an app has a
  // config, N service files and a hook table, and throwing on the first makes
  // fixing them serial — one boot per typo (`FJS-D199`). What is graded here is
  // the finding; `authoring-keys.test.ts` grades the refusal it becomes.
  const findingsOf = (svc: unknown) =>
    ((svc as { _authoringFindings?: string[] })._authoringFindings ?? []).join('\n')

  it('reports a name the service does not have', () => {
    // The failure this prevents: `['find', 'gett']` silently blocks `get` and
    // reads as "the allow-list is broken" only after a 405 in production.
    const svc = createService({
      name:    'typo',
      methods: ['find', 'gett'],
      async find() { return [] },
    })
    expect(findingsOf(svc)).toMatch(/gett/)
  })

  it('names what was available, so the typo is obvious', () => {
    const svc = createService({ name: 'typo2', methods: ['fnid'], async find() { return [] } })
    expect(findingsOf(svc)).toContain('find')
  })

  it('…and a correct declaration reports nothing — the control', () => {
    const svc = createService({ name: 'fine', methods: ['find'], async find() { return [] } })
    expect(findingsOf(svc)).toBe('')
  })

  it('accepts an action name in the list', () => {
    expect(() => createService({
      name:    'ok',
      methods: ['find', 'approve'],
      async find()    { return [] },
      async approve() { return {} },
    })).not.toThrow()
  })

  it('rejects a policy that is neither an array nor the preset', () => {
    expect(() => createService({
      name:    'bad',
      methods: 'writeOnly' as never,
      async find() { return [] },
    })).toThrow()
  })

  it('allows an explicitly empty list — a service that answers nothing', () => {
    // Distinct from "no policy". Saying so out loud is allowed; it is the
    // difference between a null policy and an empty set.
    const svc = createService({ name: 'sealed', methods: [], async find() { return [] } })
    expect(svc._methods?.size).toBe(0)
  })
})

describe('methods: what the app advertises matches what it answers', () => {

  it('/manifest omits a refused method', async () => {
    const m = await (await fetch(`http://localhost:${PORT}/manifest`)).json()
    const audit = m.services.find((s: any) => s.name === 'audit')
    expect(audit.methods).toEqual(['find', 'get'])
    expect(audit.methods).not.toContain('create')
  })

  it('/manifest still lists everything for an unrestricted service', async () => {
    const m = await (await fetch(`http://localhost:${PORT}/manifest`)).json()
    const open = m.services.find((s: any) => s.name === 'open')
    expect(open.methods).toContain('create')
    expect(open.methods).toContain('ping')
  })

  it('/metrics omits a refused custom method', async () => {
    const d = (await (await fetch(`http://localhost:${PORT}/metrics`)).json()).services.details
    expect(d.tickets.customMethods).toEqual(['approve'])
    expect(d.tickets.customMethods).not.toContain('escalate')
  })

  it('/manifest advertising and the 405 cannot drift', async () => {
    // Both read the same predicate, so this is a structural claim rather than
    // two lists that happen to agree today.
    const m = await (await fetch(`http://localhost:${PORT}/manifest`)).json()
    const tickets = m.services.find((s: any) => s.name === 'tickets')
    for (const verb of ['patch', 'remove', 'escalate'])
      expect(tickets.methods).not.toContain(verb)
    for (const verb of ['find', 'create', 'approve'])
      expect(tickets.methods).toContain(verb)
  })
})

// ─── The other factory ────────────────────────────────────────────────────
//
// `methods` was read by createService and NOT by createBaseService, which
// neither consumed nor forwarded it. So the same declaration that makes an
// audit trail append-only through one factory did nothing at all through the
// other, and the only symptom was a write that succeeded.
//
// createBaseService is the minimal service file the loader is built around —
// `export function createPostsService() { return createBaseService({}) }` — so
// this was the more likely of the two to be written. Found 2026-08-06 in
// example/, declaring `methods: ['find','get','patch']` on a notifications
// service and getting a create that reached the model's gate.

describe('methods: declared on createBaseService', () => {
  const make = createService

  const built = () => make({
    // Exactly what the loader does with a bare base object.
    name: 'notes',
    ...(createBaseService({
      model:   'note',
      methods: ['find', 'get', 'patch'],
      db:      () => ({ note: {} }),
    }) as unknown as Record<string, unknown>),
  } as never)

  it('carries the allow-list through to the built service', () => {
    expect([...(built() as { _methods: Set<string> })._methods].sort())
      .toEqual(['find', 'get', 'patch'])
  })

  it('refuses a method the list omits', async () => {
    const svc = built()
    const ctx = {
      service: 'notes', method: 'create', data: { a: 1 },
      params: {}, query: {}, directives: {}, auth: {}, client: {},
      locals: {}, app: {}, result: null, error: null,
    } as never

    await expect(callService(svc as never, ctx)).rejects.toThrow(/does not offer 'create'/)
  })

  it("'readOnly' works through this factory too", () => {
    const svc = make({
      name: 'audit',
      ...(createBaseService({ model: 'auditEvent', methods: 'readOnly', db: () => ({}) }) as unknown as Record<string, unknown>),
    } as never)
    expect([...(svc as { _methods: Set<string> })._methods].sort()).toEqual(['find', 'get'])
  })

  it('absent still means everything', () => {
    const svc = make({
      name: 'notes',
      ...(createBaseService({ model: 'note', db: () => ({}) }) as unknown as Record<string, unknown>),
    } as never)
    expect((svc as { _methods: Set<string> | null })._methods).toBe(null)
  })
})
