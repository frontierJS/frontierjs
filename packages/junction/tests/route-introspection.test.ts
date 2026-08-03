// tests/route-introspection.test.ts
//
// hasRoute vs hasExactRoute, and where the startup banner gets its URLs.
//
// The banner used hasRoute() to decide whether to advertise /health and /docs.
// hasRoute() answers "would a request for this path match something", and every
// app registers `GET /{service}` — which matches /health. So EVERY app printed
//
//   health: http://host:port/health
//
// and that URL 404'd unless healthPlugin() happened to be configured. The
// endpoint was fine; the advertisement was fiction.

import { describe, it, expect } from 'bun:test'
import { createTestApp, request } from '../src/testing/index.ts'
import { healthPlugin } from '../src/transport/health.ts'

// ─── hasRoute vs hasExactRoute ────────────────────────────────────────────

describe('hasRoute matches, hasExactRoute exists', () => {
  it('hasRoute is TRUE for an unmounted /health — the dynamic service route absorbs it', async () => {
    const app = await createTestApp()
    await app._startForTest()
    app.http.router.build()

    // Documenting the trap, not endorsing it: this is why the banner lied.
    expect(app.http.router.hasRoute('GET', '/health')).toBe(true)
  })

  it('hasExactRoute is FALSE for the same unmounted path', async () => {
    const app = await createTestApp()
    await app._startForTest()
    app.http.router.build()

    expect(app.http.router.hasExactRoute('GET', '/health')).toBe(false)
    expect(app.http.router.hasExactRoute('GET', '/docs')).toBe(false)
  })

  it('hasExactRoute is TRUE once the endpoint is really mounted', async () => {
    const app = await createTestApp()
    app.configure(healthPlugin())
    await app._startForTest()
    app.http.router.build()

    expect(app.http.router.hasExactRoute('GET', '/health')).toBe(true)
  })

  it('hasExactRoute does not confuse a path with the dynamic bucket', async () => {
    const app = await createTestApp()
    app.get('/D', () => ({ ok: true }))
    await app._startForTest()
    app.http.router.build()

    expect(app.http.router.hasExactRoute('GET', '/D')).toBe(true)
    expect(app.http.router.hasExactRoute('GET', '/nope')).toBe(false)
  })
})

// ─── the endpoint itself ──────────────────────────────────────────────────

describe('/health responds when mounted', () => {
  it('404s on an app that never configured healthPlugin', async () => {
    const app = await createTestApp()
    expect((await request(app).get('/health')).status).toBe(404)
  })

  it('200s with a status body when healthPlugin is configured', async () => {
    const app = await createTestApp()
    app.configure(healthPlugin())

    const res = await request(app).get('/health')

    expect(res.status).toBe(200)
    expect((res.body as { status: string }).status).toBe('ok')
  })

  it('mounts under an explicit path when given one', async () => {
    const app = await createTestApp()
    app.configure(healthPlugin({ path: '/internal' }))

    expect((await request(app).get('/internal/health')).status).toBe(200)
    expect((await request(app).get('/health')).status).toBe(404)
  })
})

// ─── routePaths — how the banner finds the real mount point ───────────────

describe('routePaths', () => {
  it('reports nothing health-shaped on a default app', async () => {
    const app = await createTestApp()
    await app._startForTest()
    app.http.router.build()

    const health = app.http.router.routePaths('GET').filter(p => p.endsWith('/health'))
    expect(health).toEqual([])
  })

  it('finds the endpoint wherever it is mounted', async () => {
    const app = await createTestApp()
    app.configure(healthPlugin({ path: '/internal' }))
    await app._startForTest()
    app.http.router.build()

    // Probing a guessed '/health' would have missed this one entirely, which is
    // why the banner asks where it is rather than whether it is where expected.
    const health = app.http.router.routePaths('GET').filter(p => p.endsWith('/health'))
    expect(health).toEqual(['/internal/health'])
  })

  it('includes dynamic routes, so callers can filter templates out', async () => {
    const app = await createTestApp()
    await app._startForTest()
    app.http.router.build()

    const paths = app.http.router.routePaths('GET')
    expect(paths.some(p => p.includes('{'))).toBe(true)
    // The banner drops these — `/{service}/health` is not a visitable URL.
    expect(paths.filter(p => !p.includes('{')).some(p => p.includes('{'))).toBe(false)
  })

  it('returns [] for a method with no routes', async () => {
    const app = await createTestApp()
    await app._startForTest()
    app.http.router.build()

    expect(app.http.router.routePaths('TRACE')).toEqual([])
  })
})
