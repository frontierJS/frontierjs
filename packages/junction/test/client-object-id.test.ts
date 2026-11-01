// test/client-object-id.test.ts
//
// `service.invoke('file', { path })` puts an object in the id slot, because the
// signature is `invoke(name, id, data, query)`. The server refuses an object
// `meta.id` with a `protocol_error` frame naming the call, but the client never
// read that frame, so the caller waited out a 408 for a call that was refused
// at once (`FJS-3769`). The client now refuses the id before it leaves, naming
// the method, and settles a pending call on a `protocol_error` carrying its id.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createApp, channels, createService, defaultConfig } from '../index.ts'
import { createJunctionClient } from '../src/client/index.ts'

let app: any
let URL_: string
let ran = 0

beforeAll(async () => {
  app = createApp({
    logLevel: 'silent',
    config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 250 } },
  })
  app.services.register(createService({
    name: 'claude', methods: ['file'],
    async file() { ran++; return { ok: true } },
  }))
  app.configure(channels(() => {}))
  await app.start()
  URL_ = `http://localhost:${app.http.port}`
})

afterAll(async () => { await app?.stop() })

const connected = async () => {
  const client = createJunctionClient({ url: URL_, timeout: 1_500 }) as any
  const up = new Promise<void>(r => client.once('connect', () => r()))
  client.connect()
  await up
  return client
}

describe('an object in the id slot (FJS-3769)', () => {
  test('over the socket: refused at once with a 400 that names the method', async () => {
    const client = await connected()
    const t0 = Date.now()
    const err: any = await client.service('claude').invoke('file', { path: 'a' }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.code).toBe(400)
    expect(err.message).toContain('claude.file')
    expect(Date.now() - t0).toBeLessThan(1_000)
    expect(ran).toBe(0)
    client.disconnect()
  })

  test('over HTTP: the same refusal, before any request', async () => {
    const client = createJunctionClient({ url: URL_, timeout: 1_500 }) as any
    const err: any = await client.service('claude').invoke('file', { path: 'a' }).catch((e: unknown) => e)
    expect(err.code).toBe(400)
    expect(err.message).toContain('claude.file')
    expect(ran).toBe(0)
  })

  test('a string and a number id still reach the service — the control', async () => {
    const client = await connected()
    expect(await client.service('claude').invoke('file', 'x')).toEqual({ ok: true })
    expect(await client.service('claude').invoke('file', 7)).toEqual({ ok: true })
    expect(ran).toBe(2)
    client.disconnect()
  })

  test('a protocol_error carrying a pending call id rejects that call', async () => {
    const client = await connected()
    // Sent past the client's own check, as a stale or foreign client would.
    const settled = new Promise<any>(resolve => {
      client._wsCallMap.set('900', { resolve, reject: resolve })
    })
    client._ws.send(JSON.stringify({
      type: 'service_call', id: '900', service: 'claude', method: 'file', meta: { id: { a: 1 } },
    }))
    const err = await settled
    expect(err.code).toBe(400)
    expect(err.message).toContain('meta.id')
    client.disconnect()
  })
})
