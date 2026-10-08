// test/otlp.test.ts — the export door, against a receiver that records (`FJS-D662`).
//
// What can be wrong without anything saying so: a span on the wrong trace, a
// nested call parented to the request instead of its caller, a query span that
// carries the SQL and its params to a third party, a sampled-out request
// exported anyway, a dead collector that fails a request. Each is asserted on
// the BODIES a collector would receive, because the in-process events were
// already right and the translation is the thing under test. The wire format
// against a real collector is the drive in DRIVES.md.
//
// Real HTTP, a real Litestone client, a nested service call from a hook.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash }           from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir }               from 'os'
import { join }                 from 'path'

import { createClient }                               from '../../litestone/src/index.js'
import { createApp, createService, defaultConfig, $ } from '../index.ts'
import { createLogger, type LogEntry }                from '../src/core/logger.ts'
import { otlp, traceIdOf }                            from '../src/plugins/otlp/index.ts'

const TRACE  = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT = '00f067aa0ba902b7'

const SCHEMA = (dir: string) => `
  database main  { path ":memory:" }
  database audit { path "${dir}/audit/" driver trail }
  model Order { id Int @id  status String  @@trail(audit) }
  model Note  { id Int @id  body   String }
`

type Received = { path: string, body: any }
const received: Received[] = []
let receiver: ReturnType<typeof Bun.serve>
let exporter: ReturnType<typeof otlp>
let app: any, db: any, dir: string
let nextId = 1

beforeAll(async () => {
  receiver = Bun.serve({
    port: 0,
    async fetch(req) {
      received.push({ path: new URL(req.url).pathname, body: await req.json() })
      return Response.json({})
    },
  })
  dir = mkdtempSync(join(tmpdir(), 'fjs-otlp-'))
  db  = await createClient({ schema: SCHEMA(dir), resolveFrom: dir })
  app = createApp({
    db:     db as never,
    logger: createLogger({ level: 'debug', writers: [(_: LogEntry) => {}] }),
    config: { name: 'shop', version: '1.2.3', port: 0, services: { dir: '/nonexistent' },
              http: { ...defaultConfig.http, drainTimeout: 250 } },
  })
  exporter = otlp({ endpoint: `http://localhost:${receiver.port}/`, headers: { 'x-api-key': 'k' } })
  app.configure(exporter)
  app.services.register(createService({ name: 'notes', model: 'Note', db: db as never } as never))
  app.services.register(createService({
    name: 'orders', model: 'Order', db: db as never,
    hooks: { before: { create: [async (ctx: any) => {
      $.log.info('placing', { password: 'hunter2' })
      await app.service('notes').create({ id: ctx.data.id, body: 'n' })
    }] } },
  } as never))
  await app.start()
})

afterAll(async () => {
  await app?.stop()
  receiver?.stop(true)
  rmSync(dir, { recursive: true, force: true })
})

async function place(headers: Record<string, string>) {
  received.length = 0
  const id = nextId++
  const res = await fetch(`http://localhost:${app.http.port}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body:   JSON.stringify({ id, status: 'new' }),
  })
  expect(res.status).toBe(201)
  await exporter.flush()
}

const spans = () => received.filter(r => r.path === '/v1/traces')
  .flatMap(r => r.body.resourceSpans[0].scopeSpans[0].spans)
const logs = () => received.filter(r => r.path === '/v1/logs')
  .flatMap(r => r.body.resourceLogs[0].scopeLogs[0].logRecords)
const attrOf = (s: any, key: string) => s.attributes.find((a: any) => a.key === key)?.value

describe('spans', () => {

  test('every span of a request carrying traceparent is on its trace, and the top one hangs off the caller', async () => {
    await place({ traceparent: `00-${TRACE}-${PARENT}-01` })
    const all = spans()
    expect(all.length).toBeGreaterThan(3)
    expect(new Set(all.map(s => s.traceId))).toEqual(new Set([TRACE]))

    const top = all.find(s => s.name === 'orders.create')
    expect(top.parentSpanId).toBe(PARENT)
    expect(top.kind).toBe(2)
    expect(BigInt(top.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(top.startTimeUnixNano))
  })

  test('a call made from a hook is a child of its caller, not of the request', async () => {
    await place({ traceparent: `00-${TRACE}-${PARENT}-01` })
    const top    = spans().find(s => s.name === 'orders.create')
    const nested = spans().find(s => s.name === 'notes.create')
    expect(nested.parentSpanId).toBe(top.spanId)
    expect(nested.kind).toBe(1)
  })

  test('a query span names the table and never carries the SQL, params or args', async () => {
    await place({ traceparent: `00-${TRACE}-${PARENT}-01` })
    const queries = spans().filter(s => s.kind === 3)
    expect(queries.length).toBeGreaterThan(0)
    expect(queries.some(q => attrOf(q, 'db.sql.table')?.stringValue === 'order')).toBe(true)
    const wire = JSON.stringify(queries)
    expect(wire).not.toContain('INSERT')
    expect(wire).not.toContain('"new"')
    expect(queries.every(q => q.parentSpanId)).toBe(true)
  })

  test('a caller that sampled the trace out gets no spans, and its log still exports', async () => {
    await place({ traceparent: `00-${TRACE}-${PARENT}-00` })
    expect(spans()).toEqual([])
    expect(logs().some(l => l.body.stringValue === 'placing')).toBe(true)
  })

  test('an adopted x-request-id is hashed into one trace for the whole request', async () => {
    await place({ 'x-request-id': 'req-abc' })
    const want = createHash('sha256').update('req-abc').digest('hex').slice(0, 32)
    expect(traceIdOf('req-abc')).toBe(want)
    expect(new Set(spans().map(s => s.traceId))).toEqual(new Set([want]))
  })
})

describe('the log', () => {

  test('a log line inside a call carries its trace and span, and a secret key is redacted', async () => {
    await place({ traceparent: `00-${TRACE}-${PARENT}-01` })
    const top  = spans().find(s => s.name === 'orders.create')
    const line = logs().find(l => l.body.stringValue === 'placing')
    expect(line.traceId).toBe(TRACE)
    expect(line.spanId).toBe(top.spanId)
    expect(line.severityText).toBe('INFO')
    expect(JSON.stringify(line)).not.toContain('hunter2')
  })
})

describe('the wire', () => {

  test('resource names the app, and the configured headers are sent', async () => {
    let seen: Headers | null = null
    const probe = Bun.serve({ port: 0, fetch(req) { seen = req.headers; return Response.json({}) } })
    try {
      const one = otlp({ endpoint: `http://localhost:${probe.port}`, headers: { 'x-api-key': 'k' } })
      const solo = createApp({ logger: createLogger({ writers: [] }), config: { name: 'shop', version: '1.2.3', port: 0, services: { dir: '/nonexistent' } } })
      solo.configure(one)
      solo.logger.info('hello')
      await one.flush()
      expect(seen!.get('x-api-key')).toBe('k')
      expect(seen!.get('content-type')).toBe('application/json')
    } finally { probe.stop(true) }

    await place({})
    const res = received.find(r => r.path === '/v1/traces')!.body.resourceSpans[0].resource
    expect(res.attributes).toContainEqual({ key: 'service.name', value: { stringValue: 'shop' } })
    expect(res.attributes).toContainEqual({ key: 'service.version', value: { stringValue: '1.2.3' } })
  })

  test('metric sources leave as gauges, its own counters among them', async () => {
    received.length = 0
    exporter.readMetrics()
    await exporter.flush()
    const metrics = received.filter(r => r.path === '/v1/metrics')
      .flatMap(r => r.body.resourceMetrics[0].scopeMetrics[0].metrics)
    expect(metrics.length).toBeGreaterThan(0)
    expect(metrics.some((m: any) => /otlp\.exported$/.test(m.name))).toBe(true)
    expect(metrics.every((m: any) => typeof m.gauge.dataPoints[0].asDouble === 'number')).toBe(true)
  })
})

describe('a dead collector', () => {

  test('costs telemetry, not the request — counted, warned once', async () => {
    const warned: LogEntry[] = []
    const dead = otlp({ endpoint: 'http://127.0.0.1:9' })
    const solo = createApp({
      logger: createLogger({ level: 'debug', writers: [e => { if (e.level === 'warn') warned.push(e) }] }),
      config: { port: 0, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http, drainTimeout: 250 } },
    })
    solo.configure(dead)
    solo.services.register(createService({ name: 'ping', methods: ['find'], async find() { return [{ ok: true }] } } as never))
    await solo.start()
    try {
      const res = await fetch(`http://localhost:${solo.http.port}/ping`)
      expect(res.status).toBe(200)
      await dead.flush()
      solo.logger.info('again')
      await dead.flush()
      const s = dead.stats()
      expect(s.failed).toBeGreaterThanOrEqual(2)
      expect(s.dropped).toBeGreaterThan(0)
      expect(warned.filter(w => w.message.startsWith('[otlp] export failed'))).toHaveLength(1)
    } finally { await solo.stop() }
  })
})
