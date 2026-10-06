// test/audit-routes-http.ts
//
// Raw HTTP against a test app, for the audit-routes-* files.
//
// Junction's `request()` helper overwrites `content-type` with JSON whenever a
// body is sent, so a form-encoded or multipart body — what a cross-site
// `<form>` posts — cannot be sent through it. `app.http.fetch(Request)` is the
// same entry point `request()` uses, so everything below the transport (the
// real `parseBody`, the real cookie parse, the real `Set-Cookie` serializer)
// is exercised; only the socket is absent, which is why `ctx.ip` is always
// `127.0.0.1` here.

import { createTestApp } from '@frontierjs/junction'
import { createAuthPlugin } from '../plugin.ts'
import type { AuthPluginOptions } from '../types.ts'

export interface RawResponse {
  status:     number
  headers:    Record<string, string>
  setCookies: string[]
  body:       any
  text:       string
}

export async function appWith(auth: any, plugin: AuthPluginOptions = {}, config: Record<string, unknown> = {}) {
  const app: any = await createTestApp({ auth, config })
  app.setAuth(auth)
  app.configure(createAuthPlugin(auth, {
    loginRateLimit:         { max: 10_000, window: '15 minutes' },
    registerRateLimit:      { max: 10_000, window: '15 minutes' },
    passwordResetRateLimit: { max: 10_000, window: '15 minutes' },
    ...plugin,
  }))
  return app
}

export async function raw(
  app:  any,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: BodyInit | null } = {},
): Promise<RawResponse> {
  if (!app.http.router.isBuilt) {
    await app._startForTest()
    app.http.router.build()
  }
  const req = new Request(`http://localhost${path}`, {
    method,
    headers: opts.headers ?? {},
    body:    opts.body ?? null,
  })
  const res  = await app.http.fetch(req)
  const text = await res.text()
  let body: any = null
  try { body = text ? JSON.parse(text) : null } catch { body = null }
  const headers: Record<string, string> = {}
  res.headers.forEach((v: string, k: string) => { headers[k] = v })
  const setCookies: string[] = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (headers['set-cookie'] ? [headers['set-cookie']] : [])
  return { status: res.status, headers, setCookies, body, text }
}

export const json = (app: any, method: string, path: string, data: unknown, headers: Record<string, string> = {}) =>
  raw(app, method, path, { headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) })

export const form = (app: any, path: string, fields: Record<string, string>, headers: Record<string, string> = {}) =>
  raw(app, 'POST', path, {
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body:    new URLSearchParams(fields).toString(),
  })

export const multipart = (app: any, path: string, fields: Record<string, string>, headers: Record<string, string> = {}) => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  // No content-type here — Request derives multipart/form-data with the boundary.
  return raw(app, 'POST', path, { headers, body: fd })
}

/** What a browser sends on a cross-site top-level form POST. */
export const CROSS_SITE = {
  origin:           'https://evil.example',
  referer:          'https://evil.example/attack.html',
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
}

export const cookieOf = (res: RawResponse, name: string) =>
  res.setCookies.find(c => c.startsWith(`${name}=`)) ?? null

export const cookieValue = (res: RawResponse, name: string) => {
  const c = cookieOf(res, name)
  if (!c) return null
  return decodeURIComponent(c.slice(name.length + 1).split(';')[0]!)
}
