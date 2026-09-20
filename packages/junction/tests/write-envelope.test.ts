// tests/write-envelope.test.ts — the base row reaching the boundary, down both
// transports (`FJS-D338`, `FJS-1202`).
//
// `@@sync(field)` merges a held write column by column against the row the
// writer READ, and that row has to cross the wire. Every other per-call value
// junction carries over HTTP is a header — an idempotency key, a correlation
// id — and a base is a ROW, so a text column puts it past what a header may
// hold. A write's body already IS its data, so a call carrying one flags the
// body and puts both inside.
//
// **The socket needs none of that** — a `service_call` frame already carries
// caller extras under `meta` — which is exactly why this file exists: two
// transports doing genuinely different things have to arrive at one `ctx.base`,
// and nothing on either side alone can see that they do.
//
// The assertion that matters is the LAST one: with no base stated, `ctx.base`
// is null and the body is the data, exactly as before. An envelope that leaked
// into ordinary writes would be a wire change for every app.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { createJunctionClient }      from '../src/client/index.ts'

const PORT = 3491

let app: any
let overHttp: any
let overSocket: any

beforeAll(async () => {
  app = createApp({
    config: { port: PORT, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http } },
  } as never)
  app.configure(channels() as never)
  app.services.register(createService({
    name:  'probe',
    // Answers what the boundary actually received, which is the only thing
    // worth asserting — a client that sent an envelope nobody unwrapped would
    // otherwise pass every test on its own side.
    patch: async (ctx: any) => ({ transport: ctx.transport, data: ctx.data, base: ctx.base ?? null }),
    methods: ['patch'],
  } as never))
  await app.start()

  overHttp   = createJunctionClient({ url: `http://127.0.0.1:${PORT}` })
  overSocket = createJunctionClient({ url: `http://127.0.0.1:${PORT}` })
  overSocket.connect()
  for (let i = 0; i < 100 && !overSocket._wsReady; i++) await new Promise(r => setTimeout(r, 50))
})

afterAll(async () => { await app?.stop() })

const patch = (client: any, data: any, opts?: any) =>
  client.service('probe').patch('ROW-1', data, undefined, opts)

const BASE = { id: 'ROW-1', title: 'as read', body: 'one', version: 3 }

describe('a base row means the same thing on both transports', () => {

  test('the two clients really are on different transports', async () => {
    expect((await patch(overHttp,   { a: 1 })).transport).toBe('http')
    expect((await patch(overSocket, { a: 1 })).transport).toBe('websocket')
  })

  test('the base arrives whole over HTTP, in an envelope', async () => {
    const r = await patch(overHttp, { body: 'two' }, { base: BASE })
    expect(r.base).toEqual(BASE)
    // And the data is still the data — the envelope is unwrapped, not merged.
    expect(r.data).toEqual({ body: 'two' })
  })

  test('the base arrives whole over the socket, with no envelope', async () => {
    const r = await patch(overSocket, { body: 'two' }, { base: BASE })
    expect(r.base).toEqual(BASE)
    expect(r.data).toEqual({ body: 'two' })
  })

  test('and the two agree', async () => {
    const http = await patch(overHttp,   { body: 'two' }, { base: BASE })
    const ws   = await patch(overSocket, { body: 'two' }, { base: BASE })
    expect(http.base).toEqual(ws.base)
    expect(http.data).toEqual(ws.data)
  })

  // A base whose own columns are named `data` or `base` is the case the FLAG
  // exists for: the shape of a body cannot answer whether it is an envelope,
  // because a row may legitimately hold either key.
  test('a row holding its own `data` column is not mistaken for an envelope', async () => {
    const odd = { id: 'ROW-1', data: 'a column really called data', base: 'and one called base' }
    const r = await patch(overHttp, { body: 'two' }, { base: odd })
    expect(r.base).toEqual(odd)
    expect(r.data).toEqual({ body: 'two' })
  })

  test('with no base the body is the data and ctx.base is null, on both', async () => {
    const http = await patch(overHttp,   { body: 'two' })
    const ws   = await patch(overSocket, { body: 'two' })
    expect(http.base).toBeNull()
    expect(ws.base).toBeNull()
    expect(http.data).toEqual({ body: 'two' })
    expect(ws.data).toEqual({ body: 'two' })
  })
})

describe('what the envelope refuses', () => {

  test('a body flagged as an envelope that is not one is refused BY NAME', async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/probe/ROW-1`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Fjs-Write': 'enveloped' },
      body:    JSON.stringify({ body: 'two' }),   // no `data` key — not an envelope
    })
    expect(res.status).toBe(400)
    const body = await res.json() as any
    expect(JSON.stringify(body)).toContain('enveloped write')
  })

  test('an unflagged body carrying a `data` key stays data', async () => {
    const r = await patch(overHttp, { data: 'just a column', base: 'another' })
    expect(r.base).toBeNull()
    expect(r.data).toEqual({ data: 'just a column', base: 'another' })
  })
})
