// test/cookie-path.test.ts
//
// `Path` is the one Set-Cookie attribute written raw, so a `;` in it starts an
// attribute the caller did not mean and a control character splits the header
// (FJS-1840). The serializer is where that is refused, whoever built the path.

import { describe, test, expect } from 'bun:test'
import { createTestApp, request } from '../index.ts'

describe('ctx.setCookie path', () => {
  test('a safe path is written as given', async () => {
    const app = await createTestApp({})
    app.get('/ok', (ctx: any) => { ctx.setCookie('c', 'v', { path: '/a/b' }); return ctx.json({ ok: true }) })
    const res = await request(app).get('/ok')
    expect(res.status).toBe(200)
    expect(String(res.headers['set-cookie'])).toContain('Path=/a/b')
  })

  test.each(['/a; Domain=evil.test', '/a\r\nSet-Cookie: x=y'])('%j is refused, not written', async (path) => {
    const app = await createTestApp({})
    app.get('/bad', (ctx: any) => { ctx.setCookie('c', 'v', { path }); return ctx.json({}) })
    const res = await request(app).get('/bad')
    expect(res.status).toBe(500)
    expect(String(res.headers['set-cookie'] ?? '')).not.toContain('evil.test')
  })
})
