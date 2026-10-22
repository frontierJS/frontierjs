// test/devtools-security.test.ts
//
// FJS-691 — the console serves request logs, request PARAMS, a live event feed
// and a POST that runs a job by name. It bound `Bun.serve({ port })` with no
// `hostname`, which is every interface, and the only thing standing between a
// laptop on a café network and that surface was `NODE_ENV === 'production'` —
// unset in dev, and unset is the common case.
//
// Three separate refusals, and they fail apart:
//   • the bound address is loopback unless the app says otherwise;
//   • off loopback with no `auth` it refuses to BIND, whatever NODE_ENV says;
//   • a cross-site POST is 403, because a `text/plain` POST needs no preflight
//     and a page on any origin could otherwise run a job by name.

import { describe, test, expect, afterEach } from 'bun:test'
import { createApp } from '../src/core/app.ts'
import { devtools }  from '../src/plugins/devtools/index.ts'
import { createService } from '../src/core/service.ts'
import { createStubAuth } from '../src/testing/index.ts'
import { createClient }   from '../../litestone/src/index.js'

const running: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => { for (const a of running.splice(0)) await a.stop().catch(() => {}) })

async function mkApp(opts: Parameters<typeof devtools>[0] = {}) {
  const app: any = createApp({
    logLevel: 'silent',
    config: { port: 0 },
  })
  app.configure(devtools({ port: 0, ...opts }))
  await app.start()
  running.push(app)
  return app
}

describe('where the console binds (FJS-691)', () => {

  test('the default hostname is loopback', async () => {
    const app = await mkApp()
    expect(app._devtools.status).toBe('on')
    // Asked of the URL the app itself reports, which is the one a person opens.
    expect(app._devtools.url).toMatch(/^http:\/\/localhost:/)
  })

  test('a non-loopback hostname with no auth gate refuses to bind', async () => {
    const app = await mkApp({ hostname: '0.0.0.0' })
    expect(app._devtools.status).toBe('refused')
    // Named, because "devtools is off" with no reason is the state that gets a
    // gate added and then removed again.
    expect(app._devtools.reason).toContain('0.0.0.0')
    expect(app._devtools.reason).toContain('auth')
  })

  test('a non-loopback hostname WITH an auth gate binds', async () => {
    const app = await mkApp({ hostname: '127.0.0.2', auth: () => true })
    // The control: it is the missing gate that refuses, not the hostname.
    expect(app._devtools.status).toBe('on')
  })
})

describe('cross-site requests (FJS-691)', () => {

  const url = (app: any, path: string) => `${app._devtools.url.replace('localhost', '127.0.0.1')}${path}`

  test('a POST from another origin is 403', async () => {
    const app = await mkApp()
    const res = await fetch(url(app, '/api/jobs/run/send-invoices'), {
      method:  'POST',
      headers: { 'content-type': 'text/plain', origin: 'https://evil.example' },
      body:    '{}',
    })
    expect(res.status).toBe(403)
  })

  test('a POST declaring Sec-Fetch-Site: cross-site is 403', async () => {
    const app = await mkApp()
    const res = await fetch(url(app, '/api/jobs/run/x'), {
      method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}',
    })
    expect(res.status).toBe(403)
  })

  test('a WS upgrade from another origin is 403', async () => {
    const app = await mkApp()
    const res = await fetch(url(app, '/'), {
      headers: { upgrade: 'websocket', connection: 'Upgrade', origin: 'https://evil.example' },
    })
    expect(res.status).toBe(403)
  })

  test('a POST with no Origin at all is not refused', async () => {
    const app = await mkApp()
    // The rule is about a BROWSER. A request carrying neither header is not one,
    // and refusing it would break curl and every drive here — the 501 below is
    // the app answering that it has no job queue, which is the point: it got
    // past the check.
    const res = await fetch(url(app, '/api/jobs/run/x'), { method: 'POST', body: '{}' })
    expect(res.status).not.toBe(403)
  })

  test('a same-origin GET is served', async () => {
    const app = await mkApp()
    const res = await fetch(url(app, '/api/state'), { headers: { 'sec-fetch-site': 'same-origin' } })
    expect(res.status).toBe(200)
  })
})

// FJS-D461: everything that acts on a queue is POST-only, so a link preview or a
// prefetch of the URL cannot retry, cancel or run a job.
describe('job actions are POST-only (FJS-D461)', () => {

  test('retry, cancel and run answer nothing to any other method, and act on POST', async () => {
    const acted: string[] = []
    const app: any = createApp({ logLevel: 'silent', config: { port: 0 } })
    app.jobs = {
      list: () => [], find: () => null,
      registrations: () => [{ name: 'send-invoices' }],
      retry:    async (id: string) => { acted.push(`retry ${id}`);  return true },
      cancel:   async (id: string) => { acted.push(`cancel ${id}`); return true },
      dispatch: async (name: string) => { acted.push(`run ${name}`); return 'job-1' },
    }
    app.configure(devtools({ port: 0 }))
    await app.start()
    running.push(app)

    const base  = app._devtools.url.replace('localhost', '127.0.0.1')
    const paths = ['/api/jobs/j1/retry', '/api/jobs/j1/cancel', '/api/jobs/run/send-invoices']

    for (const path of paths) {
      for (const method of ['GET', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(base + path, { method })
        expect(res.ok, `${method} ${path}`).toBe(false)
      }
    }
    expect(acted).toEqual([])

    for (const path of paths) expect((await fetch(base + path, { method: 'POST' })).status).toBe(200)
    expect(acted).toEqual(['retry j1', 'cancel j1', 'run send-invoices'])
  })
})

// FJS-D1426: a call as somebody runs inside the app, so it lands in the feed a
// request lands in; and only in development, because acting as somebody in
// production is auth's support mode, whatever devtools' `auth` admits.
describe('a call, as somebody (FJS-D1426)', () => {

  async function withService(env: string | undefined) {
    const was = process.env.NODE_ENV
    if (env === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = env
    try {
      const app: any = createApp({ logLevel: 'silent', config: { port: 0 } })
      app.services.register(createService({
        name: 'notes',
        async find() { return [] },
        async whoami(ctx: any) { return { id: ctx.user?.id ?? null } },
      }))
      app.configure(devtools({ port: 0, auth: () => true }))
      await app.start()
      running.push(app)
      return { app, base: app._devtools.url.replace('localhost', '127.0.0.1') }
    } finally {
      if (was === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = was
    }
  }
  const post = (base: string, body: unknown) =>
    fetch(`${base}/api/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

  test('in development it runs in this process, as nobody when nobody is named, and the feed has it', async () => {
    const { base } = await withService('development')
    const listed = await (await fetch(`${base}/api/call`)).json()
    expect(listed.services.find((s: any) => s.name === 'notes').methods).toEqual(expect.arrayContaining(['find', 'whoami']))

    const res = await post(base, { method: 'notes.whoami' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, result: { id: null } })

    const state = await (await fetch(`${base}/api/state`)).json()
    expect(state.requests.some((r: any) => r.service === 'notes' && r.method === 'whoami')).toBe(true)
  })

  test('a hook-bypass twin is refused by name and never runs', async () => {
    const { base } = await withService('development')
    const res = await post(base, { method: 'notes._find' })
    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain('Call find')
  })

  test('in production it is 403 naming support mode, with auth admitting the caller', async () => {
    const { base } = await withService('production')
    const res = await post(base, { method: 'notes.whoami' })
    expect(res.status).toBe(403)
    expect((await res.json()).message).toContain('startSupport')
  })
})

describe('rows, as somebody (fli gui :data)', () => {

  async function withRows(env: string | undefined) {
    const was = process.env.NODE_ENV
    if (env === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = env
    try {
      const db: any = await createClient({ db: ':memory:', schema: `
        model User { id Int @id @default(autoincrement())  email String  @@auth }
        model Memo { id Int @id @default(autoincrement())  body String  @@gate(3) }
        model Note { id Int @id @default(autoincrement())  body String  @@allow(all, auth() != null) }` })
      await db.asSystem().user.create({ data: { email: 'ann@x.test' } })
      await db.asSystem().memo.create({ data: { body: 'for members' } })
      await db.asSystem().note.createMany({ data: [{ body: 'a' }, { body: 'b' }, { body: 'c' }] })
      const app: any = createApp({
        db, logLevel: 'silent', config: { port: 0 },
        auth: createStubAuth({ users: [{ id: '1', role: 'member' }] }),
        system: { id: 'app', role: 'system', userType: 'system', authMethod: 'system' },
      })
      app.configure(devtools({ port: 0, auth: () => true }))
      await app.start()
      running.push(app)
      return app._devtools.url.replace('localhost', '127.0.0.1') as string
    } finally {
      if (was === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = was
    }
  }
  const read = async (base: string, path: string) => {
    const res = await fetch(`${base}${path}`)
    return { status: res.status, body: await res.json() as any }
  }

  test('the models are the schema\'s, and a member reads what the gate lets a member read', async () => {
    const base = await withRows('development')
    expect((await read(base, '/api/data')).body.models).toEqual(['User', 'Memo', 'Note'])
    const memo = await read(base, '/api/data/Memo?as=ann@x.test')
    expect(memo).toMatchObject({ status: 200, body: { ok: true, total: 1, standing: 'ann@x.test (User 1)' } })
    expect(memo.body.rows[0].body).toBe('for members')
    const page = await read(base, '/api/data/Note?as=ann@x.test&limit=2&offset=1')
    expect(page.body.rows.map((r: any) => r.body)).toEqual(['b', 'c'])
    expect(page.body.total).toBe(3)
  })

  test('nobody is a stranger, never the app: the gate refuses and the row policy hides', async () => {
    const base = await withRows('development')
    const memo = await read(base, '/api/data/Memo')
    expect(memo.status).toBe(403)
    expect(memo.body).toMatchObject({ ok: false, name: 'Forbidden', message: '"Memo.read" requires level 3, user has level 0' })
    expect(memo.body.standing).toContain('nobody')
    expect((await read(base, '/api/data/Note')).body).toMatchObject({ ok: true, rows: [], total: 0 })
  })

  test('a model the schema does not name is 404 naming the ones it does', async () => {
    const base = await withRows('development')
    const out = await read(base, '/api/data/Nope?as=ann@x.test')
    expect(out.status).toBe(404)
    expect(out.body.message).toContain('User, Memo, Note')
  })

  test('in production the rows are 403 naming support mode, with auth admitting the caller', async () => {
    const base = await withRows('production')
    const out = await read(base, '/api/data/Note?as=ann@x.test')
    expect(out.status).toBe(403)
    expect(out.body.message).toContain('startSupport')
  })
})
