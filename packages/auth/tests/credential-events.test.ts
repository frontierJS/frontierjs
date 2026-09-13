// tests/credential-events.test.ts
//
// `onCredentialChanged` — the person being told that a way into their account
// changed, for every one of `CREDENTIAL_EVENTS`, from the REAL verb that makes
// the change rather than from a call to the helper.
//
// The failure this file exists for is silence. A notification that never fires
// looks exactly like an account nobody touched, so every event here is paired
// with the same verb REFUSED telling nobody — an observer wired to every call
// would pass any test that only asked about the successes — and the last test
// asserts the set of events seen is the whole list, so an event nothing emits
// is a red row rather than a missing one.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeAuth, rejectsWith, type Harness, TEST_KEY } from './harness.ts'
import { totp, TOTP_STEP_SEC } from '../totp.ts'
import { defineProvider, ReauthenticationFailedError, InvalidSecondFactorError } from '../index.ts'
import { CREDENTIAL_EVENTS, type CredentialChange } from '../types.ts'

const PASSWORD = 'correct-horse-1'

let h: Harness
let told: CredentialChange[] = []
let throwing = false
const seen = new Set<string>()
let seq = 0

beforeAll(async () => {
  h = await makeAuth({
    encryptionKey: TEST_KEY,
    // Wide enough to confirm and then sign in again inside one window — the
    // reason `totp-login.test.ts` keeps a second harness.
    totpDrift: 10,
    oauthProviders: { google: defineProvider('google', 'google', { clientId: 'c', clientSecret: 's' }) },
    onCredentialChanged: async (change) => {
      told.push(change)
      seen.add(change.event)
      if (throwing) throw new Error('the mail provider is down')
    },
  })
})
afterAll(() => h.cleanup())

async function makeUser() {
  const email = `cred-${Date.now()}-${seq++}@example.com`
  const user  = await h.auth.createUser({ email, password: PASSWORD })
  return { email, userId: user.userId }
}

async function withFactor() {
  const u = await makeUser()
  const { secret } = await h.auth.setupTotp!(u.userId, PASSWORD)
  const { recoveryCodes } = await h.auth.confirmTotp!(u.userId, totp(secret, new Date(Date.now() - 3 * TOTP_STEP_SEC * 1000)))
  return { ...u, secret, recoveryCodes }
}

/** What this act told the observer, and nothing from before it. */
async function tell(act: () => Promise<unknown>): Promise<CredentialChange[]> {
  told = []
  await act()
  return told
}

// ─── Every change, from the verb that makes it ────────────────────────────

describe('each change to how an account signs in tells the person', () => {

  test('password.changed — and a wrong current password tells nobody', async () => {
    const u = await makeUser()
    expect(await tell(() => rejectsWith(() => h.auth.changePassword!(u.userId, 'wrong', 'new-pw-1'), ReauthenticationFailedError))).toEqual([])

    const [change, ...rest] = await tell(() => h.auth.changePassword!(u.userId, PASSWORD, 'new-pw-1'))
    expect(rest).toEqual([])
    expect(change).toMatchObject({ event: 'password.changed', userId: u.userId, email: u.email, actorId: u.userId })
    expect(Number.isNaN(Date.parse(change!.at))).toBe(false)
  })

  test('password.reset — the change that recorded nothing before this, and a dead token tells nobody', async () => {
    const u = await makeUser()
    expect(await tell(() => h.auth.confirmPasswordReset!('not-a-token', 'new-pw-2').catch(() => {}))).toEqual([])

    await h.auth.requestPasswordReset!(u.email)
    const changes = await tell(() => h.auth.confirmPasswordReset!(h.resetToken(), 'new-pw-2'))
    expect(changes.map(c => c.event)).toEqual(['password.reset'])
    expect(changes[0]).toMatchObject({ userId: u.userId, email: u.email })
  })

  test('totp.enabled on confirm — and setup, which enables nothing, tells nobody', async () => {
    const u = await makeUser()
    let secret = ''
    expect(await tell(async () => { secret = (await h.auth.setupTotp!(u.userId, PASSWORD)).secret })).toEqual([])

    const changes = await tell(() => h.auth.confirmTotp!(u.userId, totp(secret, new Date())))
    expect(changes.map(c => c.event)).toEqual(['totp.enabled'])
  })

  test('recoveryCodes.regenerated — and a wrong password tells nobody', async () => {
    const u = await withFactor()
    expect(await tell(() => rejectsWith(() => h.auth.regenerateRecoveryCodes!(u.userId, 'wrong'), ReauthenticationFailedError))).toEqual([])
    expect((await tell(() => h.auth.regenerateRecoveryCodes!(u.userId, PASSWORD))).map(c => c.event))
      .toEqual(['recoveryCodes.regenerated'])
  })

  test('recovery.used — the sign-in a person with their phone never makes; a bad code tells nobody', async () => {
    const u = await withFactor()
    const { challenge } = await h.auth.login(u.email, PASSWORD) as any
    expect(await tell(() => rejectsWith(() => h.auth.completeLogin!(challenge, 'AAAAA-AAAAA'), InvalidSecondFactorError))).toEqual([])

    const changes = await tell(() => h.auth.completeLogin!(challenge, u.recoveryCodes[0]!))
    expect(changes.map(c => c.event)).toEqual(['recovery.used'])
    expect(changes[0]!.meta).toEqual({ remaining: 9 })
  })

  test('the ordinary second step tells nobody — a code from the phone is not news', async () => {
    const u = await withFactor()
    const { challenge } = await h.auth.login(u.email, PASSWORD) as any
    expect(await tell(() => h.auth.completeLogin!(challenge, totp(u.secret, new Date(Date.now() + 3 * TOTP_STEP_SEC * 1000))))).toEqual([])
  })

  test('totp.disabled — and a wrong password tells nobody', async () => {
    const u = await withFactor()
    expect(await tell(() => rejectsWith(() => h.auth.disableTotp!(u.userId, 'wrong'), ReauthenticationFailedError))).toEqual([])
    expect((await tell(() => h.auth.disableTotp!(u.userId, PASSWORD))).map(c => c.event)).toEqual(['totp.disabled'])
  })

  test('totp.reset names the OPERATOR as actor and the person as the recipient', async () => {
    const op = await makeUser()
    const u  = await withFactor()
    const changes = await tell(() => h.auth.resetTotp!(u.userId, { actorId: op.userId }))
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ event: 'totp.reset', userId: u.userId, email: u.email, actorId: op.userId })
  })

  test('apikey.created and apikey.revoked — and revoking a key that is not yours tells nobody', async () => {
    const u = await makeUser(), other = await makeUser()
    let id = ''
    const created = await tell(async () => { id = (await h.auth.createApiKey(u.userId, { name: 'ci' })).id })
    expect(created.map(c => c.event)).toEqual(['apikey.created'])

    expect(await tell(() => h.auth.revokeApiKey(id, { userId: other.userId }).catch(() => {}))).toEqual([])
    expect((await tell(() => h.auth.revokeApiKey(id, { userId: u.userId }))).map(c => c.event)).toEqual(['apikey.revoked'])
  })

  test('oauth.linked and oauth.unlinked — and removing the last way in tells nobody', async () => {
    const email = `linked-${seq++}@shop.test`
    const user  = await h.sys.user.create({ data: { email, emailVerified: true } })
    await h.sys.credential.create({ data: { userId: user.id, type: 'password', value: 'planted-hash' } })

    const linked = await tell(() => h.auth.oauthResolve('google', {
      providerId: `sub-${seq++}`, email, emailVerified: true, name: 'L',
    } as any))
    expect(linked.map(c => c.event)).toEqual(['oauth.linked'])
    expect(linked[0]!.meta).toMatchObject({ provider: 'google' })

    const oauth = await h.sys.credential.findFirst({ where: { userId: user.id, type: 'oauth:google' } })
    expect((await tell(() => h.auth.removeConnection!(user.id, oauth.id))).map(c => c.event)).toEqual(['oauth.unlinked'])

    // Only the password is left now, and it is not a connection — the refusal
    // is the last-credential rule on an account with nothing else attached.
    const only = await h.sys.user.create({ data: { email: `only-${seq++}@shop.test`, emailVerified: true } })
    const sole = await h.sys.credential.create({ data: { userId: only.id, type: 'oauth:google', value: `s-${seq++}` } })
    expect(await tell(() => h.auth.removeConnection!(only.id, sole.id).catch(() => {}))).toEqual([])
  })
})

// ─── An observer, not a hook ──────────────────────────────────────────────

describe('a throw from the observer refuses nothing', () => {

  test('the factor is still off when the mail provider is down — paired with the call telling it', async () => {
    const u = await withFactor()
    throwing = true
    try {
      const changes = await tell(() => h.auth.disableTotp!(u.userId, PASSWORD))
      expect(changes.map(c => c.event)).toEqual(['totp.disabled'])
    } finally {
      throwing = false
    }
    expect(await h.auth.totpStatus!(u.userId)).toEqual({ enabled: false, recoveryCodesRemaining: 0 })
  })

  test('nothing secret travels — no password, code, TOTP secret or key in any change', async () => {
    const u = await makeUser()
    const secrets: string[] = [PASSWORD]
    const all = await tell(async () => {
      const { secret } = await h.auth.setupTotp!(u.userId, PASSWORD)
      secrets.push(secret)
      const { recoveryCodes } = await h.auth.confirmTotp!(u.userId, totp(secret, new Date()))
      secrets.push(...recoveryCodes)
      secrets.push(...(await h.auth.regenerateRecoveryCodes!(u.userId, PASSWORD)).recoveryCodes)
      secrets.push((await h.auth.createApiKey(u.userId)).key)
    })
    expect(all.map(c => c.event)).toEqual(['totp.enabled', 'recoveryCodes.regenerated', 'apikey.created'])
    const wire = JSON.stringify(all)
    for (const s of secrets) expect(wire.includes(s)).toBe(false)
  })
})

// ─── Nothing reaches the trail without reaching the person ────────────────

describe('the vocabulary is closed in both directions', () => {

  test('no credential event is written to the trail except through the helper that also tells the person', () => {
    const source = readFileSync(join(import.meta.dir, '../auth.ts'), 'utf8')
    const direct = [...source.matchAll(/\baudit\(\s*'([^']+)'/g)].map(m => m[1]!)

    // The control: the scan reads real calls. A regex matching nothing passes
    // the assertion below against any file.
    expect(direct).toContain('login.succeeded')
    expect(direct.filter(op => (CREDENTIAL_EVENTS as readonly string[]).includes(op))).toEqual([])
  })

  test('every event in the list was told by a real verb above', () => {
    expect([...seen].sort()).toEqual([...CREDENTIAL_EVENTS].sort())
  })
})
