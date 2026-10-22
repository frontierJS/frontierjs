// test/request-bytes.test.ts
//
// FJS-2581 — a raw route that answers bytes is asserted through request().
// The helper used to read every body with response.text(), so a byte that is
// not valid UTF-8 came back as U+FFFD and the file a route sends could not be
// compared with the file it was built from.

import { describe, it, expect } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import { request } from '../src/testing/index.ts'

const BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0xff, 0xfe, 0x00, 0x80, 0xc3, 0x28])

function appWithFile() {
  const app = createApp({ config: { ...defaultConfig, port: 0 } as never })
  app.get('/file', () => new Response(BYTES, { headers: { 'content-type': 'audio/wav' } }))
  app.get('/json', (ctx: any) => ctx.json({ ok: true }))
  return app
}

describe('request() carries the body as bytes', () => {

  it('a byte that is not UTF-8 survives', async () => {
    const res = await request(appWithFile()).get('/file')
    expect(res.status).toBe(200)
    expect(Array.from(res.bytes)).toEqual(Array.from(BYTES))
  })

  it('text and body still read a JSON answer', async () => {
    const res = await request(appWithFile()).get('/json')
    expect(res.body).toEqual({ ok: true })
    expect(res.text).toBe(JSON.stringify({ ok: true }))
    expect(new TextDecoder().decode(res.bytes)).toBe(res.text)
  })
})
