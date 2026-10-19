// A JSON body that does not parse is answered as exactly that (`FJS-1415`).
//
// It used to reach the service as `data: null`, so a client with a
// serialisation bug was told its first required field was empty. The parse
// result still carries the bytes — a signature over them stays checkable — and
// the transport refuses the request once the credential has had its look.

import { describe, it, expect } from 'bun:test'
import { parseBody } from '../src/transport/body.ts'
import { createApp } from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'

function post(body: string, type = 'application/json'): Request {
  return new Request('http://localhost/things', { method: 'POST', headers: { 'content-type': type }, body })
}

async function boot(seen: { calls: number, data: unknown }) {
  const app = createApp({ config: { port: 0 } } as never)
  app.services.register(createService({
    name: 'things', methods: ['create'],
    async create(ctx: any) { seen.calls++; seen.data = ctx.data; return { id: 1 } },
  } as never))
  await app.start()
  return app
}

describe('a JSON body that does not parse', () => {
  it('is marked malformed by the parser, with its bytes kept', async () => {
    const parsed = await parseBody(post('{"q":"…"'))
    expect(parsed.malformed).toBe(true)
    expect(parsed.data).toBeNull()
    expect(parsed.bytes?.byteLength).toBeGreaterThan(0)
  })

  it('is answered 400 saying so, and never reaches the service', async () => {
    const seen = { calls: 0, data: undefined as unknown }
    const app  = await boot(seen)
    const res  = await app.http.fetch(post('{"q":"…"'))
    expect(res.status).toBe(400)
    expect(await res.text()).toContain('not valid JSON')
    expect(seen.calls).toBe(0)
    await app.stop()
  })

  it('is not confused with the valid literal null, or with no body', async () => {
    expect((await parseBody(post('null'))).malformed).toBeUndefined()
    expect((await parseBody(post(''))).malformed).toBeUndefined()
    expect((await parseBody(post('{"a":1}'))).malformed).toBeUndefined()

    const seen = { calls: 0, data: undefined as unknown }
    const app  = await boot(seen)
    const res  = await app.http.fetch(post('{"a":1}'))
    expect(res.status).toBeLessThan(300)
    expect(seen.data).toEqual({ a: 1 })
    await app.stop()
  })
})
