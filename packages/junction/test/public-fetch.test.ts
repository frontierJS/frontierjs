// test/public-fetch.test.ts
//
// fetchPublicJson: the bounded fetch of a URL somebody else chose.
//
// A client-metadata document, a JWKS, an OAuth discovery file: each is JSON at
// an address a stranger picked. The grade (`public-url.ts`) says where it may
// connect; these rows say what the fetch does once it has, and every refusal is
// paired with the acceptance of an otherwise identical request (`FJS-351`).
import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { fetchPublicJson, PublicFetchError, PublicUrlError } from '../src/core/public-url.ts'

let server: ReturnType<typeof Bun.serve>
const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json', ...headers } })

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    if (path === '/doc')       return json({ ok: true }, { 'cache-control': 'public, max-age=120' })
    if (path === '/store')     return json({ ok: true }, { 'cache-control': 'no-store, max-age=120' })
    if (path === '/bare')      return json({ ok: true })
    if (path === '/ld')        return new Response('{"a":1}', { headers: { 'content-type': 'application/ld+json; charset=utf-8' } })
    if (path === '/big')       return json({ pad: 'x'.repeat(2_000) })
    if (path === '/html')      return new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } })
    if (path === '/broken')    return new Response('{nope', { headers: { 'content-type': 'application/json' } })
    if (path === '/500')       return new Response('{}', { status: 500, headers: { 'content-type': 'application/json' } })
    if (path === '/slow')      { await Bun.sleep(600); return json({ late: true }) }
    if (path === '/dribble')   return new Response(new ReadableStream({
      async start(c) { c.enqueue(new TextEncoder().encode('{"a":')); await Bun.sleep(600); c.enqueue(new TextEncoder().encode('1}')); c.close() },
    }), { headers: { 'content-type': 'application/json' } })
    const hop = path.match(/^\/hop\/(\d+)$/)
    if (hop) {
      const n = Number(hop[1])
      return n === 0 ? json({ landed: true }) : new Response(null, { status: 302, headers: { location: `/hop/${n - 1}` } })
    }
    return new Response('missing', { status: 404 })
  }})
})
afterAll(() => server.stop(true))

const OPEN = { allowHttp: true, allowPrivate: true }
const at   = (p: string) => `http://localhost:${server.port}${p}`
const refusal = async (p: Promise<unknown>) => p.then(() => null, (e: Error) => e)

describe('a body that is JSON, in bounds', () => {
  it('round-trips with its max-age', async () => {
    const got = await fetchPublicJson(at('/doc'), OPEN)
    expect(got).toEqual({ url: at('/doc'), status: 200, json: { ok: true }, maxAge: 120 })
  })
  it('reads a +json media type with a charset', async () => {
    expect((await fetchPublicJson(at('/ld'), OPEN)).json).toEqual({ a: 1 })
  })
  it('gives null for no Cache-Control, and for no-store beside a max-age', async () => {
    expect((await fetchPublicJson(at('/bare'), OPEN)).maxAge).toBeNull()
    expect((await fetchPublicJson(at('/store'), OPEN)).maxAge).toBeNull()
  })
})

describe('what is refused', () => {
  it('a body over maxBytes, and the same body under a larger one', async () => {
    const err = await refusal(fetchPublicJson(at('/big'), { ...OPEN, maxBytes: 500 }))
    expect(err).toBeInstanceOf(PublicFetchError)
    expect(err).toBeInstanceOf(PublicUrlError)
    expect((err as PublicFetchError).status).toBe(400)
    expect(err!.message).toContain(at('/big'))
    expect(err!.message).toContain('500 bytes')
    expect((await fetchPublicJson(at('/big'), { ...OPEN, maxBytes: 5_000 })).status).toBe(200)
  })
  it('a content type that is not JSON', async () => {
    const err = await refusal(fetchPublicJson(at('/html'), OPEN))
    expect(err).toBeInstanceOf(PublicFetchError)
    expect(err!.message).toContain('text/html')
  })
  it('a body that does not parse, and a non-2xx answer', async () => {
    expect(await refusal(fetchPublicJson(at('/broken'), OPEN))).toBeInstanceOf(PublicFetchError)
    expect((await refusal(fetchPublicJson(at('/500'), OPEN)))!.message).toContain('500')
  })
  it('a redirect chain past maxHops, and the same chain within it', async () => {
    const err = await refusal(fetchPublicJson(at('/hop/4'), { ...OPEN, maxHops: 3 }))
    expect(err).toBeInstanceOf(PublicFetchError)
    expect(err!.message).toContain('redirected more than 3 times')
    const ok = await fetchPublicJson(at('/hop/3'), { ...OPEN, maxHops: 3 })
    expect(ok.json).toEqual({ landed: true })
    expect(ok.url).toBe(at('/hop/0'))
  })
  it('a server slower than timeoutMs, headers or body, and the same server given time', async () => {
    for (const p of ['/slow', '/dribble']) {
      const err = await refusal(fetchPublicJson(at(p), { ...OPEN, timeoutMs: 150 }))
      expect(err).toBeInstanceOf(PublicFetchError)
      expect(err!.message).toContain('150ms')
    }
    expect((await fetchPublicJson(at('/slow'), { ...OPEN, timeoutMs: 3_000 })).json).toEqual({ late: true })
  })
})

describe('every hop is graded', () => {
  // Address literals need no DNS, and the stub serves nothing over a socket.
  const PUBLIC = 'https://93.184.216.34/meta.json'
  const stub = (to: string) => (async (input: string | URL | Request) => {
    const u = String(input)
    return u.startsWith('https://93.184.216.34')
      ? new Response(null, { status: 302, headers: { location: to } })
      : json({ reached: u })
  }) as typeof fetch

  it('refuses a redirect to a private address by name', async () => {
    for (const to of ['https://127.0.0.1/admin', 'https://169.254.169.254/latest/meta-data/', 'http://[::1]/']) {
      const err = await refusal(fetchPublicJson(PUBLIC, { fetch: stub(to) }))
      expect(err).toBeInstanceOf(PublicUrlError)
      expect(err!.message).toMatch(/private address|must be https/)
    }
  })
  it('follows a redirect to another public address', async () => {
    const got = await fetchPublicJson(PUBLIC, { fetch: stub('https://93.184.216.35/next.json') })
    expect(got.json).toEqual({ reached: 'https://93.184.216.35/next.json' })
    expect(got.url).toBe('https://93.184.216.35/next.json')
  })
  it('refuses the first URL when it is private, before any request', async () => {
    let called = false
    const spy = (async (_: unknown) => { called = true; return json({}) }) as typeof fetch
    expect(await refusal(fetchPublicJson('https://10.0.0.5/x', { fetch: spy }))).toBeInstanceOf(PublicUrlError)
    expect(called).toBe(false)
  })
})
