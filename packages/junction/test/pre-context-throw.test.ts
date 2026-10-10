// A throw between the route match and the first middleware (FJS-2240).
//
// Everything before `_execute` ran outside the request's try, so a throw there
// reached only Bun's server-level handler: a bare 500 text body, no status
// mapping, and `onError` called without a request to name. An over-limit query
// is a 400 the caller can act on; a 500 tells them nothing and counts against
// the app.

import { describe, it, expect } from 'bun:test'
import { HttpTransport } from '../src/transport/http.ts'
import { FrameworkError } from '../src/core/errors.ts'

async function serve(opts: ConstructorParameters<typeof HttpTransport>[0] = {}) {
  const t = new HttpTransport({ port: 0, ...opts })
  t.router.get('/things', (ctx) => ctx.json({ ok: 1 }))
  t.router.build()
  t.start(0)
  return t
}

describe('a throw before the context exists', () => {

  it('answers an over-limit query 400, not Bun\'s bare 500', async () => {
    const t = await serve()
    try {
      const many = Array.from({ length: 1100 }, (_, i) => `k${i}=1`).join('&')
      const bad  = await fetch(`http://localhost:${t.port}/things?${many}`)
      expect(bad.status).toBe(400)
      expect(bad.headers.get('content-type')).toContain('application/json')

      const ok = await fetch(`http://localhost:${t.port}/things?k=1`)
      expect(ok.status).toBe(200)
    } finally { t.stop?.() }
  })

  it('maps a throw out of _buildContext through errorResponse and tells onError', async () => {
    const seen: unknown[] = []
    const t = await serve({ onError: (err) => { seen.push(err) } })
    try {
      ;(t as unknown as { _buildContext: () => never })._buildContext = () => {
        throw Object.assign(new FrameworkError('nope'), { code: 403 })
      }
      const res = await fetch(`http://localhost:${t.port}/things`)
      expect(res.status).toBe(403)
      expect(res.headers.get('content-type')).toContain('application/json')
      expect(seen).toHaveLength(1)
    } finally { t.stop?.() }
  })
})
