// tests/oauth-flow.test.ts
//
// The half of OAuth that touches the database: writing a flow down and
// consuming it. `oauth.test.ts` beside this one is the engine, which needs
// neither a database nor a server; this one needs both halves of a round trip
// and a real Litestone client, because a fake one would be modelling the
// contract rather than exercising it.
//
// Everything here is a REFUSAL except two. That is the point of the file: the
// happy path is one branch and the published failures are all the others.

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { makeAuth, rejectsWith, type Harness } from './harness.ts'
import { defineProvider, OAuthError } from '../oauth.ts'

const REDIRECT = 'https://shop.test/auth/oauth/google/callback'

const providers = {
  google: defineProvider('google', 'google', { clientId: 'cid', clientSecret: 'sec' }),
  github: defineProvider('github', 'github', { clientId: 'cid', clientSecret: 'sec' }),
}

let h: Harness
beforeAll(async () => {
  h = await makeAuth({
    oauthProviders:     providers,
    oauthReturnToAllow: ['/dashboard', '/orders/'],
  })
})
afterAll(() => h.cleanup())

const realFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = realFetch })

/** A provider that hands back one identity, with no network. */
function stubProvider(identity: Record<string, unknown>) {
  globalThis.fetch = (async (input: any) => {
    const url = String(input)
    // 'token', not '/token': GitHub's endpoint is `oauth/access_token`, with an
    // underscore, so the stricter match sent an identity body back as the token
    // response and every GitHub case failed at the exchange for the wrong
    // reason — passing a test that was asserting something else entirely.
    // Neither provider's userinfo URL contains the word.
    const body = url.includes('token')
      ? { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }
      : identity
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
}

const flowRow = (state: string) =>
  h.sys.oauthFlow.findFirst({ where: { state } })

// ─── starting one ───────────────────────────────────────────────────────────

describe('oauthBegin', () => {

  test('writes the flow down and answers where to send the browser', async () => {
    const { authorizeUrl, state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })

    expect(authorizeUrl).toContain('accounts.google.com')
    expect(new URL(authorizeUrl).searchParams.get('state')).toBe(state)

    const row = await flowRow(state)
    expect(row.provider).toBe('google')
    expect(row.verifier).toBeTruthy()
    // OAuthFlow carries no identifier and no subject at all — nobody has proved
    // anything yet and there may be no account at the end of this.
    expect(row).not.toHaveProperty('identifier')
    expect(row).not.toHaveProperty('subject')
  })

  test('the verifier is stored and is NOT the challenge in the URL', async () => {
    // If these were the same value PKCE would be `plain` wearing S256's name.
    const { authorizeUrl, state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })
    const row = await flowRow(state)
    expect(new URL(authorizeUrl).searchParams.get('code_challenge')).not.toBe(row.verifier)
  })

  test('an allowed returnTo is kept', async () => {
    const { state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT, returnTo: '/orders/42' })
    expect((await flowRow(state)).returnTo).toBe('/orders/42')
  })

  test('a returnTo off the list is DROPPED, not refused', async () => {
    // The person asked to sign in. Where they land afterwards is not worth
    // failing that over — but it is worth refusing to honour.
    const { state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT, returnTo: '//evil.test' })
    expect((await flowRow(state)).returnTo).toBeNull()
  })

  test('an unknown provider is refused by name', async () => {
    await rejectsWith(() => h.auth.oauthBegin('faceboook', { redirectUri: REDIRECT }), OAuthError)
  })

  test('two flows do not collide', async () => {
    const a = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })
    const b = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })
    expect(a.state).not.toBe(b.state)
    expect((await flowRow(a.state)).verifier).not.toBe((await flowRow(b.state)).verifier)
  })
})

// ─── coming back from one ───────────────────────────────────────────────────

describe('oauthCallback', () => {

  test('the happy path ends at an identity and NOT at a session', async () => {
    // Who this identity is — link, create, or ask for proof — is a separate
    // decision with its own rules, and it is the one the CVEs are about.
    const { state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT, returnTo: '/dashboard' })
    stubProvider({ sub: '99', email: 'ada@shop.test', email_verified: true, name: 'Ada' })

    const out = await h.auth.oauthCallback('google', {
      code: 'c', state, cookieState: state, redirectUri: REDIRECT,
    })

    expect(out.identity.providerId).toBe('99')
    expect(out.identity.emailVerified).toBe(true)
    expect(out.returnTo).toBe('/dashboard')
    expect(out.tokens.accessToken).toBe('at')
    expect(out).not.toHaveProperty('token')
  })

  test('a state the browser cannot corroborate is refused — the login-CSRF case', async () => {
    // The attack is a callback URL handed to somebody who never started a flow.
    // Their browser carries no cookie, so there is nothing to corroborate with.
    const { state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })
    stubProvider({ sub: '99', email: 'a@b.c', email_verified: true })

    await rejectsWith(
      () => h.auth.oauthCallback('google', { code: 'c', state, cookieState: null, redirectUri: REDIRECT }),
      OAuthError,
    )
    // And the flow is untouched: the refusal happened before any read, so a
    // caller cannot use it to find out whether a state exists.
    expect(await flowRow(state)).toBeTruthy()
  })

  test("someone else's cookie does not corroborate this state", async () => {
    const mine   = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })
    const theirs = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })

    await rejectsWith(
      () => h.auth.oauthCallback('google', {
        code: 'c', state: mine.state, cookieState: theirs.state, redirectUri: REDIRECT,
      }),
      OAuthError,
    )
  })

  test('a flow is single use — the second attempt finds nothing', async () => {
    const { state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })
    stubProvider({ sub: '99', email: 'a@b.c', email_verified: true })

    await h.auth.oauthCallback('google', { code: 'c', state, cookieState: state, redirectUri: REDIRECT })

    expect(await flowRow(state)).toBeNull()
    await rejectsWith(
      () => h.auth.oauthCallback('google', { code: 'c', state, cookieState: state, redirectUri: REDIRECT }),
      OAuthError,
    )
  })

  test('the flow is claimed even when the exchange fails, so a replay finds nothing', async () => {
    // The trade is deliberate: a network failure costs the person a restart,
    // and the alternative leaves a live flow row behind every failure.
    const { state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'nope' }), {
      status: 400, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch

    await rejectsWith(
      () => h.auth.oauthCallback('google', { code: 'c', state, cookieState: state, redirectUri: REDIRECT }),
      OAuthError,
    )
    expect(await flowRow(state)).toBeNull()
  })

  test('a flow started for one provider cannot be finished with another', async () => {
    // State matched and the cookie matched. The only thing left saying which
    // provider this is, is the URL the browser came back on.
    const { state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })
    stubProvider({ id: 7, login: 'ada' })

    await rejectsWith(
      () => h.auth.oauthCallback('github', { code: 'c', state, cookieState: state, redirectUri: REDIRECT }),
      OAuthError,
    )
  })

  test('an expired flow is refused', async () => {
    const { state } = await h.auth.oauthBegin('google', { redirectUri: REDIRECT })
    const row = await flowRow(state)
    await h.sys.oauthFlow.update({
      where: { id: row.id },
      data:  { expiresAt: new Date(Date.now() - 1000).toISOString() },
    })
    stubProvider({ sub: '99', email: 'a@b.c', email_verified: true })

    await rejectsWith(
      () => h.auth.oauthCallback('google', { code: 'c', state, cookieState: state, redirectUri: REDIRECT }),
      OAuthError,
    )
  })

  test('a password-reset token cannot be spent as a flow state', async () => {
    // The purpose column, from the other direction (FJS-476).
    const u = await h.sys.user.create({ data: { email: 'cross@shop.test' } })
    await h.auth.requestPasswordReset!(u.email)
    const token = h.resetToken()

    await rejectsWith(
      () => h.auth.oauthCallback('google', {
        code: 'c', state: token, cookieState: token, redirectUri: REDIRECT,
      }),
      OAuthError,
    )
    // and the reset token still works for what it IS
    expect(await h.sys.verification.findFirst({
      where: { purpose: 'passwordReset', value: token },
    })).toBeTruthy()
  })

  test('an unknown provider is refused by name', async () => {
    await rejectsWith(
      () => h.auth.oauthCallback('faceboook', { code: 'c', state: 's', cookieState: 's', redirectUri: REDIRECT }),
      OAuthError,
    )
  })
})
