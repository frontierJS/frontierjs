// test/route-body-stream.test.ts
// A route that states `{ body: 'stream' }` is handed the request body unread
// (`FJS-D1159`, `FJS-3093`). Every other route is parsed and buffered before
// its handler runs, so an upload larger than memory had no junction route at
// any size and left for a second `Bun.serve`.
//
// The assertions that carry the fix count PULLS: a handler handed a buffered
// copy and a handler handed the stream both read every byte, and the only
// difference visible from outside is how much was pulled before it ran.

import { describe, it, expect } from 'bun:test'
import { createApp } from '../src/core/app.ts'

const CHUNK = 64 * 1024

/** A chunked request: no Content-Length, and a count of what was pulled. */
function chunked(path: string, chunks: number) {
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
  const req = new Request(`http://localhost${path}`, {
    method:  'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body,
    // @ts-expect-error — Node/Bun require this for a stream body
    duplex:  'half',
  })
  return { req, counter }
}

function app(maxBodySize?: number) {
  return createApp({
    config: { port: 0, ...(maxBodySize ? { http: { maxBodySize } } : {}) },
  } as any)
}

describe('a route that takes its body as a stream', () => {

  it('runs before any of the body is read', async () => {
    const a = app()
    let pulledAtEntry = -1
    let total = 0
    a.put('/upload', async (ctx) => {
      pulledAtEntry = counter.pulled
      const reader = (ctx.body as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
      }
      return ctx.json({ total })
    }, { body: 'stream', maxBodySize: 16 * CHUNK })
    await a.start()

    const { req, counter } = chunked('/upload', 16)
    const res = await a.http.fetch(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ total: 16 * CHUNK })
    // A buffered parse would have pulled all sixteen before the handler ran.
    expect(pulledAtEntry).toBeLessThan(16)
    await a.stop()
  })

  it('hands $raw.$req the unread body', async () => {
    const a = app()
    let n = 0
    a.put('/upload', async (ctx) => {
      n = (await ctx.$raw.$req.arrayBuffer()).byteLength
      return ctx.empty(204)
    }, { body: 'stream' })
    await a.start()

    const { req } = chunked('/upload', 2)
    expect((await a.http.fetch(req)).status).toBe(204)
    expect(n).toBe(2 * CHUNK)
    await a.stop()
  })

  it('is bounded by its own maxBodySize, above the app bound', async () => {
    const a = app(256 * 1024)
    a.put('/upload', async (ctx) => {
      const n = (await new Response(ctx.body as ReadableStream).arrayBuffer()).byteLength
      return ctx.json({ n })
    }, { body: 'stream', maxBodySize: 1024 * 1024 })
    a.put('/parsed', ctx => ctx.json({ ok: true }))
    await a.start()

    const streamed = await a.http.fetch(chunked('/upload', 8).req)   // 512 KB
    expect(streamed.status).toBe(200)
    expect(await streamed.json()).toEqual({ n: 8 * CHUNK })

    // Paired: the same body to a route that states nothing is held to the app's.
    const parsed = await a.http.fetch(chunked('/parsed', 8).req)
    expect(parsed.status).toBe(413)
    await a.stop()
  })

  // FJS-D2258 (B2): a stream route that states no bound takes the app's.
  it('stating no bound, is cut at the app bound with a 413 that logs the route', async () => {
    const a = app(256 * 1024)
    const warned: string[] = []
    a.logger.warn = (m: string, meta?: unknown) => { warned.push(`${m} ${JSON.stringify(meta ?? {})}`) }
    let read = 0
    a.put('/upload', async (ctx) => {
      const reader = (ctx.body as ReadableStream<Uint8Array>).getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        read += value.byteLength
      }
      return ctx.json({ read })
    }, { body: 'stream' })
    await a.start()

    const { req, counter } = chunked('/upload', 16)   // 1 MB
    const res = await a.http.fetch(req)
    expect(res.status).toBe(413)
    expect(read).toBeLessThanOrEqual(256 * 1024)
    expect(counter.pulled).toBeLessThan(16)
    expect(warned.join('\n')).toContain('PUT /upload')
    await a.stop()
  })

  it('refuses a declared length over its bound before the handler runs', async () => {
    const a = app()
    let ran = false
    a.put('/upload', (ctx) => { ran = true; return ctx.empty(204) }, { body: 'stream', maxBodySize: 1024 })
    await a.start()
    const res = await a.http.fetch(new Request('http://localhost/upload', {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream', 'content-length': '4096' }, body: new Uint8Array(4096),
    }))
    expect(res.status).toBe(413)
    expect(await res.text()).toContain('PUT /upload')
    expect(ran).toBe(false)
    await a.stop()
  })

  it('bounds a body read through $raw.$req as it bounds ctx.body', async () => {
    const a = app()
    a.put('/upload', async (ctx) => {
      await ctx.$raw.$req.arrayBuffer()
      return ctx.empty(204)
    }, { body: 'stream', maxBodySize: 128 * 1024 })
    await a.start()
    expect((await a.http.fetch(chunked('/upload', 4).req)).status).toBe(413)
    await a.stop()
  })

  it('bounds a parsed route by its own maxBodySize too', async () => {
    const a = app(256 * 1024)
    a.put('/parsed', ctx => ctx.json({ ok: true }), { maxBodySize: 1024 * 1024 })
    await a.start()
    expect((await a.http.fetch(chunked('/parsed', 8).req)).status).toBe(200)
    await a.stop()
  })

  it('refuses a bound that is not a positive whole number of bytes, by name', () => {
    const a = app()
    expect(() => a.put('/upload', ctx => ctx.empty(204), { body: 'stream', maxBodySize: 0 }))
      .toThrow(/maxBodySize/)
  })

  // FJS-4342: Bun's maxRequestBodySize cuts a CHUNKED body too, so the server's
  // ceiling must cover the largest route bound. Only a real socket meets it.
  it('takes a chunked body past 128 MB over a socket when its bound allows', async () => {
    const a = app()
    a.put('/upload', async (ctx) => {
      const reader = (ctx.body as ReadableStream<Uint8Array>).getReader()
      let n = 0
      for (let r = await reader.read(); !r.done; r = await reader.read()) n += r.value.byteLength
      return ctx.json({ n })
    }, { body: 'stream', maxBodySize: 1024 ** 3 })
    await a.start()

    const MB = 1024 * 1024, N = 140
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(c) { if (sent >= N) { c.close(); return } sent++; c.enqueue(new Uint8Array(MB)) },
    })
    const res = await fetch(`http://localhost:${a.http.port}/upload`, {
      method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body,
      // @ts-expect-error — Bun requires this for a stream body
      duplex: 'half',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ n: N * MB })
    await a.stop()
  }, 60_000)

  it('leaves a route that declares nothing parsed as before', async () => {
    const a = app()
    let seen: unknown
    a.post('/json', (ctx) => { seen = ctx.body; return ctx.empty(204) })
    await a.start()
    await a.http.fetch(new Request('http://localhost/json', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}',
    }))
    expect(seen).toEqual({ a: 1 })
    await a.stop()
  })
})
