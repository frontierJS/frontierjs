// test/call-signal.test.ts
// A call used to say nothing about whether its caller was still there. A hook
// learned the client hung up only through `ctx.$raw.$req.signal`, so a
// WebSocket or in-process call could never be stopped (`FJS-3117`).
// `ctx.signal` is one AbortSignal on every transport.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { bridge } from '../src/transport/bridge.ts'
import type { TransportContext } from '../src/transport/types.ts'

const seen: Record<string, AbortSignal> = {}
let gate: () => void = () => {}

const probe = createService({
  name: 'probe',
  methods: ['find', 'create'],
  async find(ctx: any)   { seen[ctx.transport] = ctx.signal; return [] },
  async create(ctx: any) {
    seen[ctx.transport] = ctx.signal
    await new Promise<void>(ok => { gate = ok; ctx.signal.addEventListener('abort', () => ok(), { once: true }) })
    return { id: 1, aborted: ctx.signal.aborted }
  },
})

let app: any

beforeAll(async () => {
  app = createApp({ config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 250 } } })
  app.services.register(probe)
  app.configure(channels())
  await app.start()
})

afterAll(async () => { await app?.stop() })

test('an in-process call carries a signal that is quiet until the caller gives one', async () => {
  await app.service('probe').find()
  expect(seen.internal).toBeInstanceOf(AbortSignal)
  expect(seen.internal!.aborted).toBe(false)

  const stop = new AbortController()
  const call = app.service('probe').create({}, { signal: stop.signal })
  await new Promise(r => setTimeout(r, 10))
  stop.abort()
  expect(await call).toEqual({ id: 1, aborted: true })
})

test('bridge.toContext carries the request signal', () => {
  const stop = new AbortController()
  const raw = {
    method: 'GET', path: '/probe', route: {}, query: {}, headers: {}, body: null, files: [],
    ip: '127.0.0.1', protocol: 'http', host: 'localhost', user: null,
    signal: stop.signal,
    $raw: { $req: new Request('http://x'), url: 'http://x' },
  } as unknown as TransportContext
  const ctx = bridge.toContext(raw, 'probe')
  expect(ctx.signal).toBe(stop.signal)
})

test('a socket call sees the signal abort when the socket closes', async () => {
  const ws = new WebSocket(`ws://localhost:${app.http.port}/ws`)
  await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error('ws')) })
  ws.send(JSON.stringify({ type: 'service_call', id: 'c1', service: 'probe', method: 'create', data: {} }))
  await new Promise(r => setTimeout(r, 100))
  expect(seen.websocket).toBeInstanceOf(AbortSignal)
  expect(seen.websocket!.aborted).toBe(false)
  ws.close()
  await new Promise(r => setTimeout(r, 100))
  expect(seen.websocket!.aborted).toBe(true)
})

test('an HTTP call sees the signal abort when the client hangs up', async () => {
  const ctl = new AbortController()
  const sent = fetch(`http://localhost:${app.http.port}/probe`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: ctl.signal,
  }).catch(() => {})
  await new Promise(r => setTimeout(r, 100))
  expect(seen.http).toBeInstanceOf(AbortSignal)
  expect(seen.http!.aborted).toBe(false)
  ctl.abort()
  await sent
  await new Promise(r => setTimeout(r, 100))
  expect(seen.http!.aborted).toBe(true)
})
