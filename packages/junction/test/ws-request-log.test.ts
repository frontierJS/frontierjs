// test/ws-request-log.test.ts
//
// `requestLogger` wrapped the HTTP router only, so a call over the socket —
// every call a connected client makes — left no line on the server, a refused
// one included (`FJS-1301`). Replayed held writes drained over the socket and
// four refusals among them produced nothing an operator could read.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { createLogger, type LogEntry } from '../src/core/logger.ts'
import { correlationId, requestLogger } from '../src/transport/middleware.ts'
import { Forbidden } from '../src/core/errors.ts'
import { buildService } from '../src/core/service.ts'


const lines: LogEntry[] = []

const probe = createService({
  name: 'probe',
  methods: ['find', 'patch'],
  async find(_ctx: unknown)  { return [] },
  async patch(_ctx: unknown) { throw new Forbidden('nope') },
})

let app: any

beforeAll(async () => {
  app = createApp({
    logger: createLogger({ level: 'debug', writers: [e => { lines.push(e) }] }),
    config: {
      port:     0,
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  app.services.register(probe)
  app.configure(channels())
  app.configure(correlationId())
  app.configure(requestLogger({ format: 'json' }))
  app.post('/refuse', () => { throw new Forbidden('no') })
  app.get('/ok', (ctx: any) => ctx.json({ ok: true }))
  await app.start()
})

afterAll(async () => { await app?.stop() })

async function call(ws: WebSocket, id: string, method: string, meta: Record<string, unknown>) {
  const done = new Promise<void>(ok => {
    ws.onmessage = (e: any) => {
      const f = JSON.parse(e.data)
      if (f.id === id && (f.type === 'service_result' || f.type === 'service_error')) ok()
    }
  })
  ws.send(JSON.stringify({ type: 'service_call', id, service: 'probe', method, meta }))
  await done
}

test('a socket call, answered or refused, is one request line', async () => {
  const ws = new WebSocket(`ws://localhost:${app.http.port}/ws`)
  await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error('ws')) })
  await call(ws, 'c1', 'find',  { correlationId: 'corr-1' })
  await call(ws, 'c2', 'patch', { id: 7 })
  ws.close()

  const reqs = lines.filter(l => l.message === 'request' && l.data?.transport === 'websocket')
  expect(reqs.map(l => [l.data!.method, l.data!.path, l.data!.status])).toEqual([
    ['find',  'probe',   200],
    ['patch', 'probe/7', 403],
  ])
  expect(reqs[0].data!.correlationId).toBe('corr-1')
})

// A raw route's throw escaped `next()` before anything set `ctx.__status`, so
// the line said 200 over a 403 answer — every refused sign-in a success
// (`FJS-1417`).
test('a raw route that throws is logged with the status it answered', async () => {
  const res = await fetch(`http://localhost:${app.http.port}/refuse`, { method: 'POST' })
  expect(res.status).toBe(403)
  const line = lines.find(l => l.message === 'request' && l.data?.path === '/refuse')
  expect(line?.data?.status).toBe(403)
})

// `requestLogger` read the id from the request scope in its `finally`, after
// the scope had closed, so every HTTP line carried none (`FJS-1414`).
test('an HTTP request line carries the correlation id the response echoes', async () => {
  const res = await fetch(`http://localhost:${app.http.port}/ok`, {
    headers: { 'x-request-id': 'a'.repeat(32) },
  })
  const echoed = res.headers.get('x-request-id')
  expect(echoed).toBe('a'.repeat(32))
  const line = lines.filter(l => l.message === 'request' && l.data?.path === '/ok').at(-1)
  expect(line?.data?.correlationId).toBe(echoed)
})

// ─── log: false ─────────────────────────────────────────────────────────────
// A method a client streams drowned the one line an operator greps. The flag
// hides a call that succeeds and never one that is refused, because the line is
// what a refused call leaves behind (`FJS-D2129`, `FJS-1301`).

describe('a method declared log: false', () => {
  const quietLines: LogEntry[] = []
  const quiet = createService({
    name: 'quiet',
    methods: [
      { method: 'nudge', gate: 0, log: false },
      { method: 'ping',  gate: 0 },
    ],
    async nudge(ctx: any) { if (ctx.data?.refuse) throw new Forbidden('no'); return { ok: true } },
    async ping()          { return { ok: true } },
  })
  let qapp: any

  beforeAll(async () => {
    qapp = createApp({
      logger: createLogger({ level: 'debug', writers: [e => { quietLines.push(e) }] }),
      config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 250 } },
    })
    qapp.services.register(quiet)
    qapp.configure(channels())
    qapp.configure(correlationId())
    qapp.configure(requestLogger({ format: 'json' }))
    await qapp.start()
  })
  afterAll(async () => { await qapp?.stop() })

  const mark     = () => quietLines.length

  async function socketCall(method: string, data?: unknown) {
    const ws = new WebSocket(`ws://localhost:${qapp.http.port}/ws`)
    await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error('ws')) })
    const done = new Promise<void>(ok => {
      ws.onmessage = (e: any) => {
        const f = JSON.parse(e.data)
        if (f.id === 'q1' && (f.type === 'service_result' || f.type === 'service_error')) ok()
      }
    })
    ws.send(JSON.stringify({ type: 'service_call', id: 'q1', service: 'quiet', method, data }))
    await done
    ws.close()
  }

  const httpCall = (method: string, body?: unknown) =>
    fetch(`http://localhost:${qapp.http.port}/quiet/1`, {
      method:  'POST',
      headers: { 'content-type': 'application/json', 'x-service-method': method },
      body:    JSON.stringify(body ?? {}),
    })

  test('writes no line over the socket, while a sibling still does', async () => {
    const from = mark()
    await socketCall('nudge')
    await socketCall('ping')
    const seen = quietLines.slice(from).filter(l => l.message === 'request' && l.data?.transport === 'websocket')
    expect(seen.map(l => l.data!.method)).toEqual(['ping'])
  })

  test('writes no line over HTTP, while a sibling still does', async () => {
    const from = mark()
    expect((await httpCall('nudge')).status).toBe(200)
    expect((await httpCall('ping')).status).toBe(200)
    const seen = quietLines.slice(from).filter(l => l.message === 'request')
    expect(seen.map(l => l.data!.path)).toEqual(['/quiet/1'])
    expect(seen).toHaveLength(1)
  })

  test('a refused call still logs, over both transports', async () => {
    const from = mark()
    await socketCall('nudge', { refuse: true })
    expect((await httpCall('nudge', { refuse: true })).status).toBe(403)
    const seen = quietLines.slice(from).filter(l => l.message === 'request')
    expect(seen.map(l => [l.data!.method, l.data!.status])).toEqual([['nudge', 403], ['POST', 403]])
  })

  test('a CRUD verb declaring it is refused where it is written', () => {
    expect(() => buildService({ name: 'x', methods: [{ method: 'find', log: false }] as any })).toThrow(/CRUD verb/)
  })
})
