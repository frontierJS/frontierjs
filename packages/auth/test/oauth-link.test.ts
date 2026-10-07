// test/oauth-link.test.ts
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
import { defineProvider, InvalidTokenError, OAuthError } from '../index.ts'

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
    await rejectsWith(() => h.auth.confirmOAuthLink(first, 'google', id({ providerId: 'o-1' })), InvalidTokenError)
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

    const issued = await h.auth.confirmOAuthLink(lastToken(), 'google', id({ providerId: 'c-1' }))

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

    await h.auth.confirmOAuthLink(lastToken(), 'google', id({ providerId: 'p-1' }))

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
    await h.auth.confirmOAuthLink(lastToken(), 'google', id({ providerId: 's-1' }))

    expect(await h.auth.verifySession('attacker-session')).toBeNull()
  })

  test('an identity attached while the account was unverified is evicted too', async () => {
    // An identity on an unverified row was never vouched for by anybody, so it
    // goes with the password.
    const user = await h.sys.user.create({ data: { email: 'twodoor@shop.test', emailVerified: false } })
    await h.sys.credential.create({ data: { userId: user.id, type: 'oauth:okta', value: 'okta-sub' } })

    await h.auth.oauthResolve('google', id({ providerId: 'g-sub', email: 'twodoor@shop.test' }))
    await h.auth.confirmOAuthLink(lastToken(), 'google', id({ providerId: 'g-sub' }))

    const creds = await credsFor(user.id)
    expect(creds.some((c: any) => c.type === 'oauth:okta')).toBe(false)
    expect(creds.some((c: any) => c.type === 'oauth:google')).toBe(true)
  })

  test('the proof IS the verification', async () => {
    // Leaving the row unverified would send the next identity round the same
    // loop for ever.
    const user = await account('verifyme@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'v-1', email: 'verifyme@shop.test' }))
    await h.auth.confirmOAuthLink(lastToken(), 'google', id({ providerId: 'v-1' }))

    expect((await h.sys.user.findUnique({ where: { id: user.id } })).emailVerified).toBe(true)
  })

  test('a VERIFIED account keeps its credentials — the eviction is conditional', async () => {
    // Reached when the account is verified but the PROVIDER is not trusted, so
    // proof-required fires without the account being in doubt. This row proved
    // its address long ago; its password is its own.
    const user = await account('kept@shop.test', true)
    await h.auth.oauthResolve('okta', id({ providerId: 'k-1', email: 'kept@shop.test' }))
    expect(sent[sent.length - 1].email).toBe('kept@shop.test')

    await h.auth.confirmOAuthLink(lastToken(), 'okta', id({ providerId: 'k-1' }))

    const creds = await credsFor(user.id)
    expect(creds.some((c: any) => c.type === 'password')).toBe(true)
    expect(creds.some((c: any) => c.type === 'oauth:okta')).toBe(true)
  })

  test('is single use', async () => {
    await account('single@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'sg-1', email: 'single@shop.test' }))
    const token = lastToken()

    await h.auth.confirmOAuthLink(token, 'google', id({ providerId: 'sg-1' }))
    await rejectsWith(() => h.auth.confirmOAuthLink(token, 'google', id({ providerId: 'sg-1' })), InvalidTokenError)
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

    await rejectsWith(() => h.auth.confirmOAuthLink(token, 'google', id({ providerId: 'st-1' })), InvalidTokenError)
  })

  test('a password-reset token cannot be spent here', async () => {
    // `purpose` from a third direction (FJS-476).
    const u = await account('cross2@shop.test', true)
    await h.requestReset(u.email)
    await rejectsWith(() => h.auth.confirmOAuthLink(h.resetToken(), 'google', id()), InvalidTokenError)
  })

  test('the mailbox alone attaches nothing: another subject is refused and spends the link', async () => {
    // The token proves the mailbox; the identity waiting on it may be somebody
    // else's, so the provider has to return that same subject (FJS-1819).
    const user = await account('other-sub@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'asked-1', email: 'other-sub@shop.test' }))
    const token = lastToken()

    await rejectsWith(() => h.auth.confirmOAuthLink(token, 'google', id({ providerId: 'clicker-1' })), OAuthError)

    const creds = await credsFor(user.id)
    expect(creds.some((c: any) => c.type === 'password')).toBe(true)
    expect(creds.some((c: any) => c.type === 'oauth:google')).toBe(false)
    await rejectsWith(() => h.auth.confirmOAuthLink(token, 'google', id({ providerId: 'asked-1' })), InvalidTokenError)
  })

  test('the same subject at another provider is refused', async () => {
    const user = await account('other-prov@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'shared-1', email: 'other-prov@shop.test' }))

    await rejectsWith(() => h.auth.confirmOAuthLink(lastToken(), 'okta', id({ providerId: 'shared-1' })), OAuthError)
    expect((await credsFor(user.id)).some((c: any) => String(c.type).startsWith('oauth:'))).toBe(false)
  })
})

// ─── the mailed link starts a flow ──────────────────────────────────────────

describe('oauthBegin with a link', () => {

  test('carries the invitation and spends nothing, so a prefetch changes nothing', async () => {
    const user = await account('prefetch@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'pf-1', email: 'prefetch@shop.test' }))
    const token = lastToken()

    const { state } = await h.auth.oauthBegin('google', { redirectUri: 'https://shop.test/cb', link: token })

    const flow = await h.sys.oauthFlow.findFirst({ where: { state } })
    expect(flow.invitation).toBe(token)
    expect(await h.sys.verification.findFirst({ where: { purpose: 'oauthLink', value: token } })).toBeTruthy()
    expect((await credsFor(user.id)).some((c: any) => c.type === 'password')).toBe(true)
  })

  test('a link for another provider, or none at all, starts no flow', async () => {
    await account('wrongprov@shop.test', false)
    await h.auth.oauthResolve('google', id({ providerId: 'wp-1', email: 'wrongprov@shop.test' }))

    await rejectsWith(() => h.auth.oauthBegin('okta', { redirectUri: 'https://shop.test/cb', link: lastToken() }), InvalidTokenError)
    await rejectsWith(() => h.auth.oauthBegin('google', { redirectUri: 'https://shop.test/cb', link: 'nope' }), InvalidTokenError)
  })
})

// ─── an address nobody holds ────────────────────────────────────────────────
//
// Branch 3 on an unproven claim makes no row: a row would squat the address,
// shutting its holder out of register and reset (FJS-1820, FJS-D612). The
// account is made on the click, once the mailbox and the identity both answer.

describe('an unproven claim on an address nobody holds', () => {

  test('mails an invitation and writes no account', async () => {
    const out = await h.auth.oauthResolve('okta', id({ providerId: 'nh-1', email: 'nohold@shop.test' }))

    expect(out.outcome).toBe('proof-required')
    expect(sent[sent.length - 1]).toMatchObject({ email: 'nohold@shop.test', provider: 'okta' })
    expect(await h.sys.user.findFirst({ where: { email: 'nohold@shop.test' } })).toBeNull()
  })

  test('the click makes a verified account holding that identity and signs in', async () => {
    await h.auth.oauthResolve('google', id({ providerId: 'nh-2', email: 'later@shop.test', emailVerified: false }))

    const issued = await h.auth.confirmOAuthLink(lastToken(), 'google', id({ providerId: 'nh-2', name: 'Later' }))

    const user = await h.sys.user.findFirst({ where: { email: 'later@shop.test' } })
    expect(issued.user.userId).toBe(user.id)
    expect(user.emailVerified).toBe(true)
    expect(user.name).toBe('Later')
    expect((await credsFor(user.id)).map((c: any) => [c.type, c.value])).toEqual([['oauth:google', 'nh-2']])
  })

  test('another identity on the click makes nothing', async () => {
    await h.auth.oauthResolve('okta', id({ providerId: 'atk-nh', email: 'mismatch-nh@shop.test' }))

    await rejectsWith(() => h.auth.confirmOAuthLink(lastToken(), 'okta', id({ providerId: 'holder-nh' })), OAuthError)
    expect(await h.sys.user.findFirst({ where: { email: 'mismatch-nh@shop.test' } })).toBeNull()
  })

  test('onRegister refuses on the click, and nothing is written', async () => {
    const mails: Array<{ token: string }> = []
    const closed = await makeAuth({
      oauthProviders:       { okta: untrusted },
      onOAuthLinkRequested: async (e) => { mails.push(e) },
      onRegister:           async () => { throw new Error('closed beta') },
    })
    try {
      const out = await closed.auth.oauthResolve('okta', id({ providerId: 'cb-1', email: 'beta@shop.test' }))
      expect(out.outcome).toBe('proof-required')
      await expect(closed.auth.confirmOAuthLink(mails[0]!.token, 'okta', id({ providerId: 'cb-1' })))
        .rejects.toThrow('closed beta')
      expect(await closed.sys.user.findFirst({ where: { email: 'beta@shop.test' } })).toBeNull()
    } finally { closed.cleanup() }
  })
})
