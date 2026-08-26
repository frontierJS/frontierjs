// tests/oauth-resolve.test.ts
//
// Who is this identity? The security core, and the file that exists because of
// two published CVEs rather than because of a feature.
//
// `CVE-2026-53516` (Better Auth) and `CVE-2026-35511` (Authorizer) are one
// omission: the auto-link gate reads the PROVIDER's `emailVerified` and never
// the local row's. The attack is pre-registration — somebody signs up with the
// victim's address and a password they control, the row is written unverified,
// the victim later signs in with Google, and the two are fused with the
// attacker's password still on the account.
//
// Every test below that names a condition is asserting the refusal, not the
// feature. The happy paths are three of fifteen.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, rejectsWith, type Harness } from './harness.ts'
import { defineProvider, OAuthError } from '../oauth.ts'

// Two providers whose only difference is whether their claim means anything.
const trusted   = defineProvider('google', 'google', { clientId: 'c', clientSecret: 's' })
const untrusted = defineProvider('okta',   'oidc',   {
  clientId: 'c', clientSecret: 's',
  authorizeUrl: 'https://o.test/a', tokenUrl: 'https://o.test/t', userinfoUrl: 'https://o.test/u',
})

let h: Harness
beforeAll(async () => {
  h = await makeAuth({ oauthProviders: { google: trusted, okta: untrusted } })
})
afterAll(() => h.cleanup())

const id = (over: Record<string, unknown> = {}) => ({
  providerId:    'sub-1',
  email:         'ada@shop.test',
  emailVerified: true,
  name:          'Ada',
  ...over,
} as any)

const userByEmail = (email: string) => h.sys.user.findFirst({ where: { email } })
const credsFor    = (userId: string) => h.sys.credential.findMany({ where: { userId } })

// ─── 1. seen before ─────────────────────────────────────────────────────────

describe('a provider account we have seen', () => {

  test('signs in, and is matched on the SUBJECT rather than the address', async () => {
    const first = await h.auth.oauthResolve('google', id({ providerId: 's-100', email: 'first@shop.test' }))
    expect(first.outcome).toBe('signed-in')

    // Same subject, DIFFERENT address — people change their email at the
    // provider and the account is still theirs. Matching on the address would
    // have created a second account here.
    const again = await h.auth.oauthResolve('google', id({ providerId: 's-100', email: 'renamed@shop.test' }))
    expect(again.outcome).toBe('signed-in')
    if (again.outcome !== 'signed-in' || first.outcome !== 'signed-in') throw new Error('unreachable')
    expect(again.user.userId).toBe(first.user.userId)
  })

  test('the same subject at a DIFFERENT provider is a different person', async () => {
    // Two providers can issue the same subject string. The key is the pair.
    await h.auth.oauthResolve('google', id({ providerId: 'collide', email: 'g@shop.test' }))
    const other = await h.auth.oauthResolve('okta', id({ providerId: 'collide', email: 'o@shop.test' }))
    expect(other.outcome).toBe('signed-in')

    const g = await userByEmail('g@shop.test')
    const o = await userByEmail('o@shop.test')
    expect(g.id).not.toBe(o.id)
  })

  test('a session is issued and no third-party token is kept', async () => {
    // Sign-in only. Holding an access token nothing refreshes pays the whole
    // cost of keeping one and buys a capability that expires within the hour.
    const out = await h.auth.oauthResolve('google', id({ providerId: 's-tok', email: 'tok@shop.test' }))
    if (out.outcome !== 'signed-in') throw new Error('expected sign-in')
    expect(out.token).toBeTruthy()

    const [cred] = await credsFor(out.user.userId)
    expect(cred.type).toBe('oauth:google')
    expect(cred.value).toBe('s-tok')
    expect(cred.accessToken).toBeNull()
    expect(cred.refreshToken).toBeNull()
  })
})

// ─── 2. no address ──────────────────────────────────────────────────────────

describe('an identity with no address', () => {

  test('is refused by name — GitHub reaches here whenever the primary is unverified', async () => {
    await rejectsWith(
      () => h.auth.oauthResolve('google', id({ providerId: 'no-mail', email: null })),
      OAuthError,
    )
  })
})

// ─── 3. nobody holds the address ────────────────────────────────────────────

describe('an address nobody holds', () => {

  test('creates the account and signs in', async () => {
    const out = await h.auth.oauthResolve('google', id({ providerId: 'new-1', email: 'new@shop.test' }))
    expect(out.outcome).toBe('signed-in')
    expect((await userByEmail('new@shop.test'))).toBeTruthy()
  })

  test('a trusted verified claim carries emailVerified onto the new account', async () => {
    await h.auth.oauthResolve('google', id({ providerId: 'v-1', email: 'verified@shop.test' }))
    expect((await userByEmail('verified@shop.test')).emailVerified).toBe(true)
  })

  test('an UNTRUSTED provider does not, however loudly it claims', async () => {
    // nOAuth: the issuer is whatever the app pointed `oidc` at, and an attacker
    // who can stand one up can assert anything.
    await h.auth.oauthResolve('okta', id({ providerId: 'u-1', email: 'untrusted@shop.test', emailVerified: true }))
    expect((await userByEmail('untrusted@shop.test')).emailVerified).toBe(false)
  })

  test("onRegister can refuse, and nothing is written when it does", async () => {
    const closed = await makeAuth({
      oauthProviders: { google: trusted },
      onRegister: async ({ email }) => {
        if (email.endsWith('@blocked.test')) throw new Error('closed beta')
      },
    })
    try {
      await expect(
        closed.auth.oauthResolve('google', id({ providerId: 'b-1', email: 'x@blocked.test' })),
      ).rejects.toThrow('closed beta')
      expect(await closed.sys.user.findFirst({ where: { email: 'x@blocked.test' } })).toBeNull()
    } finally { closed.cleanup() }
  })

  test('the address is lowercased before it is matched or stored', async () => {
    // `@lower` is a WRITE transform, so a where-clause carrying the provider's
    // casing matches nothing — which reads as "nobody holds this" and makes a
    // second account for somebody who already has one.
    await h.auth.oauthResolve('google', id({ providerId: 'case-1', email: 'Case@Shop.test' }))
    expect(await userByEmail('case@shop.test')).toBeTruthy()

    const again = await h.auth.oauthResolve('google', id({ providerId: 'case-2', email: 'CASE@shop.TEST' }))
    // Different subject, same address, and the account is verified — so this is
    // a LINK rather than a second account.
    expect(again.outcome).toBe('signed-in')
    expect((await h.sys.user.findMany({ where: { email: 'case@shop.test' } })).length).toBe(1)
  })
})

// ─── 4. somebody holds it — the three conditions ────────────────────────────

describe('an address somebody already holds', () => {

  /** A local account, verified or not, with a password on it. */
  async function localAccount(email: string, emailVerified: boolean) {
    const user = await h.sys.user.create({ data: { email, emailVerified } })
    await h.sys.credential.create({ data: { userId: user.id, type: 'password', value: 'hash' } })
    return user
  }

  test('THE CVE: an unverified local account is NOT linked, however verified the provider says it is', async () => {
    // Pre-registration. The attacker holds the password on this row.
    const victim = await localAccount('victim@shop.test', false)

    const out = await h.auth.oauthResolve('google', id({
      providerId: 'atk-1', email: 'victim@shop.test', emailVerified: true,
    }))

    expect(out.outcome).toBe('proof-required')
    // Nothing attached, nobody signed in.
    expect((await credsFor(victim.id)).some((c: any) => c.type === 'oauth:google')).toBe(false)
    expect(out).not.toHaveProperty('token')
  })

  test('all three conditions met → linked and signed in', async () => {
    const user = await localAccount('linkme@shop.test', true)

    const out = await h.auth.oauthResolve('google', id({ providerId: 'link-1', email: 'linkme@shop.test' }))

    expect(out.outcome).toBe('signed-in')
    if (out.outcome !== 'signed-in') throw new Error('unreachable')
    expect(out.user.userId).toBe(user.id)
    expect((await credsFor(user.id)).some((c: any) => c.type === 'oauth:google')).toBe(true)
  })

  test('a verified local account is still not linked by an UNTRUSTED provider', async () => {
    await localAccount('trusted-only@shop.test', true)
    const out = await h.auth.oauthResolve('okta', id({
      providerId: 'okta-1', email: 'trusted-only@shop.test', emailVerified: true,
    }))
    expect(out.outcome).toBe('proof-required')
  })

  test('a trusted provider that did NOT verify does not link either', async () => {
    await localAccount('unclaimed@shop.test', true)
    const out = await h.auth.oauthResolve('google', id({
      providerId: 'unv-1', email: 'unclaimed@shop.test', emailVerified: false,
    }))
    expect(out.outcome).toBe('proof-required')
  })

  test('each condition alone is enough to refuse', async () => {
    // The truth table, so a future edit that collapses three conjuncts into two
    // fails here rather than in an advisory.
    const cases: Array<[string, string, boolean, boolean]> = [
      ['okta',   'a@t.test', true,  true ],  // untrusted provider
      ['google', 'b@t.test', false, true ],  // provider did not verify
      ['google', 'c@t.test', true,  false],  // WE did not verify
    ]
    for (const [provider, email, providerVerified, accountVerified] of cases) {
      await localAccount(email, accountVerified)
      const out = await h.auth.oauthResolve(provider, id({
        providerId: `tt-${email}`, email, emailVerified: providerVerified,
      }))
      expect(out.outcome).toBe('proof-required')
    }
  })
})
