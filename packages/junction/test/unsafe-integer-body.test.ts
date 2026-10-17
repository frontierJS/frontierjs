// test/unsafe-integer-body.test.ts
// A body integer past 2^53 is rounded by JSON.parse before any validator runs,
// so a Json member stored 9007199254740993 as 9007199254740992 and answered
// 201 (`FJS-2152`). The transport refuses it by path; a 64-bit value crosses as
// a string of digits (`FJS-D174`) and a string is never touched.

import { describe, it, expect } from 'bun:test'
import { parseBody, UnsafeIntegerError, firstUnsafeInteger } from '../src/transport/body.ts'
import { createApp } from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'

const json = (body: string) => new Request('http://localhost/x', {
  method:  'POST',
  headers: { 'content-type': 'application/json' },
  body,
})

describe('firstUnsafeInteger', () => {
  it('names the path of the first integer literal outside the safe range', () => {
    expect(firstUnsafeInteger('{"properties":{"bytes":9007199254740993}}')).toBe('properties.bytes')
    expect(firstUnsafeInteger('{"items":[1,{"n":-9007199254740993}]}')).toBe('items[1].n')
    expect(firstUnsafeInteger('9007199254740993')).toBe('body')
  })

  it('passes the safe range, floats, exponents and strings', () => {
    expect(firstUnsafeInteger('{"a":9007199254740991,"b":-9007199254740991}')).toBeNull()
    expect(firstUnsafeInteger('{"a":1.5e300,"b":0.12345678901234567890}')).toBeNull()
    expect(firstUnsafeInteger('{"a":"9007199254740993","k\\"9007199254740993":"x"}')).toBeNull()
  })
})

describe('a body integer past 2^53', () => {
  it('is refused by parseBody, naming the path', async () => {
    const err = await parseBody(json('{"properties":{"bytes":9007199254740993}}')).catch(e => e)
    expect(err).toBeInstanceOf(UnsafeIntegerError)
    expect(err.message).toContain('properties.bytes')
  })

  it('is refused over HTTP with a 400 naming the path, and a string of digits is stored as sent', async () => {
    const seen: unknown[] = []
    const app = createApp({
      config: { port: 0 },
    } as never)
    app.services.register(createService({
      name: 'events', methods: ['create'],
      async create(ctx: any) { seen.push(ctx.data); return { id: 1 } },
    } as never))
    await app.start()

    const bad = await app.http.fetch(new Request('http://localhost/events', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    '{"properties":{"bytes":9007199254740993}}',
    }))
    expect(bad.status).toBe(400)
    expect(bad.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await bad.text()).toContain('properties.bytes')
    expect(seen).toEqual([])

    const ok = await app.http.fetch(new Request('http://localhost/events', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    '{"properties":{"bytes":"9007199254740993","n":9007199254740991}}',
    }))
    expect(ok.status).toBe(201)
    expect(seen).toEqual([{ properties: { bytes: '9007199254740993', n: 9007199254740991 } }])
    await app.stop()
  })
})
