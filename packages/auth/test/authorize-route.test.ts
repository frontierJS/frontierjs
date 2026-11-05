// test/authorize-route.test.ts
//
// `GET` / `POST /authorize` over real HTTP (`FJS-D1925`), Phase 2's Done-when
// item by item. Client documents are Claude's two fixtures, served by a stub
// `fetch` set on the auth object's `clients`; `allowPrivate` skips the DNS
// lookup, which would reach the network for claude.ai. The App states no
// `publicUrl`, so the resource is `http://localhost/mcp`.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { makeAuth, TEST_KEY, type Harness } from './harness.ts'
import { appWith, raw, form, CROSS_SITE } from './audit-routes-http.ts'
import { pkceChallenge } from '../crypto.ts'
import { totp } from '../totp.ts'
import { STYLE_HASH } from '../authorize-page.snapshot.js'

const fixture     = (name: string) => readFileSync(join(import.meta.dir, 'fixtures/cimd', name), 'utf8')
const AI_ID       = 'https://claude.ai/oauth/mcp-oauth-client-metadata'
const CODE_ID     = 'https://claude.ai/oauth/claude-code-client-metadata'
const EVIL_ID     = 'https://evil.example/client'
const WRONG_ID    = 'https://evil.example/not-mine'
const LOOPBACK    = 'http://localhost:51234/callback'
const AI_REDIRECT = 'https://claude.ai/api/mcp/auth_callback'
const RESOURCE    = 'http://localhost/mcp'
const PASSWORD    = 'pw-authorize-1'

const DOCS: Record<string, string> = {
  [AI_ID]:    fixture('claude-ai.json'),
  [CODE_ID]:  fixture('claude-code.json'),
  [EVIL_ID]:  JSON.stringify({ ...JSON.parse(fixture('claude-ai.json')), client_id: EVIL_ID, client_name: 'Claude', redirect_uris: ['https://evil.example/cb'] }),
  [WRONG_ID]: fixture('claude-ai.json'),
}

const stubFetch = (async (url: string) => {
  const body = DOCS[String(url)]
  return body === undefined
    ? new Response('not found', { status: 404 })
    : new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' } })
}) as unknown as typeof fetch

let h: Harness
let app: any
let cookieApp: any
let seq = 0

beforeAll(async () => {
  h = await makeAuth({ encryptionKey: TEST_KEY })
  Object.assign((h.auth as any).clients, { fetch: stubFetch, allowPrivate: true })
  app       = await appWith(h.auth, {}, { name: 'Acme' })
  cookieApp = await appWith(h.auth, { cookieAuth: true }, { name: 'Acme' })
})
afterAll(() => h.cleanup())

function request(over: Record<string, string> = {}) {
  const verifier = randomBytes(32).toString('base64url')
  const params = {
    response_type: 'code', client_id: CODE_ID, redirect_uri: LOOPBACK, state: `st-${seq++}`,
    code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', resource: RESOURCE, ...over,
  }
  return { verifier, params }
}

const get = (params: Record<string, string>, on = app) => raw(on, 'GET', `/auth/authorize?${new URLSearchParams(params)}`)

/** The hidden inputs a rendered page carries, as the next POST would send them. */
function hidden(html: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"/g))
    out[m[1]!] = m[2]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  return out
}

async function user(withTotp = false) {
  const email = `authz-${seq++}@example.com`
  const u: any = await h.auth.createUser({ email, password: PASSWORD })
  let secret: string | undefined
  if (withTotp) {
    secret = (await h.auth.setupTotp!(String(u.id))).secret
    await h.auth.confirmTotp!(String(u.id), totp(secret, new Date()))
  }
  return { id: String(u.id), email, secret }
}

/** Password, then the code when owed: the consent page. */
async function toConsent(params: Record<string, string>, u: { email: string, secret?: string }) {
  let res = await form(app, '/auth/authorize', { ...hidden((await get(params)).text), email: u.email, password: PASSWORD })
  if (u.secret) {
    expect(res.text).toContain('Six-digit code')
    // The next step, so `confirmTotp`'s own code is not replayed.
    const code = totp(u.secret, new Date(Date.now() + 30_000))
    res = await form(app, '/auth/authorize', { ...hidden(res.text), code })
  }
  expect(res.status).toBe(200)
  expect(res.text).toContain('name="decision" value="allow"')
  return res
}

describe('the Done-when', () => {
  test('password and TOTP end in a 302 to the loopback redirect with code and state, and the code redeems', async () => {
    const u = await user(true)
    const { verifier, params } = request()
    const consent = await toConsent(params, u)
    const res = await form(app, '/auth/authorize', { ...hidden(consent.text), decision: 'allow' })
    expect(res.status).toBe(302)
    const to = new URL(res.headers.location!)
    expect(`${to.origin}${to.pathname}`).toBe(LOOPBACK)
    expect(to.searchParams.get('state')).toBe(params.state)
    const redeemed = await h.auth.redeemAuthorizationCode!({
      code: to.searchParams.get('code')!, verifier, clientId: CODE_ID, redirectUri: LOOPBACK, resource: RESOURCE,
    })
    expect(redeemed.userId).toBe(u.id)
  })

  test('a redirect the document does not list is 400 plain text before any page', async () => {
    const res = await get(request({ redirect_uri: 'https://evil.example/cb' }).params)
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toStartWith('text/plain')
    expect(res.headers.location).toBeUndefined()
    expect(res.text).not.toContain('<form')
  })

  test('a POST with a swapped redirect is the same refusal', async () => {
    const page = await get(request().params)
    const res  = await form(app, '/auth/authorize', { ...hidden(page.text), redirect_uri: 'https://evil.example/cb', email: 'x@example.com', password: 'x' })
    expect(res.status).toBe(400)
    expect(res.headers['content-type']).toStartWith('text/plain')
  })

  test('a document whose own client_id is not the URL fetched is 400', async () => {
    const res = await get(request({ client_id: WRONG_ID, redirect_uri: AI_REDIRECT }).params)
    expect(res.status).toBe(400)
    expect(res.text).toContain('different client_id')
  })

  test('a document calling itself Claude from evil.example shows evil.example', async () => {
    const u   = await user()
    const res = await toConsent(request({ client_id: EVIL_ID, redirect_uri: 'https://evil.example/cb' }).params, u)
    expect(res.text).toContain('<strong>evil.example</strong>')
    expect(res.text).not.toContain('Claude')
  })

  test('the Claude Code document warns about loopback and the claude.ai one does not', async () => {
    const u    = await user()
    const code = await toConsent(request().params, u)
    const ai   = await toConsent(request({ client_id: AI_ID, redirect_uri: AI_REDIRECT }).params, u)
    expect(code.text).toContain('a program on this computer')
    expect(ai.text).not.toContain('a program on this computer')
  })
})

describe('the steps', () => {
  test('Deny redirects with access_denied and state', async () => {
    const { params } = request()
    const consent = await toConsent(params, await user())
    const res = await form(app, '/auth/authorize', { ...hidden(consent.text), decision: 'deny' })
    expect(res.status).toBe(302)
    const to = new URL(res.headers.location!)
    expect(to.searchParams.get('error')).toBe('access_denied')
    expect(to.searchParams.get('state')).toBe(params.state)
    expect(to.searchParams.get('code')).toBeNull()
  })

  test('a wrong password re-renders the password step with an error, status 200', async () => {
    const u   = await user()
    const res = await form(app, '/auth/authorize', { ...hidden((await get(request().params)).text), email: u.email, password: 'wrong' })
    expect(res.status).toBe(200)
    expect(res.text).toContain('role="alert"')
    expect(res.text).toContain('name="password"')
  })

  test('a forged user id is not read, and a spent ticket is refused', async () => {
    const victim = await user()
    const consent = await toConsent(request().params, await user())
    const fields  = { ...hidden(consent.text), decision: 'allow', userId: victim.id }
    const first   = await form(app, '/auth/authorize', fields)
    expect(first.status).toBe(302)
    const again = await form(app, '/auth/authorize', fields)
    expect(again.status).toBe(200)
    expect(again.text).toContain('already used')

    const forged = await form(app, '/auth/authorize', { ...fields, ticket: 'not-a-ticket' })
    expect(forged.status).toBe(200)
    expect(forged.headers.location).toBeUndefined()
  })

  test('a ticket is bound to the PKCE challenge it was issued under', async () => {
    const consent = await toConsent(request().params, await user())
    const res = await form(app, '/auth/authorize', { ...hidden(consent.text), code_challenge: request().params.code_challenge, decision: 'allow' })
    expect(res.status).toBe(200)
    expect(res.headers.location).toBeUndefined()
  })

  test('a bad challenge method goes back to the checked redirect as invalid_request', async () => {
    const { params } = request({ code_challenge_method: 'plain' })
    const res = await get(params)
    expect(res.status).toBe(302)
    const to = new URL(res.headers.location!)
    expect(to.searchParams.get('error')).toBe('invalid_request')
    expect(to.searchParams.get('state')).toBe(params.state)
  })

  test('a resource other than the App\'s MCP URL goes back as invalid_target (RFC 8707)', async () => {
    const res = await get(request({ resource: 'https://other.example/mcp' }).params)
    expect(new URL(res.headers.location!).searchParams.get('error')).toBe('invalid_target')
  })

  test('response_type other than code goes back as unsupported_response_type', async () => {
    const res = await get(request({ response_type: 'token' }).params)
    expect(new URL(res.headers.location!).searchParams.get('error')).toBe('unsupported_response_type')
  })
})

describe('the headers', () => {
  test('form-action names self and the checked redirect origin, port included', async () => {
    const res = await get(request().params)
    expect(res.headers['content-security-policy']).toContain("form-action 'self' http://localhost:51234;")
    const ai = await get(request({ client_id: AI_ID, redirect_uri: AI_REDIRECT }).params)
    expect(ai.headers['content-security-policy']).toContain("form-action 'self' https://claude.ai;")
  })

  test('the CSP is one policy, and its style-src is the page\'s STYLE_HASH', async () => {
    const res = await get(request().params)
    const csp = res.headers['content-security-policy']!
    expect(csp).toBe(`default-src 'none'; style-src '${STYLE_HASH}'; form-action 'self' http://localhost:51234; frame-ancestors 'none'; base-uri 'none'`)
  })

  test('a page is html, never cached, and titled for the App', async () => {
    const res = await get(request().params)
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(res.headers['cache-control']).toBe('no-store')
    expect(res.text).toContain('<title>Sign in to Acme</title>')
  })

  test('a cross-site POST is refused by csrf() in cookie mode', async () => {
    const page = await get(request().params, cookieApp)
    const u    = await user()
    const res  = await form(cookieApp, '/auth/authorize', { ...hidden(page.text), email: u.email, password: PASSWORD }, CROSS_SITE)
    expect(res.status).toBe(403)
  })
})
