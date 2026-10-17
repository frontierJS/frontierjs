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
    }, { body: 'stream' })
    await a.start()

    const { req, counter } = chunked('/upload', 16)
    const res = await a.http.fetch(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ total: 16 * CHUNK })
    // A buffered parse would have pulled all sixteen before the handler ran.
    expect(pulledAtEntry).toBeLessThan(16)
    await a.stop()
  })

  it('hands $raw.$req the unread original', async () => {
    const a = app()
    let same = false
    a.put('/upload', async (ctx) => {
      same = ctx.$raw.$req.body === ctx.body
      await ctx.$raw.$req.arrayBuffer()
      return ctx.empty(204)
    }, { body: 'stream' })
    await a.start()

    const { req } = chunked('/upload', 2)
    expect((await a.http.fetch(req)).status).toBe(204)
    expect(same).toBe(true)
    await a.stop()
  })

  it('is not refused by the parse bound, which belongs to a parsed body', async () => {
    const a = app(256 * 1024)
    a.put('/upload', async (ctx) => {
      const n = (await new Response(ctx.body as ReadableStream).arrayBuffer()).byteLength
      return ctx.json({ n })
    }, { body: 'stream' })
    a.put('/parsed', ctx => ctx.json({ ok: true }))
    await a.start()

    const streamed = await a.http.fetch(chunked('/upload', 8).req)   // 512 KB
    expect(streamed.status).toBe(200)
    expect(await streamed.json()).toEqual({ n: 8 * CHUNK })

    // Paired: the same body to a route that declares nothing is still refused.
    const parsed = await a.http.fetch(chunked('/parsed', 8).req)
    expect(parsed.status).toBe(413)
    await a.stop()
  })

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
