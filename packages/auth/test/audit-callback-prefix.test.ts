// test/audit-callback-prefix.test.ts — one owner for `apiPrefix` (Invariant 4).
//
// Fable audit run 2.1. Junction's `normalizePrefix()` is the one owner of
// `apiPrefix`: it strips a slash from BOTH ends and prepends one, so `'api'`,
// `'/api'`, `'api/'` and `'/api/'` all mount routes under `/api`. A `callbackPath`
// that re-normalizes the raw `app.config.apiPrefix` itself, stripping the
// trailing slash only, hands a provider `api/auth/oauth/…` under
// `apiPrefix: 'api'` — in the redirect URI and the state cookie's `Path` —
// while the callback is mounted at `/api/auth/oauth/…`. The boot check catches
// the mismatch and refuses to start, so the symptom is an app that will not boot
// on a spelling every other route accepts (FJS-2445).

import { describe, test, expect, afterAll } from 'bun:test'
import { createTestApp, request } from '@frontierjs/junction'
import { auth } from '../plugin.ts'
import { defineProvider, OAUTH_STATE_COOKIE } from '../oauth.ts'
import { makeAuth, type Harness } from './harness.ts'

const PUBLIC_URL = 'https://shop.test'
const cleanups: Array<() => void> = []
afterAll(() => { for (const c of cleanups) c() })

async function appWithPrefix(apiPrefix: string) {
  const h: Harness = await makeAuth({
    oauthProviders: { google: defineProvider({ name: 'google', preset: 'google', clientId: 'cid', clientSecret: 'sec' }) },
  })
  cleanups.push(() => h.cleanup())
  const app: any = await createTestApp({ auth: h.auth as any, config: { apiPrefix } as any })
  app.setAuth(h.auth as any)
  app.configure(auth({
    auth: h.auth,
    cookieAuth: true,
    oauth: { publicUrl: PUBLIC_URL, rateLimit: { max: 10_000, window: '15 minutes' } },
  }))
  return app
}

// The authorize redirect carries the redirect URI the provider will match, and
// the state cookie's Path is the same path; both come from `callbackPath`.
async function startFlow(app: any) {
  const res    = await request(app).get('/api/auth/oauth/google')
  const cookie = String(res.headers?.['set-cookie'] ?? '')
  const url    = new URL(String(res.headers?.['location'] ?? 'https://x.invalid/'))
  return { status: res.status, cookie, redirectUri: url.searchParams.get('redirect_uri') }
}

describe('the redirect URI follows the mounted route under every apiPrefix spelling', () => {

  test('control: the conventional "/api" spelling agrees with the owner', async () => {
    const app = await appWithPrefix('/api')
    const { status, cookie, redirectUri } = await startFlow(app)
    expect(status).toBe(302)
    expect(redirectUri).toBe(`${PUBLIC_URL}/api/auth/oauth/google/callback`)
    expect(cookie).toContain(`${OAUTH_STATE_COOKIE}=`)
    expect(cookie).toMatch(/Path=\/api\/auth\/oauth\/google\/callback/i)
  })

  test('the "api" spelling mounts and redirects under /api, as normalizePrefix does', async () => {
    const app = await appWithPrefix('api')
    const { status, cookie, redirectUri } = await startFlow(app)
    expect(status).toBe(302)
    expect(redirectUri).toBe(`${PUBLIC_URL}/api/auth/oauth/google/callback`)
    expect(cookie).toMatch(/Path=\/api\/auth\/oauth\/google\/callback/i)
  })
})
