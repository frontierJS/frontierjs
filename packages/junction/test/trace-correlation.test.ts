// test/trace-correlation.test.ts — one request, one id (`FJS-D660`).
//
// A request arriving with a `traceparent` and no `x-request-id` filed its log
// line and its audit row under a fresh UUID, while conduit continued the
// upstream trace outbound. An operator holding the vendor's trace id could not
// find the log line, and nothing reported that the two disagreed. Each reader
// was right on its own, so the assertion is the JOIN: the trace id the caller
// stated is the id on the log line and on the trail row. The outbound half is
// conduit's `junction-integration.test.ts`.
//
// Real HTTP, a real Litestone client, a logger that records: the seam is the
// crossing from header to request store to both readers.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir }               from 'os'
import { join }                 from 'path'

import { createClient }                      from '../../litestone/src/index.js'
import { createApp, createService, defaultConfig, $ } from '../index.ts'
import { createLogger, type LogEntry }       from '../src/core/logger.ts'

const TRACE  = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT = `00-${TRACE}-00f067aa0ba902b7-01`

const SCHEMA = (dir: string) => `
  database main  { path ":memory:" }
  database audit { path "${dir}/audit/" driver trail }
  model Order { id Int @id  status String  @@trail(audit) }
`

const lines: LogEntry[] = []
let app: any
let db:  any
let dir: string
let nextId = 1

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fjs-trace-'))
  db  = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
  app = createApp({
    db:     db as never,
    logger: createLogger({ level: 'debug', writers: [e => { lines.push(e) }] }),
    config: { port: 0, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http, drainTimeout: 250 } },
  })
  app.services.register(createService({
    name: 'orders', model: 'Order', db: db as never,
    hooks: { before: { create: [() => { $.log.info('placing') }] } },
  } as never))
  await app.start()
})

afterAll(async () => {
  await app?.stop()
  rmSync(dir, { recursive: true, force: true })
})

/** POST an order with these headers; answer the id on its log line and its trail row. */
async function place(headers: Record<string, string>) {
  const id = nextId++
  const before = (await db.asSystem().auditTrail.findMany({})).length
  const res = await fetch(`http://localhost:${app.http.port}/orders`, {
    method:  'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body:    JSON.stringify({ id, status: 'new' }),
  })
  expect(res.status).toBe(201)
  await new Promise(r => setImmediate(r))
  const line = lines.filter(l => l.message === 'placing').at(-1)
  // The jsonl trail appends in order, so this request's row is the one it added.
  const rows = await db.asSystem().auditTrail.findMany({})
  expect(rows).toHaveLength(before + 1)
  return { log: line?.data?.correlationId as string, trail: rows.at(-1).correlationId as string }
}

describe('a request is filed under one id', () => {

  test('a stated traceparent IS the id on the log line and the trail row', async () => {
    const { log, trail } = await place({ traceparent: PARENT })
    expect(log).toBe(TRACE)
    expect(trail).toBe(TRACE)
  })

  test('traceparent wins over a disagreeing x-request-id', async () => {
    const { log, trail } = await place({ traceparent: PARENT, 'x-request-id': 'req-abc-123' })
    expect(log).toBe(TRACE)
    expect(trail).toBe(TRACE)
  })

  test('with no traceparent, a well-formed x-request-id is the id', async () => {
    const { log, trail } = await place({ 'x-request-id': 'req-abc-123' })
    expect(log).toBe('req-abc-123')
    expect(trail).toBe('req-abc-123')
  })

  test('a malformed inbound id is replaced by a minted trace-shaped one, not refused', async () => {
    for (const headers of <Record<string, string>[]>[
      { 'x-request-id': '<script>alert(1)</script>' },
      { 'x-request-id': 'x'.repeat(129) },
      { traceparent: `00-${'0'.repeat(32)}-00f067aa0ba902b7-01` },
    ]) {
      const { log, trail } = await place(headers)
      expect(log).toMatch(/^[0-9a-f]{32}$/)
      expect(trail).toBe(log)
      expect(log).not.toBe(TRACE)
    }
  })

  test('with nothing stated, the minted id is trace-shaped and differs per request', async () => {
    const a = await place({})
    const b = await place({})
    expect(a.log).toMatch(/^[0-9a-f]{32}$/)
    expect(a.trail).toBe(a.log)
    expect(b.log).not.toBe(a.log)
  })
})
