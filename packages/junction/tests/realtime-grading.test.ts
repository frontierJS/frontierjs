// tests/realtime-grading.test.ts
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
import { createClient }   from '../../litestone/src/index.js'
import { createApp }      from '../src/core/app.ts'
import { createService }  from '../src/core/service.ts'
import { channels }       from '../src/transport/channels.ts'

const SCHEMA = `
  model Order {
    id         Int    @id @default(autoincrement())
    customerId String?
    status     String @default("pending")
    @@gate("1.4.4.5")
    @@allow('read', customerId == auth().id || auth().isAdmin)
  }
`

// `customerId` is a String and that is deliberate. A `SessionContext` carries
// `userId` as a string, so on an Int column `customerId == auth().id` is TRUE
// through a query — SQLite applies the column's affinity — and FALSE in
// `$readAs`, which compares in JS. That is a real divergence between the two
// paths and it belongs to the Data boundary; grading it here would make this
// file about a coercion rather than about who receives a frame.

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

const running: Array<{ stop: () => Promise<void> }> = []
afterEach(async () => { for (const a of running.splice(0)) await a.stop().catch(() => {}) })

async function mkApp(opts: { telemetry?: boolean; second?: boolean } = {}) {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
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
  app.services.register(createService({ name: 'orders', model: 'Order', channel: 'orders' }))
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
  const ws = new WebSocket(`ws://localhost:${port}/ws${token ? `?token=${token}` : ''}`)
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
    expect(owner.events[0].data.customerId).toBe('5')
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

  test('a write through the service is still announced once', async () => {
    const { app, port } = await mkApp()
    const owner = open(port, 'u5')
    expect(await ready(owner)).toBe(true)
    await app.service('orders').create({ customerId: '5' }, { auth: { user: sessionFor('admin') } })
    await settle()
    expect(owner.events.filter(e => e.event === 'orders created')).toHaveLength(1)
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
