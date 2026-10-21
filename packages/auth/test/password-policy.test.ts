// test/password-policy.test.ts
//
// FJS-2349: every door that writes a password grades it against one minimum.
// Before it, `/auth/register` accepted a one-character password and each app
// restated `password.length < 8` in front of `createUser` by hand.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, rejectsWith, type Harness } from './harness.ts'
import { appWith, json } from './audit-routes-http.ts'
import { WeakPasswordError } from '../errors.ts'

let h: Harness
let app: any
beforeAll(async () => {
  h   = await makeAuth({ password: undefined })
  app = await appWith(h.auth)
})
afterAll(() => h.cleanup())

describe('the default minimum is 8 characters', () => {
  test('createUser refuses a short password and writes no account', async () => {
    await rejectsWith(() => h.auth.createUser({ email: 'short@example.test', password: 'abc1234' }), WeakPasswordError)
    expect(await h.sys.user.findFirst({ where: { email: 'short@example.test' } })).toBeNull()
  })

  test('createUser refuses an empty password rather than making a passwordless account', async () => {
    await rejectsWith(() => h.auth.createUser({ email: 'empty@example.test', password: '' }), WeakPasswordError)
  })

  test('createUser with no password stays an invitation', async () => {
    const made = await h.auth.createUser({ email: 'invited@example.test' })
    expect(made.id).toBeTruthy()
  })

  test('createUser accepts exactly the minimum', async () => {
    const made = await h.auth.createUser({ email: 'exact@example.test', password: 'abcd1234' })
    expect(made.id).toBeTruthy()
  })

  test('POST /auth/register answers 400 for a one-character password', async () => {
    const res = await json(app, 'POST', '/auth/register', { email: 'one@example.test', password: 'x' })
    expect(res.status).toBe(400)
    expect(await h.sys.user.findFirst({ where: { email: 'one@example.test' } })).toBeNull()
  })

  test('changePassword refuses a short new password and keeps the old one', async () => {
    const made = await h.auth.createUser({ email: 'change@example.test', password: 'long-enough-1' })
    await rejectsWith(() => h.auth.changePassword!(made.id, 'long-enough-1', 'short'), WeakPasswordError)
    expect(await h.auth.login('change@example.test', 'long-enough-1')).toBeTruthy()
  })

  test('confirmPasswordReset refuses a short password and leaves the token usable', async () => {
    await h.auth.createUser({ email: 'reset@example.test', password: 'long-enough-1' })
    await h.requestReset('reset@example.test')
    const token = h.resetToken()
    await rejectsWith(() => h.auth.confirmPasswordReset!(token, 'short'), WeakPasswordError)
    await h.auth.confirmPasswordReset!(token, 'long-enough-2')
    expect(await h.auth.login('reset@example.test', 'long-enough-2')).toBeTruthy()
  })
})

describe('password: { min }', () => {
  test('raises the minimum', async () => {
    const strict = await makeAuth({ password: { min: 12 } })
    try {
      await rejectsWith(() => strict.auth.createUser({ email: 'a@example.test', password: 'abcd12345678'.slice(1) }), WeakPasswordError)
      await strict.auth.createUser({ email: 'b@example.test', password: 'abcd12345678' })
    } finally { strict.cleanup() }
  })

  test('lowers it', async () => {
    const lax = await makeAuth({ password: { min: 1 } })
    try { await lax.auth.createUser({ email: 'c@example.test', password: 'x' }) } finally { lax.cleanup() }
  })
})
