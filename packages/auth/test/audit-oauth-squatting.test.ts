// test/audit-oauth-squatting.test.ts
//
// Audit 2026-10-05 — `oauthResolve` branch 3 writes an account for an address
// NOBODY PROVED, and every door the address holder has is then shut.
//
// The sequence: an attacker's identity from an untrusted issuer (the `oidc`
// preset, `trustEmail: false`) — or a trusted one that did not verify — claims
// the victim's address. Nobody holds it yet, so branch 3 creates the row
// (`emailVerified: false`), attaches the attacker's credential and signs the
// attacker in. The victim then finds:
//
//   · register / `createUser(victim)`         → EmailTakenError
//   · password reset for the address          → NoPasswordCredentialError, the
//     `FJS-D265` refusal, written for an account "secured by its provider" —
//     which this one never was: the only thing on it is a claim nobody vouched
//     for, about an address nobody checked
//   · `requestEmailVerification(attackerId)`  → mails the VICTIM a verify link
//     that, clicked, turns the squat into a verified account under their name
//
// The only way back is the victim signing in through an OAuth provider, which
// a person who never had one cannot do. Every row here asserts the way out:
// whoever proves the mailbox ends up with the account and the squatter's
// session dead. A fix that refuses branch 3 for an unproven address
// (proof-required, create on confirm) passes too, because the helper tries
// registration first.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, signedIn, type Harness } from './harness.ts'
import { defineProvider } from '../oauth.ts'

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

/**
 * The address holder's honest attempt to get in, through the doors this
 * package offers somebody with no OAuth account: register, and failing that,
 * reset the password the mailbox is for. Answers the session, or throws the
 * refusal that stopped them.
 */
async function victimGetsIn(email: string, password: string) {
  try {
    await h.auth.createUser({ email, password })
  } catch {
    // Somebody holds the address — the mailbox is the proof this package
    // accepts for a password, so prove it.
    await h.requestReset(email)
    await h.auth.confirmPasswordReset!(h.resetToken(), password)
  }
  return signedIn(await h.auth.login(email, password))
}

describe('an unproven address claimed through OAuth', () => {

  test('UNTRUSTED issuer: the mailbox holder still ends up with the account and the squatter does not', async () => {
    const email = 'squat-oidc@shop.test'

    const squat = await h.auth.oauthResolve('okta', {
      providerId: 'attacker-sub-1', email, emailVerified: true, name: 'Mallory',
    })
    const squatterToken = squat.outcome === 'signed-in' ? squat.token : null

    const victim = await victimGetsIn(email, 'victim-pass-1')
    expect(victim.user.email).toBe(email)

    // Whatever the squatter was issued is dead once the address answers for itself.
    if (squatterToken) expect(await h.auth.verifySession(squatterToken)).toBeNull()
    // And the squatter's identity no longer opens the account.
    const again = await h.auth.oauthResolve('okta', {
      providerId: 'attacker-sub-1', email, emailVerified: true, name: 'Mallory',
    })
    expect(again.outcome === 'signed-in' && again.user.userId === victim.user.userId).toBe(false)
  })

  test('TRUSTED issuer, unverified claim: the same', async () => {
    const email = 'squat-google@shop.test'

    const squat = await h.auth.oauthResolve('google', {
      providerId: 'attacker-sub-2', email, emailVerified: false, name: 'Mallory',
    })
    const squatterToken = squat.outcome === 'signed-in' ? squat.token : null

    const victim = await victimGetsIn(email, 'victim-pass-2')
    expect(victim.user.email).toBe(email)
    if (squatterToken) expect(await h.auth.verifySession(squatterToken)).toBeNull()
  })

  test('the squat cannot be laundered into a VERIFIED account by mailing the holder a verify link', async () => {
    // requestEmailVerification takes the attacker's own user id — a session
    // holder can ask for it — and mails the VICTIM. One click and the row is
    // `emailVerified: true` under an address the attacker never held, after
    // which a trusted provider sign-in by the victim LINKS onto it (branch 4,
    // all three conditions met) with the attacker's credential still attached.
    const email = 'launder@shop.test'
    const squat = await h.auth.oauthResolve('okta', {
      providerId: 'attacker-sub-3', email, emailVerified: true, name: 'Mallory',
    })
    if (squat.outcome !== 'signed-in') return   // refused at branch 3 — nothing to launder

    await h.auth.requestEmailVerification!(squat.user.userId)
    const token = h.verifyToken()
    if (token) await h.auth.verifyEmail!(token).catch(() => null)

    // The victim arrives with Google. Linking onto the squat hands them an
    // account the attacker can still open.
    const out = await h.auth.oauthResolve('google', {
      providerId: 'victim-google-sub', email, emailVerified: true, name: 'Victim',
    })
    if (out.outcome === 'signed-in') {
      const creds = await h.sys.credential.findMany({ where: { userId: out.user.userId } })
      expect(creds.some((c: any) => c.type === 'oauth:okta' && c.value === 'attacker-sub-3')).toBe(false)
    }
  })
})
