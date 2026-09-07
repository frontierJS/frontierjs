// tests/export-endpoint.test.ts — the governed extract over HTTP.
//
// `FJS-D228` phase 1b under `FJS-D230`. Against a REAL Litestone client and a
// REAL listening server, because every claim here is about what a caller
// actually receives and both halves have to be real for that to mean anything:
// a stubbed client agrees with whatever it was told to agree with, and a
// stubbed transport cannot show that the response STREAMS.
//
// The load-bearing shape is the same one `test/export.test.ts` uses one layer
// down: every refusal is PAIRED with the same request by somebody entitled to
// it. A route that answered nobody would satisfy any test that only asked
// about the refusals.

import { describe, test, expect } from 'bun:test'

import { createClient } from '../../litestone/src/index.js'
import { createApp }    from '../src/core/app.ts'
import { exportPlugin } from '../src/plugins/export/index.ts'

const SCHEMA = `
database main { path "./app.db" }

claim deptId

model Account {
  id      String  @id
  email   String  @unique
  isAdmin Boolean @default(false)
  @@auth
  @@gate("0")
}

/// Reads at 1 behind a row policy, so a shopper sees their own and staff see
/// every one — which is what makes the three standings three different files.
model Order {
  id      Int      @id @default(autoincrement())
  ref     String
  ownerId String
  total   Int      @default(0)
  cardTok String?  @secret
  memo    String?  @guarded
  placed  DateTime @default(now())
  @@gate("1")
  @@allow('read', auth().isAdmin)
  @@allow('read', ownerId == auth().id)
  @@export(ndjson, since: placed)
  @@db(main)
}

/// Declared exportable and gated ABOVE what a shopper reaches, so *this caller
/// may not* and *this dataset is not exportable* are two different answers.
model Ledger {
  id     Int    @id @default(autoincrement())
  entry  String
  @@gate("5")
  @@export(csv)
  @@db(main)
}

/// Guarded by a claim that is on NO user row — the shape an app resolves per
/// request. In example that claim is cartToken; in basecamp it is workspaceId.
/// No backticks in here: this block is inside a template literal, and one
/// closes it (house style, and it cost a parse error the first time).
model Report {
  id     Int    @id @default(autoincrement())
  title  String
  deptId String
  @@gate("1")
  @@allow('read', deptId == auth().deptId)
  @@export(ndjson)
  @@db(main)
}

/// No @@export at all. The negative control for the 404.
model Secret {
  id    Int    @id @default(autoincrement())
  value String
  @@gate("0")
  @@db(main)
}
`

const STAFF   = { id: 'u-staff',  email: 'staff@t.test',  isAdmin: true  }
const SHOPPER = { id: 'u-shop',   email: 'shop@t.test',   isAdmin: false }
const OTHER   = { id: 'u-other',  email: 'other@t.test',  isAdmin: false }
const AS: Record<string, unknown> = { 'tok-staff': STAFF, 'tok-shop': SHOPPER, 'tok-other': OTHER }

async function serve(opts: { maxConcurrent?: number } = {}) {
  // @secret stores ciphertext, so the client needs a key even though no
  // extract here ever carries the column.
  const db = await createClient({ databases: ':memory:', schema: SCHEMA, encryptionKey: 'a'.repeat(64) }) as any

  for (const a of [STAFF, SHOPPER, OTHER]) await db.asSystem().account.create({ data: a })
  await db.asSystem().order.create({ data: { ref: 'A-1', ownerId: 'u-shop',  total: 100, cardTok: 'tok_live_AAA', memo: 'internal' } })
  await db.asSystem().order.create({ data: { ref: 'A-2', ownerId: 'u-shop',  total: 200, cardTok: 'tok_live_BBB', memo: 'internal' } })
  await db.asSystem().order.create({ data: { ref: 'B-1', ownerId: 'u-other', total: 300, cardTok: 'tok_live_CCC', memo: 'internal' } })
  await db.asSystem().ledger.create({ data: { entry: 'opening' } })
  await db.asSystem().report.create({ data: { title: 'north', deptId: 'd-north' } })
  await db.asSystem().report.create({ data: { title: 'south', deptId: 'd-south' } })

  const app = createApp({
    db,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
  })
  app.setAuth({ verifySession: async (t: string) => (AS[t] ?? null) as any })
  app.configure(exportPlugin(opts))
  await app.start()
  return { app, db, port: app.http.port as number }
}

/** The same app, with a `principal` resolver — the half a raw route is below. */
async function serveWithResolver() {
  const db = await createClient({ databases: ':memory:', schema: SCHEMA, encryptionKey: 'a'.repeat(64) }) as any
  for (const a of [STAFF, SHOPPER]) await db.asSystem().account.create({ data: a })
  await db.asSystem().report.create({ data: { title: 'north', deptId: 'd-north' } })
  await db.asSystem().report.create({ data: { title: 'south', deptId: 'd-south' } })

  const app = createApp({
    db,
    // Reads the request, not the row — which is the whole point. A resolver
    // like this is what `membershipClaim` is, one indirection down.
    principal: async (ctx: any) => {
      const dept = ctx.client?.headers?.['x-dept'] ?? ctx.reserved?.dept
      return dept ? { deptId: String(dept) } : {}
    },
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    logLevel: 'silent',
  })
  app.setAuth({ verifySession: async (t: string) => (AS[t] ?? null) as any })
  app.configure(exportPlugin())
  await app.start()
  return { app, port: app.http.port as number }
}

const get = (port: number, path: string, token?: string) =>
  fetch(`http://localhost:${port}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined)

const lines = async (res: Response) => (await res.text()).trim().split('\n').filter(Boolean)

// ─── who may take one ─────────────────────────────────────────────────────

describe('an extract is taken as the caller, or not at all', () => {

  test('three standings, three different files, from one declaration', async () => {
    const { app, port } = await serve()
    try {
      const staff = await get(port, '/exports/Order', 'tok-staff')
      const shop  = await get(port, '/exports/Order', 'tok-shop')
      const other = await get(port, '/exports/Order', 'tok-other')

      expect(staff.status).toBe(200)
      expect((await lines(staff)).length).toBe(3)
      expect((await lines(shop)).length).toBe(2)
      expect((await lines(other)).length).toBe(1)
    } finally { await app.stop() }
  })

  // Paired with the row above: a route that answered nobody passes any test
  // that only asks about this one.
  test('no session is 401, and the system path is not reachable from here', async () => {
    const { app, port } = await serve()
    try {
      expect((await get(port, '/exports/Order')).status).toBe(401)
      expect((await get(port, '/exports')).status).toBe(401)
      // `?system=true` is not an escape — it is not a parameter at all, so the
      // extract is still this caller's.
      const forged = await get(port, '/exports/Order?system=true', 'tok-other')
      expect((await lines(forged)).length).toBe(1)
    } finally { await app.stop() }
  })

  // *You may not read this* and *this is not exportable* are different answers
  // and must not be answered by the same code path.
  test('a gate above the caller empties the extract; an undeclared model 404s', async () => {
    const { app, port } = await serve()
    try {
      const staffLedger = await get(port, '/exports/Ledger', 'tok-staff')
      const shopLedger  = await get(port, '/exports/Ledger', 'tok-shop')
      expect(staffLedger.status).toBe(200)
      expect((await lines(staffLedger)).length).toBe(2)      // header + 1 row

      // A gate refusal is a STATUS CODE, not a 200 that stops. It is decided on
      // the first page read, which the route waits for before answering — and
      // for CSV that is after the column header has been written, so a route
      // that streamed as soon as it could would hand this caller a well-formed
      // file with a header and no rows.
      expect(shopLedger.status).toBe(403)
      expect(await shopLedger.text()).not.toContain('entry')

      const undeclared = await get(port, '/exports/Secret', 'tok-staff')
      expect(undeclared.status).toBe(404)
      expect((await undeclared.json() as any).datasets.sort()).toEqual(['Ledger', 'Order', 'Report'])
    } finally { await app.stop() }
  })
})

// ─── the claim a raw route is below ───────────────────────────────────────
//
// This is `FJS-977` one layer up. A route reading `ctx.user` and calling
// `$setAuth` itself gets a principal short exactly the claims the app resolves
// per request — and a policy reading one of those then matches nothing, so the
// caller is handed an empty extract with a 200. The route runs the SAME around
// hook the service pipeline runs, which is why these rows pass.

describe('a claim the app resolves per request reaches the extract', () => {

  test('the resolver runs, and the extract is that claim\'s rows', async () => {
    const { app, port } = await serveWithResolver()
    try {
      const north = await fetch(`http://localhost:${port}/exports/Report`, {
        headers: { authorization: 'Bearer tok-shop', 'x-dept': 'd-north' },
      })
      const rows = await lines(north)
      expect(rows.length).toBe(1)
      expect(JSON.parse(rows[0]).title).toBe('north')
    } finally { await app.stop() }
  })

  // Paired both ways: a DIFFERENT claim is a different file, and NO claim is
  // an empty one. Without the second, a route that ignored the resolver and
  // returned everything would still pass the first.
  test('a different claim is a different file, and no claim is no rows', async () => {
    const { app, port } = await serveWithResolver()
    try {
      const south = await fetch(`http://localhost:${port}/exports/Report`, {
        headers: { authorization: 'Bearer tok-shop', 'x-dept': 'd-south' },
      })
      expect((await lines(south)).map(l => JSON.parse(l).title)).toEqual(['south'])

      const none = await fetch(`http://localhost:${port}/exports/Report`, {
        headers: { authorization: 'Bearer tok-shop' },
      })
      expect((await lines(none)).length).toBe(0)
    } finally { await app.stop() }
  })
})

// ─── the shape a session actually has ─────────────────────────────────────

describe('a session names the account userId and the boundary reads id', () => {

  // Every fixture above hands `verifySession` an object with `id` on it, which
  // is the ROW's shape and not always the SESSION's. `@frontierjs/auth` issues a
  // context carrying `userId`, and `toDataPrincipal` is the one owner of that
  // translation — `applyClaims` calls it before its own `$setAuth`, and this
  // route has to call it before handing the principal to `runExport`.
  //
  // Getting it wrong is silent in the worst way: `auth().id` compares against
  // NULL, the policy matches no rows, and the caller is handed an empty extract
  // with a 200. Found in `example`, where the same account exported one order
  // through the CLI and none over HTTP.
  test('a userId-shaped session still exports its own rows', async () => {
    const db = await createClient({ databases: ':memory:', schema: SCHEMA, encryptionKey: 'a'.repeat(64) }) as any
    for (const a of [STAFF, SHOPPER]) await db.asSystem().account.create({ data: a })
    await db.asSystem().order.create({ data: { ref: 'MINE',   ownerId: 'u-shop',  total: 1 } })
    await db.asSystem().order.create({ data: { ref: 'THEIRS', ownerId: 'u-other', total: 2 } })

    const app = createApp({
      db,
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
      logLevel: 'silent',
    })
    // No `id` anywhere on it — the shape auth's own session context has.
    app.setAuth({ verifySession: async () => ({ userId: 'u-shop', email: SHOPPER.email, isAdmin: false }) as any })
    app.configure(exportPlugin())
    await app.start()
    try {
      const res  = await get(app.http.port as number, '/exports/Order', 'anything')
      const refs = (await lines(res)).map(l => JSON.parse(l).ref)
      // Paired: the row that IS theirs arrives, and the one that is not does
      // not. A translation that handed everything through passes the first half.
      expect(refs).toEqual(['MINE'])
    } finally { await app.stop() }
  })
})

// ─── whose data ───────────────────────────────────────────────────────────
//
// Under `strategy database` the rows are in a TENANT's file, so WHICH CLIENT is
// a separate question from WHO is asking — and getting it wrong does not look
// like an error, it looks like somebody else's extract. The route takes the
// client the tenant hook assigned; a route reading `app.db` would answer from
// the machinery database, or from whichever tenant happened to be first.

describe('under database tenancy the extract is one tenant\'s', () => {

  const tenantApp = async () => {
    const dbs = new Map<string, any>()
    for (const [id, ref] of [['acme', 'ACME-1'], ['globex', 'GLOBEX-1']]) {
      const c = await createClient({ databases: ':memory:', schema: SCHEMA, encryptionKey: 'a'.repeat(64) }) as any
      await c.asSystem().account.create({ data: STAFF })
      await c.asSystem().order.create({ data: { ref, ownerId: 'u-staff', total: 1 } })
      dbs.set(id, c)
    }
    const registry = {
      list: () => [...dbs.keys()],
      get:  async (id: string) => dbs.get(id),
      exists: (id: string) => dbs.has(id),
      // Off the Host header, which is `resolve subdomain`'s own mechanism.
      tenantFor: ({ host }: { host?: string | null }) =>
        (host ?? '').split('.')[0] || null,
    }
    const app = createApp({
      tenants: registry as any,
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
      logLevel: 'silent',
    })
    app.setAuth({ verifySession: async (t: string) => (AS[t] ?? null) as any })
    app.configure(exportPlugin())
    await app.start()
    return { app, port: app.http.port as number }
  }

  test('two hosts, two extracts, one process', async () => {
    const { app, port } = await tenantApp()
    try {
      const read = async (host: string) => {
        const res = await fetch(`http://localhost:${port}/exports/Order`, {
          headers: { authorization: 'Bearer tok-staff', host },
        })
        expect(res.status).toBe(200)
        return (await lines(res)).map(l => JSON.parse(l).ref)
      }
      // Asserted as a PAIR. One tenant reading its own row proves nothing about
      // isolation — the second is what says the client was resolved per request
      // rather than fixed at boot.
      expect(await read('acme.test')).toEqual(['ACME-1'])
      expect(await read('globex.test')).toEqual(['GLOBEX-1'])
    } finally { await app.stop() }
  })
})

// ─── what leaves ──────────────────────────────────────────────────────────

describe('protected columns do not leave, and the response says so', () => {

  test('a @secret and a @guarded column are absent by name AND by value', async () => {
    const { app, port } = await serve()
    try {
      const res  = await get(port, '/exports/Order', 'tok-staff')
      const body = await res.text()
      const row  = JSON.parse(body.trim().split('\n')[0])

      // The control. A route that returned nothing satisfies everything below.
      expect(Object.keys(row).sort()).toEqual(['id', 'memo', 'ownerId', 'placed', 'ref', 'total'].filter(k => k !== 'memo').sort())
      expect(row.ref).toBe('A-1')

      expect(body).not.toContain('tok_live_AAA')
      expect(body).not.toContain('internal')
      expect(res.headers.get('x-export-withheld')).toContain('cardTok @secret')
      expect(res.headers.get('x-export-withheld')).toContain('memo @guarded')
    } finally { await app.stop() }
  })

  // The one an operator can type on the CLI and must not be able to type here.
  test('includeProtected is not a query parameter', async () => {
    const { app, port } = await serve()
    try {
      const body = await (await get(port, '/exports/Order?includeProtected=true', 'tok-staff')).text()
      expect(body).not.toContain('tok_live_AAA')
    } finally { await app.stop() }
  })
})

// ─── resuming ─────────────────────────────────────────────────────────────

describe('a caller resumes on the column the schema named', () => {

  test('the response names the resume column and honours it', async () => {
    const { app, port } = await serve()
    try {
      const first = await get(port, '/exports/Order', 'tok-staff')
      expect(first.headers.get('x-export-resume-on')).toBe('placed')

      const rows = (await lines(first)).map(l => JSON.parse(l))
      const cut  = rows[0].placed
      const rest = await lines(await get(port, `/exports/Order?since=${encodeURIComponent(cut)}`, 'tok-staff'))
      expect(rest.length).toBeLessThan(rows.length)
    } finally { await app.stop() }
  })

  test('a dataset declaring no since: refuses a cursor rather than ignoring it', async () => {
    const { app, port } = await serve()
    try {
      const res = await get(port, '/exports/Ledger?since=2020-01-01', 'tok-staff')
      expect(res.status).toBe(400)
      expect((await res.json() as any).error).toContain('no @@export(since:)')
    } finally { await app.stop() }
  })
})

// ─── what one request may cost ────────────────────────────────────────────

describe('the route is bounded, and says so in a way a client can act on', () => {

  test('over the cap is 429 with retryable, and the slot comes back', async () => {
    const { app, port } = await serve({ maxConcurrent: 1 })
    try {
      // Held open: the body is not read, so the stream stays in flight.
      const held = await get(port, '/exports/Order', 'tok-staff')
      const over = await get(port, '/exports/Order', 'tok-staff')

      expect(over.status).toBe(429)
      expect((await over.json() as any).retryable).toBe(true)

      await held.text()                       // drains, releasing the slot
      const after = await get(port, '/exports/Order', 'tok-staff')
      expect(after.status).toBe(200)
      await after.text()
    } finally { await app.stop() }
  })
})

// ─── the collection ───────────────────────────────────────────────────────

describe('the app says what may leave', () => {

  test('every declared dataset, with its format and its resume column', async () => {
    const { app, port } = await serve()
    try {
      const body = await (await get(port, '/exports', 'tok-staff')).json() as any[]
      expect(body).toEqual([
        { dataset: 'Ledger', kind: 'model', format: 'csv',    resumeOn: null },
        { dataset: 'Order',  kind: 'model', format: 'ndjson', resumeOn: 'placed' },
        { dataset: 'Report', kind: 'model', format: 'ndjson', resumeOn: null },
      ])
    } finally { await app.stop() }
  })
})
