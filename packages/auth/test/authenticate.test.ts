// test/authenticate.test.ts
//
// `authenticate` / `completeAuthenticate` (`FJS-D1948`): `login` and
// `completeLogin` with the proof ending. Every row asks the one thing that
// separates them from a sign-in -- no `Session` row and no `login.succeeded` --
// beside the thing they must share with it, which is every refusal.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, rejectsWith, TEST_KEY, type Harness } from './harness.ts'
import { totp, TOTP_STEP_SEC } from '../totp.ts'
import { hashPassword } from '../crypto.ts'
import {
  InvalidCredentialsError, InvalidSecondFactorError, SecondFactorEnrollmentOwedError,
} from '../errors.ts'

const PASSWORD = 'correct-horse-1'

let h: Harness
let seq = 0
const nextEmail = () => `proof-${Date.now()}-${seq++}@example.com`

const settle = () => new Promise(r => setImmediate(r))

/** The audit rows `run` wrote, refusal or not. */
async function trail(env: Harness, run: () => Promise<unknown>): Promise<any[]> {
  await settle()
  const before = (await env.sys.auditTrail.findMany({})).length
  try { await run() } catch { /* a refusal is the case under test */ }
  await settle()
  return (await env.sys.auditTrail.findMany({})).slice(before)
}

const ops = (rows: any[]) => rows.map(r => r.operation)

async function makeUser(env: Harness = h) {
  const email = nextEmail()
  const user  = await env.auth.createUser({ email, password: PASSWORD })
  return { email, userId: String(user.id) }
}

async function makeUserWithTotp(env: Harness = h) {
  const u = await makeUser(env)
  const { secret } = await env.auth.setupTotp!(u.userId)
  const { recoveryCodes } = await env.auth.confirmTotp!(u.userId, totp(secret, new Date()))
  return { ...u, secret, recoveryCodes }
}

const codeAt = (secret: string, offsetSteps: number) =>
  totp(secret, new Date(Date.now() + offsetSteps * TOTP_STEP_SEC * 1000))

const sessions = (env: Harness, userId: string) =>
  env.sys.session.count({ where: { userId } })

beforeAll(async () => { h = await makeAuth({ encryptionKey: TEST_KEY }) })
afterAll(() => h.cleanup())

describe('the password proof', () => {
  test('answers the id, mints no session, and writes login.proven rather than login.succeeded', async () => {
    const u = await makeUser()
    let result: any
    const rows = await trail(h, async () => { result = await h.auth.authenticate!(u.email, PASSWORD) })

    expect(result).toEqual({ userId: u.userId })
    expect(await sessions(h, u.userId)).toBe(0)
    expect(ops(rows)).not.toContain('login.succeeded')
    expect(ops(rows)).not.toContain('create')
    const proven = rows.find(r => r.operation === 'login.proven')
    expect(proven?.actorId).toBe(u.userId)
  })

  test('runs no onLogin', async () => {
    let calls = 0
    const env = await makeAuth({ encryptionKey: TEST_KEY, onLogin: async () => { calls++ } })
    const u = await makeUser(env)
    await env.auth.authenticate!(u.email, PASSWORD)
    expect(calls).toBe(0)
    await env.auth.login(u.email, PASSWORD)
    expect(calls).toBe(1)
    env.cleanup()
  })

  test('a wrong password pays the cost and is recorded with the reason login records', async () => {
    const u = await makeUser()
    const viaLogin = await trail(h, () => h.auth.login(u.email, 'wrong'))
    const started  = performance.now()
    const viaProof = await trail(h, async () => {
      await rejectsWith(() => h.auth.authenticate!(u.email, 'wrong'), InvalidCredentialsError)
    })
    // bcrypt at the shipped cost is ~200ms; a refusal that skipped it is ~1ms.
    expect(performance.now() - started).toBeGreaterThan(50)

    const a = viaLogin.find(r => r.operation === 'login.failed')
    const b = viaProof.find(r => r.operation === 'login.failed')
    expect(b?.meta).toEqual(a?.meta)
    expect(b?.meta.reason).toBe('bad-password')
  })

  test('an unknown address is refused as login refuses it', async () => {
    const email = nextEmail()
    const rows = await trail(h, async () => {
      await rejectsWith(() => h.auth.authenticate!(email, PASSWORD), InvalidCredentialsError)
    })
    expect(rows.find(r => r.operation === 'login.failed')?.meta).toEqual({ reason: 'no-such-user', email })
  })
})

describe('the second factor', () => {
  test('owes a ticket, and the code answers the id with still no session', async () => {
    const u = await makeUserWithTotp()
    const first: any = await h.auth.authenticate!(u.email, PASSWORD)
    expect(typeof first.challenge).toBe('string')
    expect(typeof first.expiresAt).toBe('string')

    let done: any
    const rows = await trail(h, async () => { done = await h.auth.completeAuthenticate!(first.challenge, codeAt(u.secret, 1)) })
    expect(done).toEqual({ userId: u.userId })
    expect(await sessions(h, u.userId)).toBe(0)
    expect(ops(rows)).toContain('login.proven')
    expect(ops(rows)).not.toContain('login.succeeded')
  })

  test('a wrong code is refused as completeLogin refuses it, and the miss is counted', async () => {
    const u = await makeUserWithTotp()
    const { challenge }: any = await h.auth.authenticate!(u.email, PASSWORD)

    let err: InvalidSecondFactorError | undefined
    const rows = await trail(h, async () => {
      err = await rejectsWith(() => h.auth.completeAuthenticate!(challenge, '000000'), InvalidSecondFactorError)
    })
    expect(err!.retryable).toBe(true)
    expect(rows.find(r => r.operation === 'login.failed')?.meta).toEqual({ reason: 'bad-code', stage: 'second-factor' })
    const row = await h.sys.loginChallenge.findFirst({ where: { value: challenge } })
    expect(row.attempts).toBe(1)

    // The ticket survives a miss, so the right code still answers.
    expect(await h.auth.completeAuthenticate!(challenge, codeAt(u.secret, 1))).toEqual({ userId: u.userId })
  })

  test('a recovery code answers the id and is spent', async () => {
    const u = await makeUserWithTotp()
    const { challenge }: any = await h.auth.authenticate!(u.email, PASSWORD)
    expect(await h.auth.completeAuthenticate!(challenge, u.recoveryCodes[0])).toEqual({ userId: u.userId })
    expect((await h.auth.totpStatus!(u.userId)).recoveryCodesRemaining).toBe(9)
    expect(await sessions(h, u.userId)).toBe(0)
  })

  test('a step already spent is refused as a replay', async () => {
    const u = await makeUserWithTotp()
    const code = codeAt(u.secret, 1)
    const one: any = await h.auth.authenticate!(u.email, PASSWORD)
    await h.auth.completeAuthenticate!(one.challenge, code)

    const two: any = await h.auth.authenticate!(u.email, PASSWORD)
    const rows = await trail(h, async () => {
      await rejectsWith(() => h.auth.completeAuthenticate!(two.challenge, code), InvalidSecondFactorError)
    })
    expect(rows.find(r => r.operation === 'login.failed')?.meta.reason).toBe('code-replayed')
  })
})

describe('who cannot prove', () => {
  test('an account owing enrollment is refused 403 and pointed at the web app', async () => {
    const env = await makeAuth({ encryptionKey: TEST_KEY, requireSecondFactor: true })
    const u = await makeUser(env)
    const err = await rejectsWith(() => env.auth.authenticate!(u.email, PASSWORD), SecondFactorEnrollmentOwedError)
    expect(err.status).toBe(403)
    expect(err.message).toMatch(/web app/)
    expect(await sessions(env, u.userId)).toBe(0)
    env.cleanup()
  })

  test('the enrollment refusal is in the trail, and no lockout hook counts a right password', async () => {
    const failed: unknown[] = []
    const env  = await makeAuth({ encryptionKey: TEST_KEY, requireSecondFactor: true, onLoginFailed: async e => { failed.push(e) } })
    const u    = await makeUser(env)
    const rows = await trail(env, () => env.auth.authenticate!(u.email, PASSWORD))
    const row  = rows.find(r => r.operation === 'login.failed')
    expect(row?.meta).toMatchObject({ reason: 'enrollment-owed' })
    expect(row?.actorId).toBe(u.userId)
    expect(ops(rows)).not.toContain('login.proven')
    expect(failed).toEqual([])
    env.cleanup()
  })

  test('a bot is refused as a sign-in refuses it', async () => {
    const email = nextEmail()
    const bot = await h.sys.user.create({ data: { email, kind: 'bot' } })
    await h.sys.credential.create({ data: { userId: bot.id, type: 'password', value: await hashPassword(PASSWORD) } })

    const rows = await trail(h, async () => {
      await rejectsWith(() => h.auth.authenticate!(email, PASSWORD), InvalidCredentialsError)
    })
    expect(rows.find(r => r.operation === 'login.failed')?.meta).toMatchObject({ reason: 'not-a-person', kind: 'bot' })
    expect(ops(rows)).not.toContain('login.proven')
  })
})
