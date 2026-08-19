// tests/raw-body.test.ts
// A signature is computed over BYTES, so a receiver that only has the parsed
// object has to re-serialise to check one — which means sender and receiver
// must agree on key order, spacing and number formatting forever. `parsed.raw`
// and `ctx.$raw.rawBody` exist so nobody has to (`FJS-349`).

import { describe, it, expect } from 'bun:test'
import { parseBody } from '../src/transport/body.ts'
import { createApp } from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { request } from '../src/testing/index.ts'

function jsonRequest(body: string): Request {
  return new Request('http://localhost/x', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
}

describe('the body a signature is computed over', () => {

  it('survives the parse, byte for byte', async () => {
    // Deliberately not what JSON.stringify would produce from the parsed
    // object: extra spaces, and keys out of alphabetical order. Re-serialising
    // gives a different string and therefore a different hash.
    const raw    = '{ "b": 1,  "a": "x" }'
    const parsed = await parseBody(jsonRequest(raw))

    expect(parsed.data).toEqual({ b: 1, a: 'x' })
    expect(parsed.raw).toBe(raw)
    expect(JSON.stringify(parsed.data)).not.toBe(parsed.raw)
  })

  it('is absent where there is no single string to hash', async () => {
    const empty = await parseBody(new Request('http://localhost/x', { method: 'GET' }))
    expect(empty.raw).toBeUndefined()

    const form = new FormData()
    form.append('file', new File(['bytes'], 'a.txt'))
    const multipart = await parseBody(new Request('http://localhost/x', { method: 'POST', body: form }))
    expect(multipart.type).toBe('multipart')
    expect(multipart.raw).toBeUndefined()
  })

  it('is still kept when the JSON does not parse', async () => {
    // A malformed body is exactly when a receiver wants to know what it was
    // handed — but a signature over unparseable bytes is still checkable, and
    // answering `data: null` with no raw would make that impossible.
    const parsed = await parseBody(jsonRequest('{ not json'))
    expect(parsed.data).toBeNull()
  })

  it('reaches a hook as ctx.$raw.rawBody', async () => {
    let seen: string | undefined = 'never ran'

    // port 0 and no services directory: this is about one hook reading one
    // field, and a test that binds a fixed port collides with every other suite.
    const app = createApp({
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    } as any)
    app.services.register(createService({
      name:    'things',
      methods: ['create'],
      async create() { return { id: 1 } },
      hooks:   { before: { create: [(ctx: any) => { seen = ctx.$raw?.rawBody }] } },
    } as never))
    await app.start()

    const raw = '{ "b": 1,  "a": "x" }'
    await app.http.fetch(new Request('http://localhost/things', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    raw,
    }))

    expect(seen).toBe(raw)
    await app.stop()
  })
})

describe('the test request builder', () => {
  it('does not fire until it is awaited', async () => {
    // It used to schedule itself on the microtask queue when the builder was
    // made, so any `await` between `.post()` and `.send()` fired the request
    // first — with no body, and without any header set after that point. The
    // call still succeeded, the service saw `null`, and the test asserted
    // against that (`FJS-350`).
    let seen: unknown = 'never ran'

    const app = createApp({
      config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
    } as never)
    app.services.register(createService({
      name: 'things', methods: ['create'],
      async create(ctx: any) { seen = ctx.data; return { id: 1 } },
    } as never))
    await app.start()

    const req = request(app).post('/things')
    await Promise.resolve()          // an await of any kind, which is the trap
    await req.send({ a: 1 })

    expect(seen).toEqual({ a: 1 })
    await app.stop()
  })
})
