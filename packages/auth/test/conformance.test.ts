// test/conformance.test.ts
//
// IDEAS/mcp-oauth.md § What a Claude client needs, the half that needs a client
// document. The checklist is one list across two files, each bullet in its
// order: `example/web/test/verify-oauth.mjs` § What a Claude client needs runs
// the bullets a stranger can reach against the real example App (the 401
// header, both metadata documents, a form-encoded /token, timeouts, no
// client_credentials); the rows here run the ones that must hold a client
// document, which the example App is given no way to load.
//
// Below the checklist, the read-only copy (Phase 6): a second auth over a fresh
// database under the same `encryptionKey` stands in for a copy staged before
// the app was authorized.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { raw } from './audit-routes-http.ts'
import { pkceChallenge } from '../crypto.ts'
import {
  connector, refusedWith, CODE_ID, OTHER_ID, RESOURCE, CLAUDE_AI_CALLBACK, type Connector,
} from './connector.ts'

let offset = 0
const clock = { now: () => new Date(Date.now() + offset) }

let c: Connector
beforeAll(async () => { c = await connector(clock) })
afterAll(() => c.h.cleanup())

/** `/authorize` with one parameter changed: where it sent the browser, or null when it refused in place. */
async function authorizeWith(over: Record<string, string>) {
  const params = {
    response_type: 'code', client_id: CODE_ID, redirect_uri: 'http://localhost:51234/callback', state: 'st',
    code_challenge: pkceChallenge(randomBytes(32).toString('base64url')), code_challenge_method: 'S256',
    resource: RESOURCE, ...over,
  }
  const res = await raw(c.app, 'GET', `/auth/authorize?${new URLSearchParams(params)}`)
  return res.status === 302 ? new URL(res.headers.location!) : null
}

// ─── What a Claude client needs ───────────────────────────────────────────────

describe('client identity by CIMD', () => {
  test('the client_id is its document\'s URL: no registration, and the trade answers', async () => {
    const res = await c.exchange(await c.approve())
    expect(res.status).toBe(200)
    expect(res.body.refresh_token).toStartWith('fjr_')
  })

  test('a client_id whose document does not resolve is refused before any redirect', async () => {
    expect(await authorizeWith({ client_id: 'https://claude.ai/oauth/no-such-document' })).toBeNull()
  })
})

describe('S256 PKCE on every request', () => {
  test('a plain challenge is sent back invalid_request, carrying no code', async () => {
    const to = await authorizeWith({ code_challenge_method: 'plain' })
    expect(to?.searchParams.get('error')).toBe('invalid_request')
    expect(to?.searchParams.has('code')).toBe(false)
  })

  test('a code traded without its verifier is invalid_grant', async () => {
    const a = await c.approve()
    refusedWith(await c.exchange(a, { code_verifier: randomBytes(32).toString('base64url') }), 'invalid_grant')
  })
})

describe('a form-encoded /token', () => {
  test('a JSON body is invalid_request', async () => {
    const a   = await c.approve()
    const res = await raw(c.app, 'POST', '/auth/token', {
      headers: { 'content-type': 'application/json' },
      body:    JSON.stringify({ grant_type: 'authorization_code', code: a.code, code_verifier: a.verifier, client_id: CODE_ID, redirect_uri: a.redirect, resource: RESOURCE }),
    })
    refusedWith(res, 'invalid_request')
  })
})

describe('redirects', () => {
  test('claude.ai\'s callback is accepted for claude.ai\'s client', async () => {
    const a = await c.approve({ clientId: OTHER_ID, redirect: CLAUDE_AI_CALLBACK })
    expect((await c.exchange(a)).status).toBe(200)
  })

  for (const redirect of ['http://localhost:60123/callback', 'http://127.0.0.1:49152/callback']) {
    test(`a loopback on any port is accepted: ${new URL(redirect).hostname}`, async () => {
      const a = await c.approve({ redirect })
      expect((await c.exchange(a)).status).toBe(200)
    })
  }
})

describe('refresh tokens rotate', () => {
  test('the response that issues a new refresh token invalidates the old one once the grace has passed', async () => {
    const first  = (await c.exchange(await c.approve())).body
    const second = await c.refresh(first.refresh_token)
    expect(second.status).toBe(200)
    expect(second.body.refresh_token).not.toBe(first.refresh_token)
    offset += 31_000
    refusedWith(await c.refresh(first.refresh_token), 'invalid_grant')
    offset -= 31_000
  })
})

// ─── On a read-only copy ──────────────────────────────────────────────────────

describe('on a copy staged before the app was authorized', () => {
  let copy: Connector
  beforeAll(async () => { copy = await connector(clock) })
  afterAll(() => copy.h.cleanup())

  /** The live App's person, also on the copy under the same id: the copy was staged from the live database. */
  async function onBoth() {
    const a = await c.approve()
    await copy.h.sys.user.create({ data: { id: a.userId, email: a.email } })
    return { a, tokens: (await c.exchange(a)).body }
  }

  test('the copy accepts the live App\'s access token with no Session row: same key, no row (6.1)', async () => {
    const { a, tokens } = await onBoth()
    const principal: any = await copy.h.auth.verifySession(tokens.access_token)
    expect(principal?.id).toBe(a.userId)
    expect(principal.authorizedApp.clientId).toBe(CODE_ID)
    expect(principal.authorizedApp.audience).toBe(RESOURCE)
    expect(await copy.h.sys.session.findMany({ where: { userId: a.userId }, withExpired: true })).toHaveLength(0)
  })

  test('a refresh on the copy is invalid_grant, and the live App\'s app is untouched (6.3, FJS-D1928)', async () => {
    const { tokens } = await onBoth()
    refusedWith(await copy.refresh(tokens.refresh_token), 'invalid_grant')
    await new Promise((r) => setImmediate(r))
    // Unknown is not reuse: the copy has no row to purge and says nothing.
    expect(await copy.h.sys.auditTrail.findMany({ where: { operation: 'app.reuse-refused' } })).toHaveLength(0)
    const live = await c.refresh(tokens.refresh_token)
    expect(live.status).toBe(200)
  })
})
