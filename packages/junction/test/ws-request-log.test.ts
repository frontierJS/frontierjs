// test/ws-request-log.test.ts
//
// `requestLogger` wrapped the HTTP router only, so a call over the socket —
// every call a connected client makes — left no line on the server, a refused
// one included (`FJS-1301`). Replayed held writes drained over the socket and
// four refusals among them produced nothing an operator could read.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { createLogger, type LogEntry } from '../src/core/logger.ts'
import { requestLogger } from '../src/transport/middleware.ts'
import { Forbidden } from '../src/core/errors.ts'


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
      database: { url: '', log: false },
      services: { dir: '/nonexistent' },
      http:     { ...defaultConfig.http, drainTimeout: 250 },
    },
  })
  app.services.register(probe)
  app.configure(channels())
  app.configure(requestLogger({ format: 'json' }))
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
