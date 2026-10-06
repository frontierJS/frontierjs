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
// This link gives them a credential somebody else chose. Both rows assert the
// attacker never ends up signed in as the victim; a fix that binds the confirm
// to the browser that ran the flow, or that requires the holder's own
// credential before attaching, passes either way.

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

describe('an oauthLink invitation the address holder did not start', () => {

  test('a VERIFIED account: clicking does not hand the attacker a way in', async () => {
    const email  = 'holder-v@shop.test'
    const victim = await victimAccount(email, true)

    // The attacker presents the victim's address through the untrusted issuer.
    const out = await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-v'))
    expect(out.outcome).toBe('proof-required')

    // The holder clicks the mail, in their own browser, with no part in the flow.
    await h.auth.confirmOAuthLink(lastToken()).catch(() => null)

    // The attacker comes back through their provider.
    const again = await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-v'))
    expect(again.outcome === 'signed-in' && again.user.userId === victim.id).toBe(false)
  })

  test('an UNVERIFIED account: clicking neither admits the attacker nor evicts the holder', async () => {
    const email  = 'holder-u@shop.test'
    const victim = await victimAccount(email, false)

    const out = await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-u'))
    expect(out.outcome).toBe('proof-required')

    await h.auth.confirmOAuthLink(lastToken()).catch(() => null)

    const again = await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-u'))
    expect(again.outcome === 'signed-in' && again.user.userId === victim.id).toBe(false)

    // The holder's own password survives, or a reset is still open to them.
    let holderIn = false
    try {
      signedIn(await h.auth.login(email, 'victim-pass'))
      holderIn = true
    } catch {
      await h.auth.requestPasswordReset!(email)
      await h.auth.confirmPasswordReset!(h.resetToken(), 'victim-pass-2')
      signedIn(await h.auth.login(email, 'victim-pass-2'))
      holderIn = true
    }
    expect(holderIn).toBe(true)
  })

  test('a (provider, subject) is attached to at most one account', async () => {
    // `Credential` indexes (type, value) without uniqueness, and
    // `confirmOAuthLink` never asks whether the waiting subject is already
    // somebody's. Branch 1 then answers whichever row `findFirst` reaches.
    const email = 'holder-dup@shop.test'
    await victimAccount(email, false)

    await h.auth.oauthResolve('okta', attackerIdentity(email, 'mallory-sub-dup'))
    const invite = lastToken()
    // The same subject, meanwhile, makes its own account.
    await h.auth.oauthResolve('okta', attackerIdentity('mallory@evil.test', 'mallory-sub-dup'))

    await h.auth.confirmOAuthLink(invite).catch(() => null)

    const rows = await h.sys.credential.findMany({ where: { type: 'oauth:okta', value: 'mallory-sub-dup' } })
    expect(new Set(rows.map((r: any) => r.userId)).size).toBeLessThanOrEqual(1)
  })
})
