// test/realtime-grading.test.ts
//
// The realtime half of the API-realm audit, against a REAL app on a REAL port
// with REAL `WebSocket` clients. A fake socket would pass every one of these:
// the mechanisms under test are a Litestone Proxy that throws on an unknown
// property, an upgrade that resolves auth asynchronously AFTER the handshake,
// and a channel fan-out that grades each recipient at the Data boundary.
//
//   FJS-673  one telemetry listener turned every AUTHENTICATED call into a 500,
//            because `typeof scopedDb.$tapQuery` is a throwing expression on a
//            `$setAuth` proxy. Anonymous callers hold the ROOT client and were
//            fine, which is why 1733 green tests never saw it — the listener and
//            the signed-in caller have to be in the same test.
//   FJS-672  `announceDataWrites` sent ungraded: every write outside its own
//            service put whole rows on every subscribed socket.
//   FJS-700  grading resolved the model from the SERVICE NAME, so a service
//            whose name maps to no model broadcast to nobody, in silence.
//   FJS-702  a token that was present and failed to verify connected as
//            ANONYMOUS with no close, so the client's 4001 branch was dead.

import { describe, test, expect, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { createClient, GatePlugin, parse, autoMigrate } from '../../litestone/src/index.js'
import { createApp }      from '../src/core/app.ts'
import { createService }  from '../src/core/service.ts'
import { channels }       from '../src/transport/channels.ts'

const SCHEMA = `
  model Order {
    id         Int    @id @default(autoincrement())
    customerId Int?
    status     String @default("pending")
    @@gate(1.4.4.5)
    @@allow('read', customerId == auth().id || auth().isAdmin)
  }
`

// `customerId` is an `Int` against a principal whose `userId` is TEXT, which is
// the crossing the whole file used to be arranged around: a `SessionContext`
// carries the id as a string, so `customerId == auth().id` was TRUE through a
// query — SQLite applies the column's affinity — and FALSE in `$readAs`, which
// compared in JS. The fixture used a `String` column to avoid it, so the suite
// was green on the rarer shape (`FJS-713`). The Data boundary answers both the
// same way now, and this is the column type that says so.

// The write tap defers one event-loop tick and the frame then crosses a real
// socket, so a yield is not enough — this is the only wait in the file and it
// is bounded by an assertion rather than by the sleep.
const sleep  = (ms: number) => new Promise(r => setTimeout(r, ms))
const settle = async () => { await sleep(120) }

// `userId` is a STRING on a SessionContext and the column is an Int, which is
// the crossing `toDataPrincipal` sits on — asserted here rather than typed
// around, because a policy comparing `'5'` to `5` is exactly the shape that
// refuses the owner and admits a stranger (`FJS-D175`).
interface Session { userId: string; userType: 'user'; authMethod: 'session'; isAdmin?: boolean; verifiedAt: string; activatedAt: string }

function sessionFor(token: string): Session | null {
  const base = { userType: 'user' as const, authMethod: 'session' as const, verifiedAt: 'x', activatedAt: 'x' }
  if (token === 'admin') return { ...base, userId: '1', isAdmin: true }
  const m = /^u(\d+)$/.exec(token)
  return m ? { ...base, userId: m[1] } : null
}

const LITESTONE = resolve(import.meta.dir, '../../litestone/src/index.js')

const running: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => { for (const a of running.splice(0)) await a.stop().catch(() => {}) })

async function mkApp(opts: { telemetry?: boolean; second?: boolean; named?: boolean; schema?: string; file?: string; getLevel?: (u: unknown) => number } = {}) {
  const db: any = await createClient({
    ...(opts.file ? {} : { db: ':memory:' }), schema: opts.schema ?? SCHEMA,
    ...(opts.getLevel ? { plugins: [new GatePlugin({ getLevel: opts.getLevel })] } : {}),
  })
  if (opts.file) autoMigrate(db, parse(opts.schema!))
  const app: any = createApp({
    db,
    logLevel: 'silent',
    config: { port: 0, services: { dir: '/nonexistent' } },
    auth: {
      verifySession: async (token: string) => {
        const u = sessionFor(token)
        if (!u) throw new Error('bad token')
        return u
      },
    },
  })
  // `named`: a channel FUNCTION answering a name — a definition holds no app to
  // build a channel with (FJS-D1079).
  app.services.register(createService({ name: 'orders', model: 'Order', channel: opts.named ? () => 'orders' : 'orders' }))
  // A service whose NAME maps to no model. `model:` is the declaration and the
  // name is only a fallback — grading off the name alone refused everybody here.
  if (opts.second)
    app.services.register(createService({ name: 'orders2', model: 'Order', channel: 'orders2' }))
  app.configure(channels((a: any) => {
    a.channels.on('connection', (_s: unknown, conn: unknown) => {
      a.channel('orders').join(conn)
      if (opts.second) a.channel('orders2').join(conn)
    })
  }))
  // The listener is what made FJS-673 fire. It has to be attached before the
  // first authenticated call, exactly as the devtools console attaches four.
  const queries: unknown[] = []
  if (opts.telemetry) app.telemetry.on('litestone.query', (e: unknown) => { queries.push(e) })
  await app.start()
  running.push(app)
  return { app, db, queries, port: app.http.port as number }
}

interface Sock { frames: any[]; events: any[]; closed: Promise<{ code: number; reason: string }>; ws: WebSocket }

function open(port: number, token?: string): Sock {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, token ? ['fjs', `fjs.bearer.${token}`] : ['fjs'])
  const frames: any[] = []
  const events: any[] = []
  let done: (v: { code: number; reason: string }) => void
  const closed = new Promise<{ code: number; reason: string }>(r => { done = r })
  ws.onmessage = (e: any) => {
    let f: any
    try { f = JSON.parse(String(e.data)) } catch { return }
    frames.push(f)
    // Presence is a channel-membership frame, not a data one, and it is
    // unconditional — filtered here so an assertion about who received a ROW is
    // about that and nothing else.
    if (f.type === 'event' && !String(f.event ?? '').startsWith('presence:')) events.push(f)
  }
  ws.onclose = (e: any) => done({ code: e.code, reason: e.reason })
  return { frames, events, closed, ws }
}

const ready = async (s: Sock) => {
  for (let i = 0; i < 200 && !s.frames.some(f => f.type === 'connected'); i++) await sleep(5)
  return s.frames.some(f => f.type === 'connected')
}

// ─── FJS-673 ──────────────────────────────────────────────────────────────

describe('a telemetry listener and a signed-in caller (FJS-673)', () => {

  test('an authenticated create succeeds with a litestone.query listener attached', async () => {
    const { port } = await mkApp({ telemetry: true })
    const res = await fetch(`http://localhost:${port}/orders`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin' },
      body:    JSON.stringify({ customerId: '7' }),
    })
    // 500 here is the defect: `"$tapQuery" is not a table in this schema`.
    expect(res.status).toBe(201)
  })

  // The negative control. An anonymous caller holds the ROOT client, where the
  // property exists — so it passed throughout and proves nothing on its own.
  test('an anonymous read is unaffected', async () => {
    const { port } = await mkApp({ telemetry: true })
    const res = await fetch(`http://localhost:${port}/orders`)
    expect(res.status).toBe(401)
  })

  test('the queries are still attributed to the call that ran them', async () => {
    const { port, queries } = await mkApp({ telemetry: true })
    await fetch(`http://localhost:${port}/orders`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin' },
      body:    JSON.stringify({ customerId: '7' }),
    })
    expect(queries.length).toBeGreaterThan(0)
    // One tap on the root client is only correct if it can still say WHICH call
    // each query belonged to — that is read off the ALS store, not off a
    // captured ctx.
    expect(queries.some((q: any) => typeof q.telemetryId === 'string' && q.telemetryId.length > 0)).toBe(true)
  })
})

// ─── FJS-672 ──────────────────────────────────────────────────────────────

describe('a background write is graded like a published one (FJS-672)', () => {

  test('asSystem().create reaches the owner and no stranger', async () => {
    const { db, port } = await mkApp()
    const anon  = open(port)
    const other = open(port, 'u9')
    const owner = open(port, 'u5')
    expect(await ready(anon)).toBe(true)
    expect(await ready(other)).toBe(true)
    expect(await ready(owner)).toBe(true)

    await (db as any).asSystem().order.create({ data: { customerId: '5' } })
    await settle()

    // Both directions. A refusal that cannot be shown to come from the rule it
    // names proves nothing: the owner receiving it is what separates *graded*
    // from *broadcasting nothing at all*.
    expect(owner.events.map(e => e.event)).toEqual(['orders created'])
    // Written as text into an Int column and stored as a number, which is the
    // affinity the grading now agrees with rather than works around.
    expect(owner.events[0].data.customerId).toBe(5)
    expect(anon.events).toEqual([])
    expect(other.events).toEqual([])
  })

  test('a bulk changed announcement stops below the read gate', async () => {
    const { db, port } = await mkApp()
    const anon = open(port)
    const user = open(port, 'u5')
    expect(await ready(anon)).toBe(true)
    expect(await ready(user)).toBe(true)

    await (db as any).asSystem().order.create({ data: { customerId: '5' } })
    await settle()
    anon.events.length = 0
    user.events.length = 0

    await (db as any).asSystem().order.updateMany({ where: {}, data: { status: 'paid' } })
    await settle()

    // A count names no row, so there is nothing for `$readAs` to grade — but
    // *something you may not read changed* is still an existence oracle over a
    // gated model, so it is graded by the gate alone.
    expect(user.events.map(e => e.event)).toEqual(['orders changed'])
    expect(anon.events).toEqual([])
  })

  test('…and it is the APP’s mapping that decides who is above it (FJS-1161)', async () => {
    // The count-only path is graded by the gate alone, so the NUMBER is the
    // whole verdict — and it has to be the number the app's own `getLevel`
    // answers. `u5` carries no `role`, no `isAdmin` and no lifecycle stamp, so
    // the shipped grader puts them at CREATOR(3) and this model reads at 4;
    // an app whose standing comes from somewhere else entirely — a membership
    // row, which is how every tenanted app here grades — says 5.
    const schema = SCHEMA.replace('@@gate(1.4.4.5)', '@@gate(4.4.4.5)')
    const membership: Record<string, number> = { '5': 5 }
    const { db, port } = await mkApp({
      schema,
      getLevel: (u: any) => !u ? 0 : membership[String(u.id ?? u.userId)] ?? 1,
    })
    const member    = open(port, 'u5')
    const outsider  = open(port, 'u6')
    expect(await ready(member)).toBe(true)
    expect(await ready(outsider)).toBe(true)

    await (db as any).asSystem().order.create({ data: { customerId: '5' } })
    await settle()
    member.events.length = 0
    outsider.events.length = 0

    await (db as any).asSystem().order.updateMany({ where: {}, data: { status: 'paid' } })
    await settle()

    // The pair: the member is above the read gate by the app's reckoning and
    // below it by the shipped grader's, and the outsider is below both — so a
    // mechanism that graded everybody, and one that graded nobody, each fail
    // one half.
    expect(member.events.map(e => e.event)).toEqual(['orders changed'])
    expect(outsider.events).toEqual([])
  })

  test('a write through the service is still announced once', async () => {
    const { app, port } = await mkApp()
    const owner = open(port, 'u5')
    expect(await ready(owner)).toBe(true)
    await app.service('orders').create({ customerId: '5' }, { auth: { user: sessionFor('admin') } })
    await settle()
    expect(owner.events.filter(e => e.event === 'orders created')).toHaveLength(1)
  })
})

describe('a channel function may answer a channel name (FJS-D1079)', () => {

  test('graded on the service path and the background path alike', async () => {
    const { app, db, port } = await mkApp({ named: true })
    const owner    = open(port, 'u5')
    const stranger = open(port, 'u6')
    expect(await ready(owner)).toBe(true)
    expect(await ready(stranger)).toBe(true)

    await app.service('orders').create({ customerId: '5' }, { auth: { user: sessionFor('admin') } })
    await (db as any).asSystem().order.create({ data: { customerId: '5' } })
    await settle()

    expect(owner.events.filter(e => e.event === 'orders created')).toHaveLength(2)
    expect(stranger.events).toEqual([])
  })
})

// ─── FJS-700 ──────────────────────────────────────────────────────────────

describe('the accessor is the declared model, not the service name (FJS-700)', () => {

  test('a service whose name maps to no model still broadcasts to a permitted reader', async () => {
    const { db, port } = await mkApp({ second: true })
    const admin = open(port, 'admin')
    const anon  = open(port)
    expect(await ready(admin)).toBe(true)
    expect(await ready(anon)).toBe(true)

    await (db as any).asSystem().order.create({ data: { customerId: '5' } })
    await settle()

    // `orders2` resolves to no model by name. Refusing everybody there is
    // fail-closed and wrong: the model is declared and the rule can be asked.
    expect(admin.events.some(e => e.event === 'orders2 created')).toBe(true)
    expect(anon.events).toEqual([])
  })
})

// ─── FJS-702 ──────────────────────────────────────────────────────────────

describe('a token that does not verify (FJS-702)', () => {

  test('a garbage token closes the socket with 4001', async () => {
    const { port } = await mkApp()
    const s = open(port, 'not-a-real-token')
    const { code } = await s.closed
    expect(code).toBe(4001)
    // Nothing was sent before the close: a caller who was refused must not be
    // told the connection was established.
    expect(s.frames.filter(f => f.type === 'connected')).toEqual([])
  })

  test('no token at all stays anonymous', async () => {
    const { port } = await mkApp()
    const s = open(port)
    expect(await ready(s)).toBe(true)
    // A caller who claimed nothing is a stranger, which is a different answer
    // from a caller whose claim was rejected.
    expect(s.frames.find(f => f.type === 'connected')).toBeTruthy()
  })

  test('a good token connects', async () => {
    const { port } = await mkApp()
    const s = open(port, 'u5')
    expect(await ready(s)).toBe(true)
  })
})

describe('an update that takes a row out of a reader\'s set (FJS-1425)', () => {

  test('the reader who can no longer see it is sent removed, id alone', async () => {
    const { db, port } = await mkApp()
    const owner = open(port, 'u5')
    const next  = open(port, 'u6')
    expect(await ready(owner)).toBe(true)
    expect(await ready(next)).toBe(true)

    const row = await (db as any).asSystem().order.create({ data: { customerId: '5' } })
    await settle()
    await (db as any).asSystem().order.update({ where: { id: row.id }, data: { customerId: '6' } })
    await settle()

    expect(owner.events.map(e => e.event)).toEqual(['orders created', 'orders removed'])
    expect(owner.events[1].data).toEqual({ id: row.id })
    expect(next.events.map(e => e.event)).toEqual(['orders updated'])
    expect(next.events[0].data.customerId).toBe(6)
  })
})

// ─── FJS-1742 ─────────────────────────────────────────────────────────────

// A removal is owed to the reader who held the row BEFORE the write, and to no
// one else: a socket that could read neither image learns an id and a moment
// from it, which is an activity oracle across a workspace, a tenant or a site.
describe('a removal goes only to a reader who could read the row before (FJS-1742)', () => {

  test('a write to a row a reader never held tells that reader nothing', async () => {
    const { db, port } = await mkApp()
    const owner    = open(port, 'u5')
    const stranger = open(port, 'u9')
    const anon     = open(port)
    expect(await ready(owner)).toBe(true)
    expect(await ready(stranger)).toBe(true)
    expect(await ready(anon)).toBe(true)

    const row = await (db as any).asSystem().order.create({ data: { customerId: '5' } })
    await settle()
    await (db as any).asSystem().order.update({ where: { id: row.id }, data: { status: 'paid' } })
    await settle()

    expect(owner.events.map(e => e.event)).toEqual(['orders created', 'orders updated'])
    expect(stranger.events).toEqual([])
    expect(anon.events).toEqual([])
  })

  test('a narrowing reaches the reader it took the row from and no other', async () => {
    const { db, port } = await mkApp()
    const owner    = open(port, 'u5')
    const next     = open(port, 'u6')
    const stranger = open(port, 'u9')
    for (const s of [owner, next, stranger]) expect(await ready(s)).toBe(true)

    const row = await (db as any).asSystem().order.create({ data: { customerId: '5' } })
    await settle()
    await (db as any).asSystem().order.update({ where: { id: row.id }, data: { customerId: '6' } })
    await settle()

    expect(owner.events.map(e => e.event)).toEqual(['orders created', 'orders removed'])
    expect(next.events.map(e => e.event)).toEqual(['orders updated'])
    expect(stranger.events).toEqual([])
  })

  test('the same through the service: PATCH reaches the owner it narrowed from and not a stranger', async () => {
    const { db, port } = await mkApp()
    const owner    = open(port, 'u5')
    const stranger = open(port, 'u9')
    expect(await ready(owner)).toBe(true)
    expect(await ready(stranger)).toBe(true)

    const row = await (db as any).asSystem().order.create({ data: { customerId: '5' } })
    await settle()
    const res = await fetch(`http://localhost:${port}/orders/${row.id}`, {
      method:  'PATCH',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin' },
      body:    JSON.stringify({ customerId: '6' }),
    })
    expect(res.status).toBe(200)
    await settle()

    expect(owner.events.map(e => e.event)).toEqual(['orders created', 'orders removed'])
    expect(owner.events[1].data).toEqual({ id: row.id })
    expect(stranger.events).toEqual([])
  })
})

// ─── FJS-2159 ─────────────────────────────────────────────────────────────

describe('a write from a second process is graded like a local one (FJS-2159)', () => {

  // The writer is a SPAWNED process: a tap on one client hears only its own
  // writes, so an in-process `create` passes with `announce crossProcess`
  // deleted. Asynchronous spawn, because a blocked event loop here would stop
  // the `fs.watch` callback that delivers the event.
  const writeFromAnotherProcess = (file: string, schema: string, customerId: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'fjs-grade-w-'))
    const f   = join(dir, 'w.mjs')
    writeFileSync(f, `
      const { createClient } = await import(${JSON.stringify(LITESTONE)})
      const db = await createClient({ schema: ${JSON.stringify(schema)} })
      await db.asSystem().order.create({ data: { customerId: ${JSON.stringify(customerId)} } })
      db.$close()
    `)
    return new Promise<void>((res, rej) => {
      let err = ''
      const p = spawn('bun', [f])
      p.stderr.on('data', d => { err += d })
      p.on('exit', code => { rmSync(dir, { recursive: true, force: true }); code === 0 ? res() : rej(new Error(err.slice(0, 400))) })
    })
  }

  test('the owner’s socket gets the row and a stranger’s and an anonymous one get nothing', async () => {
    const dir    = mkdtempSync(join(tmpdir(), 'fjs-grade-'))
    const file   = join(dir, 'app.db')
    const schema = `
      database main {
        path     "${file}"
        announce crossProcess
      }
      model Order {
        id         Int    @id @default(autoincrement())
        customerId Int?
        status     String @default("pending")
        @@db(main)
        @@gate(1.4.4.5)
        @@allow('read', customerId == auth().id || auth().isAdmin)
      }`
    try {
      const { port } = await mkApp({ schema, file })
      const anon  = open(port)
      const other = open(port, 'u9')
      const owner = open(port, 'u5')
      expect(await ready(anon)).toBe(true)
      expect(await ready(other)).toBe(true)
      expect(await ready(owner)).toBe(true)

      await writeFromAnotherProcess(file, schema, '5')
      for (let i = 0; i < 100 && !owner.events.length; i++) await sleep(20)
      await settle()

      expect(owner.events.map(e => e.event)).toEqual(['orders created'])
      expect(owner.events[0].data.customerId).toBe(5)
      expect(anon.events).toEqual([])
      expect(other.events).toEqual([])
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// ─── FJS-1738 ─────────────────────────────────────────────────────────────

// A read policy that crosses a relation makes a Page's readers depend on rows
// of Share, and a Block's on its Page through check(): a revoked share writes
// no page, so a frame graded against the written row reaches no page store.
const REACH_SCHEMA = `
  model Page {
    id     Int     @id @default(autoincrement())
    title  String
    shares Share[]
    blocks Block[]
    @@gate(1.4.4.5)
    @@allow('read', shares.some(userId == auth().id))
  }
  model Share {
    id     Int  @id @default(autoincrement())
    pageId Int
    page   Page @relation(fields: [pageId], references: [id])
    userId Int
    @@gate(1.4.4.5)
    @@allow('read', userId == auth().id)
  }
  model Block {
    id     Int    @id @default(autoincrement())
    pageId Int
    page   Page   @relation(fields: [pageId], references: [id])
    body   String
    @@gate(1.4.4.5)
    @@allow('read', check(page))
  }
  model Tag {
    id   Int    @id @default(autoincrement())
    name String
    @@gate(1.4.4.5)
  }
`

async function mkReachApp() {
  const db: any = await createClient({ db: ':memory:', schema: REACH_SCHEMA })
  const app: any = createApp({
    db,
    logLevel: 'silent',
    config: { port: 0, services: { dir: '/nonexistent' } },
    auth: {
      verifySession: async (token: string) => {
        const u = sessionFor(token)
        if (!u) throw new Error('bad token')
        return u
      },
    },
  })
  for (const [name, model] of [['pages', 'Page'], ['shares', 'Share'], ['blocks', 'Block'], ['tags', 'Tag']])
    app.services.register(createService({ name, model, channel: name }))
  app.configure(channels((a: any) => {
    a.channels.on('connection', (_s: unknown, conn: unknown) => {
      for (const name of ['pages', 'shares', 'blocks', 'tags']) a.channel(name).join(conn)
    })
  }))
  await app.start()
  running.push(app)
  const sys = db.asSystem()
  const page = await sys.page.create({ data: { title: 'D' } })
  await sys.block.create({ data: { pageId: page.id, body: 'one' } })
  return { app, db, sys, page, port: app.http.port as number }
}

describe('a write that changes who may read OTHER rows (FJS-1738)', () => {

  test('a revoked share tells every model whose read reaches Share to re-read', async () => {
    const { sys, page, port } = await mkReachApp()
    const share = await sys.share.create({ data: { pageId: page.id, userId: 5 } })
    const gus = open(port, 'u5')
    const anon = open(port)
    expect(await ready(gus)).toBe(true)
    expect(await ready(anon)).toBe(true)

    await sys.share.delete({ where: { id: share.id } })
    await settle()

    // The Share row is gus's own, so it arrives graded; what it decided — the
    // page and, through check(page), its blocks — arrives as a count-only
    // changed, which is what a live store re-reads on. Tag's read reaches no
    // Share and hears nothing.
    expect(gus.events.map(e => e.event).sort()).toEqual(['blocks changed', 'pages changed', 'shares removed'])
    const changed = gus.events.find(e => e.event === 'pages changed')
    expect(changed.data).toEqual({ model: 'Page', operation: 'regrade', count: null })
    // Gate mode: below the read gate nothing is said, not even that something changed.
    expect(anon.events).toEqual([])
  })

  test('a grant through the SERVICE still reaches the dependent models', async () => {
    const { sys, page, port } = await mkReachApp()
    // The owner's own share, so the page the grant names is one they can read.
    await sys.share.create({ data: { pageId: page.id, userId: 1 } })
    const gus = open(port, 'u5')
    expect(await ready(gus)).toBe(true)
    await settle()
    gus.events.length = 0

    // The service call announces its own row and nothing else, so the
    // dependents are not covered by it.
    const res = await fetch(`http://localhost:${port}/shares`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer admin' },
      body:    JSON.stringify({ pageId: page.id, userId: 5 }),
    })
    expect(res.status).toBe(201)
    await settle()

    expect(gus.events.map(e => e.event).sort()).toEqual(['blocks changed', 'pages changed', 'shares created'])
  })

  test('a burst of writes is one changed per dependent model', async () => {
    const { sys, page, port } = await mkReachApp()
    const gus = open(port, 'u5')
    expect(await ready(gus)).toBe(true)

    await sys.$transaction(async (tx: any) => {
      for (let i = 0; i < 20; i++) await tx.share.create({ data: { pageId: page.id, userId: 100 + i } })
    })
    await settle()

    expect(gus.events.filter(e => e.event === 'pages changed')).toHaveLength(1)
    expect(gus.events.filter(e => e.event === 'blocks changed')).toHaveLength(1)
  })

  test('a write to a model no read policy reaches announces only itself', async () => {
    const { sys, port } = await mkReachApp()
    const gus = open(port, 'u5')
    expect(await ready(gus)).toBe(true)

    await sys.tag.create({ data: { name: 'x' } })
    await settle()

    expect(gus.events.map(e => e.event)).toEqual(['tags created'])
  })
})
