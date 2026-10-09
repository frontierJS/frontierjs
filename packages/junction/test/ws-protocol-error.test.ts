// test/ws-protocol-error.test.ts
//
// A frame the server cannot act on is refused BY NAME (`FJS-2147`).
//
// Each of these was silent or worse: an unparseable frame and an unknown type
// were dropped with no word, a `service_call` with no id ran and answered an
// id-less result no client could match, and an object `meta.id` was
// stringified into `id=[object Object] not found`. The sender is told with a
// `protocol_error` frame; each refusal sits beside the same thing done right,
// because a transport that refused everything would pass the refusals alone
// (`FJS-351`).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { createApp, channels, createService, defaultConfig } from '../index.ts'

let PORT = 0
let app: any
let ran = 0

function client() {
  const ws = new WebSocket(`ws://localhost:${PORT}/ws`, ['fjs'])
  const frames: any[] = []
  ws.onmessage = (e: any) => {
    try { frames.push(JSON.parse(String(e.data))) } catch { frames.push(String(e.data)) }
  }
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('never connected')), 4000)
    const check = setInterval(() => {
      if (frames.some(f => f?.type === 'connected')) { clearInterval(check); clearTimeout(timer); resolve() }
    }, 10)
    ws.onerror = () => { clearInterval(check); clearTimeout(timer); reject(new Error('ws error')) }
  })
  const wait = async (pred: () => boolean, ms = 1500) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (pred()) return true
      await new Promise(r => setTimeout(r, 10))
    }
    return false
  }
  return {
    ws, frames, ready, wait,
    protocolErrors: () => frames.filter(f => f?.type === 'protocol_error'),
    send: (m: unknown) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    close: () => ws.close(),
  }
}

beforeAll(async () => {
  app = createApp({
    config: { port: 0, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http, drainTimeout: 250 } },
  })
  app.services.register(createService({
    name: 'probe', methods: ['find', 'get'],
    async find() { ran++; return [] },
    async get(ctx: any) { ran++; return { id: ctx.id } },
  }))
  app.configure(channels(() => {}))
  await app.start()
  PORT = (app as unknown as { http: { port: number } }).http.port
})

afterAll(async () => { await app?.stop() })

describe('a frame the server cannot act on (FJS-2147)', () => {
  it('an unparseable frame is refused as malformed_frame', async () => {
    const c = client()
    await c.ready
    c.send('{not json')
    expect(await c.wait(() => c.protocolErrors().length > 0)).toBe(true)
    expect(c.protocolErrors()[0].error.code).toBe('malformed_frame')
    c.close()
  })

  it('a frame of an unknown type is refused as unknown_frame, naming the type', async () => {
    const c = client()
    await c.ready
    c.send({ type: 'frobnicate' })
    expect(await c.wait(() => c.protocolErrors().length > 0)).toBe(true)
    expect(c.protocolErrors()[0].error.code).toBe('unknown_frame')
    expect(c.protocolErrors()[0].error.message).toContain('frobnicate')
    c.close()
  })

  it('a service_call with no id is refused and does NOT run', async () => {
    const c = client()
    await c.ready
    const before = ran
    c.send({ type: 'service_call', service: 'probe', method: 'find' })
    expect(await c.wait(() => c.protocolErrors().length > 0)).toBe(true)
    expect(c.protocolErrors()[0].error.code).toBe('missing_id')
    await new Promise(r => setTimeout(r, 100))
    expect(ran).toBe(before)
    expect(c.frames.some(f => f?.type === 'service_result')).toBe(false)
    c.close()
  })

  it('an object meta.id is refused as invalid_id, answering the call by its id', async () => {
    const c = client()
    await c.ready
    c.send({ type: 'service_call', id: '7', service: 'probe', method: 'get', meta: { id: { a: 1 } } })
    expect(await c.wait(() => c.protocolErrors().length > 0)).toBe(true)
    expect(c.protocolErrors()[0].error.code).toBe('invalid_id')
    expect(c.protocolErrors()[0].id).toBe('7')
    expect(c.frames.some(f => f?.type === 'service_error')).toBe(false)
    c.close()
  })

  it('well-formed frames are answered and draw no protocol_error — the control', async () => {
    const c = client()
    await c.ready
    c.send({ type: 'ping' })
    c.send({ type: 'service_call', id: '1', service: 'probe', method: 'find' })
    c.send({ type: 'service_call', id: '2', service: 'probe', method: 'get', meta: { id: 42 } })
    c.send({ type: 'service_call', id: '3', service: 'probe', method: 'get', meta: { id: 'abc' } })
    expect(await c.wait(() => c.frames.filter(f => f?.type === 'service_result').length === 3)).toBe(true)
    expect(c.frames.some(f => f?.type === 'pong')).toBe(true)
    expect(c.protocolErrors()).toEqual([])
    c.close()
  })
})
