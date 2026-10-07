// AUDIT 1.1 (2026-10-05) — expected to FAIL on current code.
//
// A password change is the moment a person says "somebody else may hold my
// password". `confirmPasswordReset` revokes every session for that reason
// (auth.ts ~1510); `changePassword` (auth.ts ~1667) rewrites the hash and
// leaves every other session alive. A session stolen before the change keeps
// working for its whole TTL (30 days) after the owner has changed the password.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness, signedIn } from './harness.ts'

let h: Harness
beforeAll(async () => { h = await makeAuth() })
afterAll(() => h.cleanup())

describe('changePassword and the other sessions', () => {
  test('a session issued before a password change does not survive it', async () => {
    const email = 'change-pw@example.test'
    const made  = await h.auth.createUser({ email, password: 'pw-old-1' })

    const mine   = signedIn(await h.auth.login(email, 'pw-old-1'))
    const stolen = signedIn(await h.auth.login(email, 'pw-old-1'))
    expect(await h.auth.verifySession(stolen.token)).not.toBeNull()

    await h.auth.changePassword!(made.userId, 'pw-old-1', 'pw-new-2', { exceptSessionId: mine.user.sessionId })

    // The session that changed the password may stay; every other one must go.
    expect(await h.auth.verifySession(stolen.token)).toBeNull()
    expect(await h.auth.verifySession(mine.token)).not.toBeNull()
  })

  test('for comparison: a password RESET does revoke every session', async () => {
    const email = 'reset-pw@example.test'
    await h.auth.createUser({ email, password: 'pw-old-1' })
    const stolen = signedIn(await h.auth.login(email, 'pw-old-1'))

    await h.requestReset(email)
    await h.auth.confirmPasswordReset!(h.resetToken(), 'pw-new-2')

    expect(await h.auth.verifySession(stolen.token)).toBeNull()
  })
})
