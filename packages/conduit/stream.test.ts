// ============================================================
// Conduit — stream() over http (FJS-2728, FJS-2579)
//
// A text/event-stream body yields one chunk per event and any other body
// yields its bytes, so an SSE vendor API and a large recording both cross
// the seam without being buffered whole. Opening goes through the send()
// ladder, so a failure before the first byte is the kind send() answers for
// the same status — the parity table below is what keeps them one grader.
// Every stream here leaves the process for a real Bun.serve vendor.
// ============================================================

import { afterAll, describe, expect, it } from 'bun:test'
import { formatEvent } from '@frontierjs/toolbelt/sse'
import { createConduit } from './src/conduit.ts'
import { createStaticResolver } from './src/credentials.ts'
import { ConduitStreamError } from './src/types.ts'
import type { ConduitChunk, ConduitOptions, TargetDescriptor } from './src/types.ts'

const enc = new TextEncoder()

// Each path is one behavior. `hits` counts arrivals per path; `closed` records
// a body the client cancelled, as the server saw it.
const hits   = new Map<string, number>()
const closed = new Set<string>()

/** A body written piece by piece, with a pause between, so a read sees the chunk boundaries the test chose. */
function trickle(path: string, pieces: Uint8Array[], end: 'close' | 'error' | 'hang' = 'close') {
  return new ReadableStream<Uint8Array>({
    async pull(ctrl) {
      const next = pieces.shift()
      if (next) { ctrl.enqueue(next); await Bun.sleep(5); return }
      if (end === 'close') ctrl.close()
      else if (end === 'error') ctrl.error(new Error('vendor died'))
      else await new Promise(() => {})
    },
    cancel() { closed.add(path) },
  })
}

const AUDIO = new Uint8Array(256 * 1024).map((_, i) => (i * 31) % 251)

const vendor = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname
    const n    = (hits.get(path) ?? 0) + 1
    hits.set(path, n)
    const sse  = { 'content-type': 'text/event-stream' }

    switch (path) {
      case '/events': {
        const wire = formatEvent({ event: 'message_start', data: { type: 'message_start' }, id: '1' })
          + formatEvent({ data: { type: 'delta', text: 'héllo' } })
          + 'data: [DONE]\n\n'
        // Split mid-line and mid-character: the reader must not care where.
        const bytes = enc.encode(wire)
        const cuts  = [7, 31, 32, 60, bytes.length]
        const parts: Uint8Array[] = []
        cuts.reduce((from, to) => (parts.push(bytes.slice(from, to)), to), 0)
        return new Response(trickle(path, parts), { headers: { ...sse, 'x-request-id': 'req-1' } })
      }
      case '/audio': {
        const parts = [AUDIO.slice(0, 100_000), AUDIO.slice(100_000, 200_000), AUDIO.slice(200_000)]
        return new Response(trickle(path, parts), { headers: { 'content-type': 'audio/wav' } })
      }
      case '/cut-mid-event':
        return new Response(trickle(path, [enc.encode('data: {"a":1}\n\ndata: {"b"')]), { headers: sse })
      case '/dies':
        return new Response(trickle(path, [enc.encode('data: 1\n\n')], 'error'), { headers: sse })
      case '/hangs':
        return new Response(trickle(path, [enc.encode('data: 1\n\n')], 'hang'), { headers: sse })
      case '/forever':
        return new Response(trickle(path, Array.from({ length: 1000 }, (_, i) => enc.encode(`data: ${i}\n\n`))), { headers: sse })
      case '/no-blank-line':
        return new Response(trickle(path, Array.from({ length: 20 }, () => enc.encode(`data: ${'x'.repeat(100)}\n`))), { headers: sse })
      case '/flaky':
        return n === 1
          ? Response.json({ message: 'warming up' }, { status: 503, headers: { 'retry-after': '0' } })
          : new Response(formatEvent({ data: 'ok' }), { headers: sse })
      case '/expired':
        return req.headers.get('authorization') === 'Bearer fresh'
          ? new Response(formatEvent({ data: 'ok' }), { headers: sse })
          : Response.json({ message: 'expired' }, { status: 401 })
      case '/empty':
        return new Response(null, { status: 204 })
      default: {
        const status = Number(path.slice(1))
        return Response.json({ message: `status ${status}` }, { status, headers: status === 429 ? { 'retry-after': '7' } : {} })
      }
    }
  },
})
afterAll(() => vendor.stop(true))

const target = (extra: Partial<TargetDescriptor> = {}): TargetDescriptor => ({
  id:            'provider:vendor',
  kind:          'provider',
  protocol:      'http',
  address:       `http://127.0.0.1:${vendor.port}`,
  auth:          { type: 'none' },
  registered_at: 1_000,
  last_seen_at:  null,
  ...extra,
})

function conduitFor(extra: Partial<TargetDescriptor> = {}, opts: Partial<ConduitOptions> = {}) {
  const c = createConduit({ credentials: createStaticResolver({}), targets: [target(extra)], ...opts })
  return { c, open: (path: string, more: object = {}) => c.stream({ target: 'provider:vendor', method: 'GET', path, ...more }) }
}

async function collect(stream: AsyncIterable<ConduitChunk>): Promise<ConduitChunk[]> {
  const out: ConduitChunk[] = []
  for await (const chunk of stream) out.push(chunk)
  return out
}

async function refusal(stream: AsyncIterable<ConduitChunk>): Promise<ConduitStreamError> {
  try { await collect(stream) } catch (err) {
    expect(err).toBeInstanceOf(ConduitStreamError)
    return err as ConduitStreamError
  }
  throw new Error('the stream did not fail')
}

describe('conduit.stream() over http', () => {
  it('an event stream yields one chunk per event, wherever the bytes were cut', async () => {
    const { c, open } = conduitFor()
    await c.init()
    const chunks = await collect(open('/events'))

    expect(chunks.map(ch => ch.data)).toEqual([
      { event: 'message_start', data: { type: 'message_start' }, id: '1' },
      { event: 'message', data: { type: 'delta', text: 'héllo' }, id: '1' },
      { event: 'message', data: '[DONE]', id: '1' },
    ])
    expect(chunks.map(ch => ch.sequence)).toEqual([0, 1, 2])
    expect(chunks[0].meta?.status).toBe(200)
    expect(chunks[0].meta?.headers?.['x-request-id']).toBe('req-1')
  })

  it('any other body yields its bytes as they arrive, past max_response_bytes', async () => {
    const { c, open } = conduitFor({}, { max_response_bytes: 64 * 1024 })
    await c.init()
    const chunks = await collect(open('/audio'))

    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.every(ch => ch.data instanceof Uint8Array)).toBe(true)
    expect(Buffer.concat(chunks.map(ch => ch.data as Uint8Array)).equals(Buffer.from(AUDIO))).toBe(true)
    expect(chunks[0].meta?.headers?.['content-type']).toBe('audio/wav')

    // The control: send() buffers, so the same body is refused at the same cap.
    const sent = await c.send({ target: 'provider:vendor', method: 'GET', path: '/audio' })
    expect(sent.error?.kind).toBe('invalid_response')
  })

  it('a body with no content yields nothing and ends cleanly', async () => {
    const { c, open } = conduitFor()
    await c.init()
    expect(await collect(open('/empty'))).toEqual([])
  })

  it('a failure before the first byte is the kind send() answers for the same status', async () => {
    const { c, open } = conduitFor({}, { retry_limit: 0 })
    await c.init()
    for (const status of [401, 403, 404, 429, 500]) {
      const sent = await c.send({ target: 'provider:vendor', method: 'GET', path: `/${status}` })
      const err  = await refusal(open(`/${status}`))
      expect({ status, kind: err.conduit.kind }).toEqual({ status, kind: sent.error!.kind })
      expect(err.conduit.retryable).toBe(sent.error!.retryable)
      expect(err.conduit.raw).toEqual(sent.error!.raw)
      expect(err.meta?.status).toBe(status)
    }
    const limited = await refusal(open('/429'))
    expect(limited.conduit.retry_after_ms).toBe(7000)
  })

  it('opening runs the ladder: an idempotent stream is retried, an unkeyed POST is not', async () => {
    const { c, open } = conduitFor()
    await c.init()
    hits.delete('/flaky')
    expect((await collect(open('/flaky'))).map(ch => ch.data)).toEqual([{ event: 'message', data: 'ok', id: '' }])
    expect(hits.get('/flaky')).toBe(2)

    hits.delete('/flaky')
    const err = await refusal(open('/flaky', { method: 'POST', body: {} }))
    expect(err.conduit.kind).toBe('rate_limited')
    expect(hits.get('/flaky')).toBe(1)
  })

  it('a refused credential remints once before the stream opens', async () => {
    let value = 'stale'
    const c = createConduit({
      credentials: { async get() { return value }, invalidate() { value = 'fresh' } },
      targets:     [target({ auth: { type: 'bearer', ref: 'VENDOR' } })],
    })
    await c.init()
    const chunks = await collect(c.stream({ target: 'provider:vendor', method: 'POST', path: '/expired', body: {} }))
    expect(chunks.map(ch => (ch.data as { data: unknown }).data)).toEqual(['ok'])
  })

  it('a body that stops inside an event is stream_error, after the events that did end', async () => {
    const { c, open } = conduitFor()
    await c.init()
    const seen: unknown[] = []
    const err = await refusal((async function* () {
      for await (const ch of open('/cut-mid-event')) { seen.push(ch.data); yield ch }
    })())
    expect(seen).toEqual([{ event: 'message', data: { a: 1 }, id: '' }])
    expect(err.conduit.kind).toBe('stream_error')
    expect(err.meta?.status).toBe(200)
  })

  it('a body that dies mid-flight is stream_error', async () => {
    const { c, open } = conduitFor()
    await c.init()
    expect((await refusal(open('/dies'))).conduit.kind).toBe('stream_error')
  })

  it('an event that never ends is refused at max_response_bytes rather than held', async () => {
    const { c, open } = conduitFor({}, { max_response_bytes: 1024 })
    await c.init()
    const err = await refusal(open('/no-blank-line'))
    expect(err.conduit.kind).toBe('invalid_response')
    await Bun.sleep(20)
    expect(closed.has('/no-blank-line')).toBe(true)
  })

  it('the request timeout covers the wait for headers, not the stream', async () => {
    const { c, open } = conduitFor({}, { timeout_ms: 30 })
    await c.init()
    // 1000 events 5ms apart outlive a 30ms timeout many times over.
    expect((await collect(open('/forever'))).length).toBe(1000)
  }, 15_000)

  it('the caller\'s signal ends a hung stream as aborted, and the vendor sees the close', async () => {
    const { c, open } = conduitFor()
    await c.init()
    const ctrl = new AbortController()
    setTimeout(() => ctrl.abort(), 50)
    const err = await refusal(open('/hangs', { signal: ctrl.signal }))
    expect(err.conduit.kind).toBe('aborted')
    await Bun.sleep(20)
    expect(closed.has('/hangs')).toBe(true)
  })

  it('a consumer that stops early closes the body', async () => {
    const { c, open } = conduitFor()
    await c.init()
    closed.delete('/forever')
    for await (const ch of open('/forever')) if (ch.sequence === 2) break
    await Bun.sleep(20)
    expect(closed.has('/forever')).toBe(true)
  })

  it('an open stream holds a max_concurrent slot until it ends', async () => {
    const { c, open } = conduitFor({ resilience: { max_concurrent: 1 } })
    await c.init()
    const it = open('/forever')[Symbol.asyncIterator]()
    await it.next()

    const shed = await c.send({ target: 'provider:vendor', method: 'GET', path: '/404' })
    expect(shed.error?.kind).toBe('overloaded')

    await it.return?.()
    const admitted = await c.send({ target: 'provider:vendor', method: 'GET', path: '/404' })
    expect(admitted.error?.kind).toBe('client_error')
  })

  it('an open breaker refuses a stream before it is dialed', async () => {
    const { c, open } = conduitFor({ resilience: { failure_threshold: 2, retry_limit: 0 } })
    await c.init()
    for (let i = 0; i < 2; i++) await refusal(open('/500'))
    hits.delete('/events')
    expect((await refusal(open('/events'))).conduit.kind).toBe('circuit_open')
    expect(hits.get('/events')).toBeUndefined()
  })

  it('observers see the stream end with its chunk count', async () => {
    const ended: number[] = []
    const { c, open } = conduitFor({}, { observers: { onStreamEnd: (_req, n) => { ended.push(n) } } })
    await c.init()
    await collect(open('/events'))
    expect(ended).toEqual([3])
  })
})
