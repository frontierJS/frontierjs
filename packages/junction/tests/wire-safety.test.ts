// tests/wire-safety.test.ts
//
// What the wire may carry, asked of a REAL app over real HTTP — a Litestone
// client on `:memory:`, junction's own transport, no stubs. Two defects that a
// unit test on either side cannot see, because both are about the moment a
// value crosses the boundary:
//
//   • FJS-683 — `$limit=-1` reaches SQLite as `LIMIT -1`, which SQLite reads
//     as NO limit. The one directive a paginated endpoint exists to bound was
//     the way past the bound, and the ceiling was the only bound written.
//   • FJS-686 — a 500's `message` was the raw exception text (paths, SQL,
//     table names) and `data` reached the wire unredacted, so a domain error
//     that attached the row it refused sent that row's `@secret` with it.
//
// The production half has to be asserted with NODE_ENV really set: the whole
// rule is a branch on it, and a test that runs under `test` grades the dev
// path and reports it as the production one.

import { describe, test, expect, afterAll } from 'bun:test'
import { createClient } from '../../litestone/src/index.js'
import { createApp } from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'

const SCHEMA = `
  model Note {
    id     Int    @id
    title  String
    secret String @secret
  }
`

const ENV = process.env.NODE_ENV
afterAll(() => { process.env.NODE_ENV = ENV })

class Refused extends Error {
  data: unknown
  constructor(message: string, data: unknown) { super(message); this.data = data }
}

async function mkApp() {
  // `@secret` is `@encrypted @guarded`, so the client wants a key. Fixed
  // rather than generated: what is asserted is that the value never leaves,
  // and a key that changes per run cannot be told from one that never worked.
  const db  = await createClient({
    db: ':memory:', schema: SCHEMA,
    encryptionKey: '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
  })
  const sys = (db as never as { asSystem(): Record<string, { create(a: unknown): Promise<unknown> }> }).asSystem()
  for (let i = 1; i <= 150; i++)
    await sys.note.create({ data: { title: `note ${i}`, secret: `hunter2-${i}` } })

  const app = createApp({
    db: db as never,
    config: { port: 0 } as never,
  })
  app.services.register(createService({
    name: 'notes', model: 'Note', db: db as never,
    methods: ['find', 'get', 'create', 'boom', 'withRow', 'versionish'],
    // A raw SQLite failure — the shape that put a table name and the absolute
    // path of the database file on the wire.
    async boom(ctx) {
      return (ctx.locals.db as never as { asSystem(): { sql: (s: TemplateStringsArray) => unknown } })
        .asSystem().sql`INSERT INTO no_such_table VALUES (1)`
    },
    // A domain refusal that helpfully attaches the row it refused.
    async withRow(ctx) {
      const row = await (ctx.locals.db as never as { asSystem(): { note: { findFirst(a: unknown): Promise<unknown> } } })
        .asSystem().note.findFirst({ where: { id: 1 }, select: { id: true, title: true, secret: true } })
      throw new Refused('cannot be done', { row, note: 'why' })
    },
    // VersionConflictError's shape: a plain object of numbers, and none of its
    // keys is a protected field. It must survive the walk untouched.
    async versionish() {
      throw Object.assign(new Error('the row moved'), {
        status: 409, retryable: true,
        data: { model: 'Note', field: 'version', expected: 3, actual: 4 },
      })
    },
  }))
  await app._startForTest()
  app.http.router.build()
  return app
}

async function http(app: Awaited<ReturnType<typeof mkApp>>, method: string, path: string, headers: Record<string, string> = {}) {
  const res  = await (app.http as never as { fetch(r: Request): Promise<Response> })
    .fetch(new Request(`http://localhost${path}`, { method, headers: { 'content-type': 'application/json', ...headers } }))
  const text = await res.text()
  let body: unknown
  try { body = JSON.parse(text) } catch { body = text }
  return { status: res.status, body: body as Record<string, unknown>, text }
}

// ─── FJS-683 ──────────────────────────────────────────────────────────────

describe('a window that cannot be served (FJS-683)', () => {

  test('$limit=-1 is refused by name, not served as the whole table', async () => {
    const app = await mkApp()
    const res = await http(app, 'GET', '/notes?$limit=-1')

    expect(res.status).toBe(400)
    expect(res.body.message).toContain('$limit')
    // The measured failure: LIMIT -1 is unbounded, so this used to be every
    // row in the table from an endpoint capped at 25.
    expect(res.text).not.toContain('note 150')
    await app.stop()
  })

  test('$offset=-5 likewise', async () => {
    const app = await mkApp()
    const res = await http(app, 'GET', '/notes?$offset=-5')
    expect(res.status).toBe(400)
    expect(res.body.message).toContain('$offset')
    await app.stop()
  })

  test('a legitimate window is unchanged, and the ceiling still holds', async () => {
    const app = await mkApp()
    const ok  = await http(app, 'GET', '/notes?$limit=5')
    expect(ok.status).toBe(200)
    expect((ok.body.data as unknown[]).length).toBe(5)

    // The ceiling is the half that already worked; it is here as the control,
    // so a clamp that refused everything would not look like a clamp that works.
    const over = await http(app, 'GET', '/notes?$limit=9999')
    expect(over.status).toBe(200)
    expect((over.body.data as unknown[]).length).toBe(100)
    await app.stop()
  })
})

// ─── FJS-686 ──────────────────────────────────────────────────────────────

describe('what a failure may say (FJS-686)', () => {

  test('in production a 500 is generic and carries the correlation id', async () => {
    process.env.NODE_ENV = 'production'
    const app = await mkApp()

    const logged: string[] = []
    const logger = app.logger as unknown as { error: (m: string, meta?: unknown) => void }
    const original = logger.error
    logger.error = (m: string, meta?: unknown) => { logged.push(`${m} ${JSON.stringify(meta ?? {})}`) }

    let res
    try {
      res = await http(app, 'POST', '/notes', { 'x-service-method': 'boom', 'x-request-id': 'corr-1' })
    } finally {
      logger.error = original
      process.env.NODE_ENV = ENV
    }

    expect(res.status).toBe(500)
    expect(res.body.message).toBe('Internal Server Error (correlation id: corr-1)')
    // Nothing about the database on the wire…
    expect(res.text).not.toContain('no_such_table')
    expect(res.text).not.toContain('SQLITE')
    // …and the original where the operator can read it.
    expect(logged.join('\n')).toContain('no_such_table')
    expect(logged.join('\n')).toContain('corr-1')
    await app.stop()
  })

  test('in development the sentence is still the real one', async () => {
    process.env.NODE_ENV = 'development'
    const app = await mkApp()
    const res = await http(app, 'POST', '/notes', { 'x-service-method': 'boom' })
    process.env.NODE_ENV = ENV
    expect(res.status).toBe(500)
    expect(res.text).toContain('no_such_table')
    await app.stop()
  })

  test('a protected column on an error payload is [redacted]', async () => {
    const app = await mkApp()
    const res = await http(app, 'POST', '/notes', { 'x-service-method': 'withRow' })

    expect(res.status).toBe(500)
    const data = res.body.data as { row: Record<string, unknown>, note: string }
    expect(data.row.secret).toBe('[redacted]')
    // The rest of the payload survives, or the redaction is indistinguishable
    // from dropping `data` altogether.
    expect(data.row.title).toBe('note 1')
    expect(data.note).toBe('why')
    expect(res.text).not.toContain('hunter2')
    await app.stop()
  })

  test('a 409 keeps its declared payload — the walk only redacts protected keys', async () => {
    const app = await mkApp()
    const res = await http(app, 'POST', '/notes', { 'x-service-method': 'versionish' })

    expect(res.status).toBe(409)
    expect(res.body.data).toEqual({ model: 'Note', field: 'version', expected: 3, actual: 4 })
    expect(res.body.retryable).toBe(true)
    await app.stop()
  })
})
