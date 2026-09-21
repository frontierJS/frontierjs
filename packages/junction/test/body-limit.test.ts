// A body that declares no length is bounded too.
//
// `Content-Length` is optional — a chunked request states none, and until this
// the pre-read check had nothing to look at and `req.arrayBuffer()` buffered
// whatever arrived. Measured against a bare `Bun.serve`: 8 MB read whole with
// the limit at 256 KB, refused afterwards.
//
// Every assertion here is PAIRED with a body of the same shape that fits, since
// a read that refused everything satisfies the refusals on its own. The two
// that carry the fix are the ones counting PULLS: a limit enforced after the
// buffer and a limit enforced during it answer the same status, and the only
// difference visible from outside is how much of the stream was asked for.

import { describe, it, expect } from 'bun:test'
import { parseBody, BodyTooLargeError } from '../src/transport/body.ts'

const CHUNK = 64 * 1024

/** A chunked request: no Content-Length, and a count of what was pulled. */
function chunked(chunks: number, type = 'application/json') {
  const counter = { pulled: 0 }
  let sent = 0
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= chunks) { c.close(); return }
      counter.pulled++
      sent++
      c.enqueue(new Uint8Array(CHUNK).fill(0x61))
    },
  })
  const req = new Request('http://localhost/x', {
    method:  'POST',
    headers: { 'content-type': type },
    body,
    // @ts-expect-error — Node/Bun require this for a stream body
    duplex:  'half',
  })
  return { req, counter }
}

describe('the body size bound', () => {

  it('refuses a chunked body over the limit', async () => {
    const { req } = chunked(8)                       // 512 KB
    expect(parseBody(req, 256 * 1024)).rejects.toThrow(BodyTooLargeError)
  })

  it('accepts a chunked body under the limit', async () => {
    const { req } = chunked(2, 'text/plain')         // 128 KB
    const parsed  = await parseBody(req, 256 * 1024)
    expect(parsed.size).toBe(2 * CHUNK)
  })

  it('stops reading the stream at the limit', async () => {
    const { req, counter } = chunked(512)            // 32 MB offered
    await parseBody(req, 256 * 1024).catch(() => {})
    // 256 KB is four chunks; the fifth is what crosses the bound.
    expect(counter.pulled).toBeLessThanOrEqual(5)
    expect(counter.pulled).toBeGreaterThan(0)
  })

  it('reads the whole stream when it fits', async () => {
    const { req, counter } = chunked(4, 'text/plain')
    await parseBody(req, 1024 * 1024)
    expect(counter.pulled).toBe(4)
  })

  it('refuses a declared length over the limit without reading a byte', async () => {
    const { req, counter } = chunked(64)
    // A declaration the framing would honour; the header check answers alone.
    const declared = new Request(req, { headers: { ...Object.fromEntries(req.headers), 'content-length': '10485760' } })
    expect(parseBody(declared, 256 * 1024)).rejects.toThrow(BodyTooLargeError)
    expect(counter.pulled).toBe(0)
  })

  it('names the limit and the size it saw', async () => {
    const { req } = chunked(8)
    try {
      await parseBody(req, 256 * 1024)
      throw new Error('should have refused')
    } catch (err) {
      expect(err).toBeInstanceOf(BodyTooLargeError)
      const e = err as BodyTooLargeError
      expect(e.limit).toBe(256 * 1024)
      expect(e.size).toBeGreaterThan(e.limit)
      // What it saw, not what was offered: 512 KB was on the wire and the read
      // stopped one chunk past the bound.
      expect(e.size).toBeLessThanOrEqual(e.limit + CHUNK)
      expect(e.message).toContain('262144')
    }
  })

  it('joins multi-chunk bodies in order', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"a":1,'))
        c.enqueue(new TextEncoder().encode('"b":2}'))
        c.close()
      },
    })
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      // @ts-expect-error — stream body
      duplex: 'half',
    })
    const parsed = await parseBody(req, 1024)
    expect(parsed.data).toEqual({ a: 1, b: 2 })
  })

  it('does not truncate a single-chunk body to its backing buffer', async () => {
    // A chunk is a VIEW; handing over `.buffer` on one that does not cover its
    // whole buffer serves the wrong bytes.
    const backing = new TextEncoder().encode('XXXX{"ok":true}YYYY')
    const view    = backing.subarray(4, 15)
    const body    = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(view); c.close() } })
    const req = new Request('http://localhost/x', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      // @ts-expect-error — stream body
      duplex: 'half',
    })
    const parsed = await parseBody(req, 1024)
    expect(parsed.data).toEqual({ ok: true })
    expect(parsed.size).toBe(11)
  })
})

// ─── At the transport ─────────────────────────────────────────────────────
// The unit tests above own the bound; these own what a caller is TOLD. Both
// answers used to come out of one `catch` that said 413 whatever had gone
// wrong, so a body the parser could not read sent the caller looking for a
// limit they were nowhere near.

describe('the refusal a caller reads', () => {

  async function serve(maxBodySize: number) {
    const { HttpTransport } = await import('../src/transport/http.ts')
    const t = new HttpTransport({ port: 0, maxBodySize })
    t.router.post('/echo', (ctx) => ctx.json({ size: ctx.body ? 1 : 0 }))
    t.router.build()
    t.start(0)
    return { t, url: `http://localhost:${t.port}/echo` }
  }

  it('answers 413 naming the limit, and 200 for a body that fits', async () => {
    const { t, url } = await serve(256 * 1024)
    try {
      // The fitting body goes FIRST. Refusing mid-stream leaves bytes on the
      // wire and Bun keeps the socket, so the next request over that same
      // connection is answered 400 by Bun's own parser before this app is
      // reached — the sender's own connection, spent once. Asserting the
      // ordinary case after the refusal would be asserting that.
      const under = await fetch(url, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ ok: true }),
      })
      expect(under.status).toBe(200)

      const over = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: chunked(8).req.body,
        // @ts-expect-error — stream body
        duplex: 'half',
      })
      expect(over.status).toBe(413)
      expect(await over.text()).toContain('262144')
    } finally { await t.stop(100) }
  })

  it('does not answer 413 for a body it simply could not read', async () => {
    const { t, url } = await serve(256 * 1024)
    try {
      const r = await fetch(url, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    '{ not json',
      })
      expect(r.status).not.toBe(413)
    } finally { await t.stop(100) }
  })
})
