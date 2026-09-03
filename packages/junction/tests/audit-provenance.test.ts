// tests/audit-provenance.test.ts — WHERE a write came from, on the audit row.
//
// The trail recorded who (`actorId`) and what (`model`, `records`, before/after)
// and nothing about the request that carried the write — no correlation id, no
// ip, no user agent, no tenant. So an app log line and the audit row from the
// same request could not be joined by anything, which is the join the whole of
// `$.log` exists to make possible from the other side.
//
// Asserted against a REAL Litestone client and a REAL app, because the seam is
// the crossing: junction hands litestone a closure over its own request store
// and litestone calls it when it builds an entry. Two unit tests, one on each
// side of that closure, both pass with it unwired.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, chmodSync } from 'fs'
import { tmpdir } from 'os'
import { join }   from 'path'

import { createClient } from '../../litestone/src/index.js'
import { createApp }    from '../src/core/app.ts'
import { collectMetrics } from '../src/transport/health.ts'
import { createService } from '../src/core/service.ts'
import { enterRequest } from '../src/core/context.ts'

// A logger database is a DIRECTORY of jsonl, so this one needs a real path —
// `:memory:` has nowhere to append.
const SCHEMA = (dir: string) => `
  database main  { path ":memory:" }
  database audit { path "${dir}/audit/" driver logger }
  model Order { id Int @id  status String  @@log(audit) }
`

// fireLog defers one tick and the jsonl driver appends synchronously, so
// anything after an await sees the row. Yield once; there is no timer.
const tick = () => new Promise((r) => setImmediate(r))

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-audit-'))
  const db  = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
  const app = createApp({ db: db as never })
  app.services.register(createService({ name: 'orders', model: 'Order', db: db as never }))
  await app._startForTest()
  return {
    app, db, dir,
    rows: async () => {
      await tick()
      return (db as any).asSystem().auditLogs.findMany({})
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('an audit row says where the write came from', () => {

  test('it carries the correlation id of the request that caused it', async () => {
    const h = await harness()
    try {
      await h.app.service('orders').create({ id: 1, status: 'new' })
      const [row] = await h.rows()
      expect(typeof row.correlationId).toBe('string')
      expect(row.correlationId.length).toBeGreaterThan(0)
    } finally { h.cleanup() }
  })

  test('two requests write two ids — the id is not a constant', async () => {
    // The negative control. A hardcoded id passes the test above.
    const h = await harness()
    try {
      await h.app.service('orders').create({ id: 1, status: 'new' })
      await h.app.service('orders').create({ id: 2, status: 'new' })
      const rows = await h.rows()
      expect(rows).toHaveLength(2)
      expect(rows[0].correlationId).not.toBe(rows[1].correlationId)
    } finally { h.cleanup() }
  })

  test('`source` is the call, not a URL — one answer for both transports', async () => {
    // A socket frame has no URL and a job has no request at all, which is why
    // this stands where laravel-auditing puts `url`.
    const h = await harness()
    try {
      await h.app.service('orders').create({ id: 1, status: 'new' })
      const [row] = await h.rows()
      expect(row.source).toBe('orders.create')
      expect(row.origin).toBe('internal')
    } finally { h.cleanup() }
  })

  test('a write with NO request behind it answers nulls, not nothing', async () => {
    // A seed, a migration, a job outside a call. The columns stay present so a
    // reader never has to tell "absent" from "not applicable".
    const h = await harness()
    try {
      await (h.db as any).asSystem().order.create({ data: { id: 9, status: 'new' } })
      const [row] = await h.rows()
      expect(row.correlationId).toBeNull()
      expect(row.source).toBeNull()
      expect(row.ip).toBeNull()
      expect(row.tenant).toBeNull()
      // Still a real entry — the write is recorded, only its provenance is not.
      expect(row.operation).toBe('create')
      expect(row.model).toBe('order')
    } finally { h.cleanup() }
  })

  test('the client ip and user agent ride along', async () => {
    // Entered the way a transport does. `client` is not a CallOptions key and
    // must not be: WHERE a request came from belongs to the request, so it is
    // stated once at the edge and propagates to every call inside it — which
    // is exactly what makes it reachable from an audit row three calls deep.
    const h = await harness()
    try {
      await enterRequest(
        { origin: 'http', client: { ip: '10.1.2.3', userAgent: 'probe/1', headers: {} } },
        () => h.app.service('orders').create({ id: 1, status: 'new' }),
      )
      const [row] = await h.rows()
      expect(row.ip).toBe('10.1.2.3')
      expect(row.userAgent).toBe('probe/1')
      expect(row.origin).toBe('http')
    } finally { h.cleanup() }
  })

  test('a nested call records the OUTER request — provenance is request-wide', async () => {
    // The reason `client` propagates at all: an audit hook three calls deep
    // needs the ip of the request that caused the write, and there is no other
    // route to it.
    const h = await harness()
    h.app.services.register(createService({
      name: 'checkout', methods: ['create'],
      async create(ctx: any) { await ctx.app.service('orders').create({ id: 7, status: 'new' }); return { ok: true } },
    } as never))
    try {
      await enterRequest(
        { origin: 'websocket', client: { ip: '9.9.9.9', headers: {} } },
        () => h.app.service('checkout').create({}),
      )
      const [row] = await h.rows()
      expect(row.ip).toBe('9.9.9.9')
      expect(row.origin).toBe('websocket')
      // The SOURCE is the innermost call — which service actually wrote it —
      // while the request facts are the outermost. The two move at different
      // rates and that is the whole point of holding them in two stores.
      expect(row.source).toBe('orders.create')
    } finally { h.cleanup() }
  })

  test('a provider that throws costs the columns and not the write', async () => {
    // The audit row is a side effect of a write that already succeeded. A
    // provenance function that throws must not take the entry with it, and must
    // not take the WRITE with it either.
    const h = await harness()
    try {
      ;(h.db as any).$logContext(() => { throw new Error('boom') })
      const created = await h.app.service('orders').create({ id: 1, status: 'new' }) as { id: number }
      expect(created.id).toBe(1)
      const [row] = await h.rows()
      expect(row.operation).toBe('create')
      expect(row.correlationId).toBeNull()
    } finally { h.cleanup() }
  })

  test('the trail is counted, so a trail that STOPPED is visible on /metrics', async () => {
    // fireLog is fire-and-forget by design, so a broken trail warns once on
    // stderr and is then indistinguishable from an app doing no work. The
    // counters are what make the absence askable.
    const h = await harness()
    try {
      expect((h.db as any).$logStats().written).toBe(0)
      await h.app.service('orders').create({ id: 1, status: 'new' })
      await h.rows()
      const stats = (h.db as any).$logStats()
      expect(stats.written).toBeGreaterThan(0)
      expect(stats.dropped).toBe(0)
      expect(typeof stats.lastWrittenAt).toBe('string')
      // It is on /metrics through the app's own source registry, not a second
      // reader reaching into the client — `collectMetrics` is the body the
      // route calls, and the devtools console is its other reader.
      const metrics = collectMetrics(h.app as never, Date.now()) as any
      expect(metrics.audit?.written).toBe(stats.written)
    } finally { h.cleanup() }
  })

  test('a DROPPED write is counted and named', async () => {
    // The negative control for the counter above: `written` alone cannot tell a
    // quiet app from a broken trail, so the drop has to be counted separately
    // and has to carry WHY.
    //
    // Broken by making the trail FILE unwritable, so the write fails inside the
    // deferred, swallowed path rather than at the call.
    //
    // It used to chmod the DIRECTORY, and that stopped forcing a drop once the
    // companion index moved to WAL (`FJS-665`): under a rollback journal the
    // index needed to create a `-journal` file on every write, which a read-only
    // directory refuses, and under WAL the `-wal` and `-shm` already exist so
    // the write goes through. The trail now records where it used to lose rows —
    // a better answer, and the wrong lever for this test.
    const h = await harness()
    try {
      await h.app.service('orders').create({ id: 1, status: 'new' })
      await h.rows()
      const before = (h.db as any).$logStats()
      expect(before.written).toBeGreaterThan(0)

      const trail = join(h.dir, 'audit', 'auditLogs.jsonl')
      chmodSync(trail, 0o400)
      await h.app.service('orders').create({ id: 2, status: 'new' })
      await tick(); await tick()
      chmodSync(trail, 0o600)

      const stats = (h.db as any).$logStats()
      expect(stats.dropped).toBeGreaterThan(0)
      expect(typeof stats.lastError).toBe('string')
      expect(typeof stats.lastDroppedAt).toBe('string')
    } finally { h.cleanup() }
  })

  test('$logContext refuses a non-function rather than silently doing nothing', async () => {
    const h = await harness()
    try {
      expect(() => (h.db as any).$logContext('nope')).toThrow(/expected a function/)
    } finally { h.cleanup() }
  })
})
