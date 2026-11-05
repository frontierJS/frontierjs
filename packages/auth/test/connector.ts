// test/connector.ts
//
// A Claude connector against a real auth: `/authorize` to Allow, `/token` for
// the code and each refresh, over real HTTP. The client documents are Claude
// Code's and claude.ai's fixtures, served by a stub `fetch` on the auth's
// `clients`, so nothing leaves the process. The clock is the caller's, passed in, so a test moves
// the grace window and the row's expiry by moving its own offset.
//
// Not a `.test.ts`: a test file imported by another registers its tests twice.

import { expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { makeAuth, TEST_KEY, type Harness } from './harness.ts'
import { appWith, raw, form } from './audit-routes-http.ts'
import { pkceChallenge } from '../crypto.ts'

export const CODE_ID  = 'https://claude.ai/oauth/claude-code-client-metadata'
export const OTHER_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
export const LOOPBACK = 'http://localhost:51234/callback'
export const RESOURCE = 'http://localhost/mcp'
export const PASSWORD = 'pw-token-1'
export const CLAUDE_AI_CALLBACK = 'https://claude.ai/api/mcp/auth_callback'
const DOCS: Record<string, string> = {
  [CODE_ID]:  readFileSync(join(import.meta.dir, 'fixtures/cimd/claude-code.json'), 'utf8'),
  [OTHER_ID]: readFileSync(join(import.meta.dir, 'fixtures/cimd/claude-ai.json'), 'utf8'),
}

const stubFetch = (async (url: string) => DOCS[String(url)]
  ? new Response(DOCS[String(url)], { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } })
  : new Response('not found', { status: 404 })) as unknown as typeof fetch

export interface Connector {
  h:        Harness
  app:      any
  /** A new person (or the one at `email`), through `/authorize` to Allow: the code, its verifier and who approved it. */
  approve:  (opts?: { redirect?: string, email?: string, clientId?: string }) => Promise<{ userId: string, email: string, code: string, verifier: string, redirect: string, clientId: string }>
  token:    (fields: Record<string, string>) => Promise<any>
  exchange: (a: { code: string, verifier: string, redirect?: string, clientId?: string }, over?: Record<string, string>) => Promise<any>
  refresh:  (refreshToken: string, over?: Record<string, string>) => Promise<any>
  /** The `Session` id an access token names. */
  sessionOf: (accessToken: string) => Promise<string>
}

function hidden(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g))
    out[m[1]!] = m[2]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  return out
}

export async function connector(clock: { now: () => Date }, opts: Record<string, unknown> = {}): Promise<Connector> {
  const h = await makeAuth({ encryptionKey: TEST_KEY, ...opts }, clock)
  Object.assign((h.auth as any).clients, { fetch: stubFetch, allowPrivate: true })
  const app = await appWith(h.auth, {}, { name: 'Acme' })
  let seq = 0

  async function approve(o: { redirect?: string, email?: string, clientId?: string } = {}) {
    const clientId = o.clientId ?? CODE_ID
    const email    = o.email ?? `token-${seq++}-${randomBytes(3).toString('hex')}@example.com`
    const redirect = o.redirect ?? LOOPBACK
    const u: any   = o.email ? await h.sys.user.findFirst({ where: { email } }) : await h.auth.createUser({ email, password: PASSWORD })
    const verifier = randomBytes(32).toString('base64url')
    const params = {
      response_type: 'code', client_id: clientId, redirect_uri: redirect, state: `st-${seq++}`,
      code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', resource: RESOURCE,
    }
    const page    = await raw(app, 'GET', `/auth/authorize?${new URLSearchParams(params)}`)
    const consent = await form(app, '/auth/authorize', { ...hidden(page.text), email, password: PASSWORD })
    const done    = await form(app, '/auth/authorize', { ...hidden(consent.text), decision: 'allow' })
    expect(done.status).toBe(302)
    return { userId: String(u.id), email, code: new URL(done.headers.location!).searchParams.get('code')!, verifier, redirect, clientId }
  }

  const token = (fields: Record<string, string>) => form(app, '/auth/token', fields)
  const exchange = (a: { code: string, verifier: string, redirect?: string, clientId?: string }, over: Record<string, string> = {}) => token({
    grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier,
    client_id: a.clientId ?? CODE_ID, redirect_uri: a.redirect ?? LOOPBACK, resource: RESOURCE, ...over,
  })
  const refresh = (refreshToken: string, over: Record<string, string> = {}) =>
    token({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CODE_ID, ...over })
  const sessionOf = async (accessToken: string) =>
    String(((await h.auth.verifySession(accessToken)) as any).authorizedApp.sessionId)

  return { h, app, approve, token, exchange, refresh, sessionOf }
}

/** RFC 6749 § 5.2's refusal: a 400 JSON body naming the error, never cached. */
export function refusedWith(res: any, error: string) {
  expect(res.status).toBe(400)
  expect(res.body.error).toBe(error)
  expect(typeof res.body.error_description).toBe('string')
  expect(res.headers['cache-control']).toBe('no-store')
}
