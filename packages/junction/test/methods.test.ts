// HEAD, OPTIONS, and the difference between 404 and 405.
//
// Three answers a transport owes every caller and this one gave none of them:
// a HEAD was a 404 on every resource in every app (a cache, a link checker and
// an uptime probe all reach for one first), an OPTIONS nobody claimed was a
// 404, and the wrong verb on a real path was a 404 too — which sends the caller
// looking for a different URL when the URL was right.
//
// Every assertion is PAIRED with the request that must still 404, because a
// transport that answered 405 for everything satisfies each of these alone.

import { describe, it, expect } from 'bun:test'
import { HttpTransport } from '../src/transport/http.ts'

async function serve(register: (r: HttpTransport['router']) => void) {
  const t = new HttpTransport({ port: 0 })
  register(t.router)
  t.router.build()
  t.start(0)
  return {
    t,
    async probe(method: string, path: string) {
      const r = await fetch(`http://localhost:${t.port}${path}`, { method })
      return {
        status: r.status,
        allow:  r.headers.get('allow'),
        length: r.headers.get('content-length'),
        body:   method === 'HEAD' ? '' : await r.text(),
      }
    },
  }
}

const app = (r: HttpTransport['router']) => {
  r.get('/things',      (ctx) => ctx.json({ items: [1, 2, 3] }))
  r.post('/things',     (ctx) => ctx.json({ ok: 1 }))
  r.get('/things/{id}', (ctx) => ctx.json({ id: ctx.route.id }))
}

describe('HEAD', () => {

  it('is answered by the GET route, headers intact and no body', async () => {
    const { t, probe } = await serve(app)
    try {
      const get  = await probe('GET',  '/things')
      const head = await probe('HEAD', '/things')
      expect(head.status).toBe(200)
      expect(head.body).toBe('')
      // The length the GET would have had — a probe reads it to size a fetch.
      expect(head.length).toBe(get.length)
    } finally { await t.stop(100) }
  })

  it('reaches a dynamic route too', async () => {
    const { t, probe } = await serve(app)
    try {
      expect((await probe('HEAD', '/things/7')).status).toBe(200)
    } finally { await t.stop(100) }
  })

  it('still 404s where no GET is registered', async () => {
    const { t, probe } = await serve((r) => { r.post('/only-post', (ctx) => ctx.json({})) })
    try {
      const head = await probe('HEAD', '/only-post')
      expect(head.status).toBe(405)          // the path exists, the verb does not
      expect((await probe('HEAD', '/nothing-here')).status).toBe(404)
    } finally { await t.stop(100) }
  })

  it('does not displace a HEAD route the app registered', async () => {
    const { t, probe } = await serve((r) => {
      r.get('/x',  (ctx) => ctx.json({ from: 'get' }))
      r.head('/x', () => new Response(null, { status: 204, headers: { 'x-from': 'head' } }))
    })
    try {
      const head = await probe('HEAD', '/x')
      expect(head.status).toBe(204)
    } finally { await t.stop(100) }
  })
})

describe('the wrong verb', () => {

  it('is 405 naming what would have worked', async () => {
    const { t, probe } = await serve(app)
    try {
      const res = await probe('DELETE', '/things')
      expect(res.status).toBe(405)
      expect(res.allow).toContain('GET')
      expect(res.allow).toContain('POST')
      // HEAD is listed because this transport answers it.
      expect(res.allow).toContain('HEAD')
      expect(res.allow).toContain('OPTIONS')
      expect(res.allow).not.toContain('DELETE')
      expect(JSON.parse(res.body).code).toBe(405)
    } finally { await t.stop(100) }
  })

  it('is still 404 where the PATH does not exist', async () => {
    const { t, probe } = await serve(app)
    try {
      const res = await probe('DELETE', '/no/such/path')
      expect(res.status).toBe(404)
      expect(res.allow).toBeNull()
    } finally { await t.stop(100) }
  })

  it('reports the methods of THAT path, not of the app', async () => {
    const { t, probe } = await serve((r) => {
      r.get('/read-only',   (ctx) => ctx.json({}))
      r.post('/write-only', (ctx) => ctx.json({}))
    })
    try {
      const res = await probe('POST', '/read-only')
      expect(res.status).toBe(405)
      expect(res.allow).not.toContain('POST')
    } finally { await t.stop(100) }
  })
})

describe('OPTIONS', () => {

  it('is answered with Allow when nothing claimed it', async () => {
    const { t, probe } = await serve(app)
    try {
      const res = await probe('OPTIONS', '/things')
      expect(res.status).toBe(204)
      expect(res.allow).toContain('GET')
      expect(res.allow).toContain('POST')
      expect(res.body).toBe('')
    } finally { await t.stop(100) }
  })

  it('is still 404 for a path that does not exist', async () => {
    const { t, probe } = await serve(app)
    try {
      expect((await probe('OPTIONS', '/no/such/path')).status).toBe(404)
    } finally { await t.stop(100) }
  })

  it('does not displace a registered OPTIONS — which is what cors mounts', async () => {
    const { t, probe } = await serve((r) => {
      r.get('/things', (ctx) => ctx.json({}))
      r.options('/*',  () => new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*' } }))
    })
    try {
      const res = await fetch(`http://localhost:${t.port}/things`, { method: 'OPTIONS' })
      expect(res.headers.get('access-control-allow-origin')).toBe('*')
      expect(res.headers.get('allow')).toBeNull()
    } finally { await t.stop(100) }
  })
})
