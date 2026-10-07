// test/audit-oauth-link-hijack.test.ts
//
// Audit 2026-10-05 — `confirmOAuthLink` attaches whichever identity asked,
// to whoever clicks.
//
// The oauthLink token proves the CLICKER controls the mailbox. It does not
// prove the clicker holds the provider identity waiting in the Verification
// row — that identity is the attacker's, and the mail was triggered by the
// attacker presenting the victim's address at the callback (branch 4,
// `proof-required`). The holder sees a genuine mail from the app saying an
// account is waiting to be connected and clicks. After that:
//
//   · the attacker's (provider, subject) is on the victim's account, and branch
//     1 signs the attacker in as the victim on the next callback;
//   · when the victim's account was UNVERIFIED (registered, not yet clicked
//     the verify mail), the eviction fires and takes the victim's own password
//     with it — then `FJS-D265` refuses them a reset, because the account is
//     now "OAuth-only". One click: takeover and lockout.
//
// A password-reset link gives the mailbox holder a credential THEY choose.
// This link gave them a credential somebody else chose. The click now starts
// the provider flow, and `confirmOAuthLink` attaches only when the provider
// returns the subject the invitation stored (FJS-D611) — the holder can return
// their own identity and never the attacker's.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, signedIn, type Harness } from './harness.ts'
import { defineProvider } from '../oauth.ts'
import { hashPassword } from '../crypto.ts'

const trusted   = defineProvider('google', 'google', { clientId: 'c', clientSecret: 's' })
const untrusted = defineProvider('okta',   'oidc',   {
  clientId: 'c', clientSecret: 's',
  authorizeUrl: 'https://o.test/a', tokenUrl: 'https://o.test/t', userinfoUrl: 'https://o.test/u',
})

let h: Harness
const sent: Array<{ email: string; token: string; provider: string }> = []

beforeAll(async () => {
  h = await makeAuth({
    oauthProviders:       { google: trusted, okta: untrusted },
    onOAuthLinkRequested: async (e) => { sent.push(e) },
  })
})
afterAll(() => h.cleanup())

const lastToken = () => sent[sent.length - 1]!.token

async function victimAccount(email: string, emailVerified: boolean) {
  const user = await h.sys.user.create({ data: { email, emailVerified } })
  await h.sys.credential.create({
    data: { userId: user.id, type: 'password', value: await hashPassword('victim-pass') },
  })
  return user
}

const attackerIdentity = (email: string, sub: string) =>
  ({ providerId: sub, email, emailVerified: true, name: 'Mallory' } as any)

// What the holder's click brings back from the provider: their own subject
// there, never the attacker's.
const holderIdentity = (email: string) =>
  ({ providerId: `holder-own-${email}`, email, emailVerified: true, name: 'Holder' } as any)

describe('an oauthLink invitation the address holder did not start', () => {

  test('a VERIFIED account: clicking does not hand the attacker a way in', async () => {
    const email  = 'holder-v@shop.test'
    const victim = await victimAccount(email, true)

    // The attacker presents the victim's address through the untrusted issuer.
    const out = await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-v'))
    expect(out.outcome).toBe('proof-required')

    // The holder clicks the mail and signs in at the provider as themselves.
    await h.auth.confirmOAuthLink(lastToken(), 'okta', holderIdentity(email)).catch(() => null)

    // The attacker comes back through their provider.
    const again = await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-v'))
    expect(again.outcome === 'signed-in' && again.user.userId === victim.id).toBe(false)
  })

  test('an UNVERIFIED account: clicking neither admits the attacker nor evicts the holder', async () => {
    const email  = 'holder-u@shop.test'
    const victim = await victimAccount(email, false)

    const out = await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-u'))
    expect(out.outcome).toBe('proof-required')

    await h.auth.confirmOAuthLink(lastToken(), 'okta', holderIdentity(email)).catch(() => null)

    const again = await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-u'))
    expect(again.outcome === 'signed-in' && again.user.userId === victim.id).toBe(false)

    // The holder's own password survives, or a reset is still open to them.
    let holderIn = false
    try {
      signedIn(await h.auth.login(email, 'victim-pass'))
      holderIn = true
    } catch {
      await h.requestReset(email)
      await h.auth.confirmPasswordReset!(h.resetToken(), 'victim-pass-2')
      signedIn(await h.auth.login(email, 'victim-pass-2'))
      holderIn = true
    }
    expect(holderIn).toBe(true)
  })

  // FJS-1847: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a (provider, subject) is attached to at most one account', async () => {
    // `Credential` indexes (type, value) without uniqueness, and
    // `confirmOAuthLink` never asks whether the waiting subject is already
    // somebody's. Branch 1 then answers whichever row `findFirst` reaches.
    const email = 'holder-dup@shop.test'
    await victimAccount(email, false)

    await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-dup'))
    const invite = lastToken()
    // The same subject, meanwhile, makes its own account on a mailbox it holds.
    await h.auth.oauthResolve('okta', attackerIdentity('mallory@evil.test', 'mallory-sub-dup'))
    await h.auth.confirmOAuthLink(lastToken(), 'okta', attackerIdentity('mallory@evil.test', 'mallory-sub-dup'))

    await h.auth.confirmOAuthLink(invite, 'okta', attackerIdentity(email, 'mallory-sub-dup')).catch(() => null)

    const rows = await h.sys.credential.findMany({ where: { type: 'oauth:okta', value: 'mallory-sub-dup' } })
    expect(new Set(rows.map((r: any) => r.userId)).size).toBeLessThanOrEqual(1)
  })
})
