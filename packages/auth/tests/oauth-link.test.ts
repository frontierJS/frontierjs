// tests/oauth-link.test.ts
//
// The way out of `proof-required`, and the other half of the CVE fix.
//
// `oauth-resolve.test.ts` asserts the REFUSAL: an identity is not attached to
// an account that never proved it owns its address. That is the whole security
// property, and on its own it is a dead end — the person cannot sign in and is
// never told how. This file is the recovery, and the recovery is where the
// eviction happens.
//
// The account being claimed was never verified. So nothing already on it was
// ever shown to belong to whoever owns the address: not the password somebody
// planted, and not an identity from an issuer nobody vouched for. Attaching to
// it while leaving those in place would hand the person an account that
// somebody else can still open.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, rejectsWith, type Harness } from './harness.ts'
import { defineProvider, InvalidTokenError } from '../index.ts'

const trusted   = defineProvider('google', 'google', { clientId: 'c', clientSecret: 's' })
const untrusted = defineProvider('okta',   'oidc',   {
  clientId: 'c', clientSecret: 's',
  authorizeUrl: 'https://o.test/a', tokenUrl: 'https://o.test/t', userinfoUrl: 'https://o.test/u',
})

let h: Harness
let sent: Array<{ email: string; token: string; provider: string }> = []

beforeAll(async () => {
  h = await makeAuth({
    oauthProviders:       { google: trusted, okta: untrusted },
    onOAuthLinkRequested: async (e) => { sent.push(e) },
  })
})
afterAll(() => h.cleanup())

const lastToken = () => sent[sent.length - 1]!.token
const id = (over: Record<string, unknown> = {}) => ({
  providerId: 'sub-1', email: 'x@shop.test', emailVerified: true, name: 'X', ...over,
} as any)

/** A local account with a password on it, verified or not. */
async function account(email: string, emailVerified: boolean) {
  const user = await h.sys.user.create({ data: { email, emailVerified } })
  await h.sys.credential.create({ data: { userId: user.id, type: 'password', value: 'planted-hash' } })
  return user
}

const credsFor = (userId: string) => h.sys.credential.findMany({ where: { userId } })

// ─── the invitation ─────────────────────────────────────────────────────────

describe('a refused link sends an invitation', () => {

  test('mints a token and hands it to the app to deliver', async () => {
    await account('invite@shop.test', false)
    const out = await h.auth.oauthResolve('google', id({ providerId: 'i-1', email: 'invite@shop.test' }))

    expect(out.outcome).toBe('proof-required')
    expect(sent[sent.length - 1]).toMatchObject({ email: 'invite@shop.test', provider: 'google' })
    expect(lastToken()).toBeTruthy()
  })

  test('a second attempt replaces the first, so one address holds one invitation', async () => {
    await account('once@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'o-1', email: 'once@shop.test' }))
    const first = lastToken()
    await h.auth.oauthResolve('google', id({ providerId: 'o-2', email: 'once@shop.test' }))

    const rows = await h.sys.verification.findMany({
      where: { purpose: 'oauthLink', identifier: 'once@shop.test' },
    })
    expect(rows.length).toBe(1)
    // and the superseded one is dead
    await rejectsWith(() => h.auth.confirmOAuthLink(first), InvalidTokenError)
  })

  test('the refusal still holds when no delivery hook is configured', async () => {
    // The rule is the security property; delivery is the way out of it. An app
    // with no mailer must still refuse rather than fall through to attaching.
    const silent = await makeAuth({ oauthProviders: { google: trusted } })
    try {
      await silent.sys.user.create({ data: { email: 'nohook@shop.test', emailVerified: false } })
      const out = await silent.auth.oauthResolve('google', id({ providerId: 'n-1', email: 'nohook@shop.test' }))
      expect(out.outcome).toBe('proof-required')
    } finally { silent.cleanup() }
  })
})

// ─── proving it ─────────────────────────────────────────────────────────────

describe('confirmOAuthLink', () => {

  test('attaches the identity and signs the person in', async () => {
    const user = await account('claim@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'c-1', email: 'claim@shop.test' }))

    const issued = await h.auth.confirmOAuthLink(lastToken())

    expect(issued.token).toBeTruthy()
    expect(issued.user.userId).toBe(user.id)
    expect((await credsFor(user.id)).some((c: any) => c.type === 'oauth:google' && c.value === 'c-1')).toBe(true)
  })

  test('THE OTHER HALF OF THE CVE: the planted password is evicted', async () => {
    // Pre-registration — somebody signed up with this address and a password
    // they control. Proving the address must take the account back, not share
    // it with them.
    const victim = await account('planted@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'p-1', email: 'planted@shop.test' }))

    await h.auth.confirmOAuthLink(lastToken())

    const creds = await credsFor(victim.id)
    expect(creds.some((c: any) => c.type === 'password')).toBe(false)
    expect(creds.some((c: any) => c.type === 'oauth:google')).toBe(true)
  })

  test("an attacker's live session is revoked, not just their password", async () => {
    // Killing the credential and leaving the session is an eviction that
    // evicts nobody — they are already inside.
    const victim = await account('session@shop.test', false)
    await h.sys.session.create({
      data: { userId: victim.id, token: 'attacker-session', expiresAt: new Date(Date.now() + 8.64e7).toISOString() },
    })

    await h.auth.oauthResolve('google', id({ providerId: 's-1', email: 'session@shop.test' }))
    await h.auth.confirmOAuthLink(lastToken())

    expect(await h.auth.verifySession('attacker-session')).toBeNull()
  })

  test('an identity attached while the account was unverified is evicted too', async () => {
    // The same hole through a different door: an account created via an
    // UNTRUSTED issuer is unverified, and that issuer's identity was never
    // vouched for by anybody either.
    await h.auth.oauthResolve('okta', id({ providerId: 'okta-sub', email: 'twodoor@shop.test' }))
    const user = await h.sys.user.findFirst({ where: { email: 'twodoor@shop.test' } })
    expect(user.emailVerified).toBe(false)

    await h.auth.oauthResolve('google', id({ providerId: 'g-sub', email: 'twodoor@shop.test' }))
    await h.auth.confirmOAuthLink(lastToken())

    const creds = await credsFor(user.id)
    expect(creds.some((c: any) => c.type === 'oauth:okta')).toBe(false)
    expect(creds.some((c: any) => c.type === 'oauth:google')).toBe(true)
  })

  test('the proof IS the verification', async () => {
    // Leaving the row unverified would send the next identity round the same
    // loop for ever.
    const user = await account('verifyme@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'v-1', email: 'verifyme@shop.test' }))
    await h.auth.confirmOAuthLink(lastToken())

    expect((await h.sys.user.findUnique({ where: { id: user.id } })).emailVerified).toBe(true)
  })

  test('a VERIFIED account keeps its credentials — the eviction is conditional', async () => {
    // Reached when the account is verified but the PROVIDER is not trusted, so
    // proof-required fires without the account being in doubt. This row proved
    // its address long ago; its password is its own.
    const user = await account('kept@shop.test', true)
    await h.auth.oauthResolve('okta', id({ providerId: 'k-1', email: 'kept@shop.test' }))
    expect(sent[sent.length - 1].email).toBe('kept@shop.test')

    await h.auth.confirmOAuthLink(lastToken())

    const creds = await credsFor(user.id)
    expect(creds.some((c: any) => c.type === 'password')).toBe(true)
    expect(creds.some((c: any) => c.type === 'oauth:okta')).toBe(true)
  })

  test('is single use', async () => {
    await account('single@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'sg-1', email: 'single@shop.test' }))
    const token = lastToken()

    await h.auth.confirmOAuthLink(token)
    await rejectsWith(() => h.auth.confirmOAuthLink(token), InvalidTokenError)
  })

  test('an expired invitation is refused', async () => {
    await account('stale@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'st-1', email: 'stale@shop.test' }))
    const token = lastToken()

    const row = await h.sys.verification.findFirst({ where: { purpose: 'oauthLink', value: token } })
    await h.sys.verification.update({
      where: { id: row.id },
      data:  { expiresAt: new Date(Date.now() - 1000).toISOString() },
    })

    await rejectsWith(() => h.auth.confirmOAuthLink(token), InvalidTokenError)
  })

  test('a password-reset token cannot be spent here', async () => {
    // `purpose` from a third direction (FJS-476).
    const u = await account('cross2@shop.test', true)
    await h.auth.requestPasswordReset!(u.email)
    await rejectsWith(() => h.auth.confirmOAuthLink(h.resetToken()), InvalidTokenError)
  })
})
