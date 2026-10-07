// An address holding a capital letter signs in and recovers (FJS-1456).
// `User.email` is `@lower`, so it is stored lowercased; login and reset look it
// up by the address as typed, and matched nothing until litestone ran the
// field's write transforms over an equality where too.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness, signedIn } from './harness.ts'

let h: Harness
beforeAll(async () => { h = await makeAuth() })
afterAll(() => h.cleanup())

describe('an address with a capital letter', () => {
  test('signs in as typed at registration, and in any other case', async () => {
    await h.auth.createUser({ email: 'Mixed.Case@Example.test', password: 'pw-correct-1' })
    expect(signedIn(await h.auth.login('Mixed.Case@Example.test', 'pw-correct-1')).token).toBeTruthy()
    expect(signedIn(await h.auth.login('MIXED.CASE@EXAMPLE.TEST', 'pw-correct-1')).token).toBeTruthy()
    expect(signedIn(await h.auth.login('mixed.case@example.test', 'pw-correct-1')).token).toBeTruthy()
  })

  test('asking for a reset reaches the person, and the reset signs them in', async () => {
    await h.auth.createUser({ email: 'Reset.Me@Example.test', password: 'pw-correct-1' })
    await h.requestReset('Reset.Me@Example.test')
    await h.auth.confirmPasswordReset!(h.resetToken(), 'pw-new-2')
    expect(signedIn(await h.auth.login('RESET.ME@example.test', 'pw-new-2')).token).toBeTruthy()
  })
})
