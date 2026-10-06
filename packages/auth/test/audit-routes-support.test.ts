// test/audit-routes-support.test.ts
//
// Audit 2026-10-05: POST /auth/support/start and /end over HTTP.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, type Harness, signedIn } from './harness.ts'
import { appWith, json, raw } from './audit-routes-http.ts'

let h: Harness
let app: any
const guardSaw: string[] = []

beforeAll(async () => {
  h = await makeAuth()
  app = await appWith(h.auth, {
    canStartSupport: (operator) => { guardSaw.push(operator.userId); return true },
    services:        { standingLevel: () => 5 },
  })
})
afterAll(() => h.cleanup())

let n = 0
async function person(tag: string) {
  const email = `${tag}-${n++}@example.com`
  const user  = await h.auth.createUser({ email, password: 'pw-correct-1', name: tag })
  const { token } = signedIn(await h.auth.login(email, 'pw-correct-1'))
  return { email, userId: user.userId, token, bearer: { authorization: `Bearer ${token}` } }
}

describe('ttl', () => {
  const clamped = async (ttl: string) => {
    const op = await person('op'), sub = await person('sub')
    const res = await json(app, 'POST', '/auth/support/start', { subjectId: sub.userId, reason: 'r', ttl }, op.bearer)
    expect(res.status).toBe(200)
    const endsAt = new Date(res.body.endsAt).getTime()
    expect(Number.isFinite(endsAt)).toBe(true)
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 30 * 60_000 + 5_000)
  }

  test.each(['garbage', '-5m', '0', 'NaN', '1e9', '   '])('ttl %j answers 200 and an endsAt within the cap', clamped)

  // FJS-1852: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('ttl "99999999999999999999" answers 200 and an endsAt within the cap', () => clamped('99999999999999999999'))
})

describe('from inside an episode', () => {
  // FJS-1851: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('canStartSupport is handed the OPERATOR, not the subject the session currently resolves to', async () => {
    const op = await person('op'), sub = await person('sub'), other = await person('other')
    expect((await json(app, 'POST', '/auth/support/start', { subjectId: sub.userId, reason: 'r' }, op.bearer)).status).toBe(200)

    guardSaw.length = 0
    const res = await json(app, 'POST', '/auth/support/start', { subjectId: other.userId, reason: 'r2' }, op.bearer)
    expect(res.status).not.toBe(200)
    // Secure: the guard, if consulted at all, grades the operator.
    if (guardSaw.length) expect(guardSaw[0]).toBe(op.userId)
  })

  // FJS-1851: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a chained start is refused as the caller\'s mistake, not a 500', async () => {
    const op = await person('op'), sub = await person('sub'), other = await person('other')
    expect((await json(app, 'POST', '/auth/support/start', { subjectId: sub.userId, reason: 'r' }, op.bearer)).status).toBe(200)
    const res = await json(app, 'POST', '/auth/support/start', { subjectId: other.userId, reason: 'r2' }, op.bearer)
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    // And nothing changed: the session still resolves to the first subject.
    const me = await raw(app, 'GET', '/account/me', { headers: op.bearer })
    expect(me.body.userId).toBe(sub.userId)
  })

  // FJS-1851: asserts the fixed behavior, so it fails until the fix lands; drop .failing then.
  test.failing('a chained start for a user that does not exist does not answer 404 before the chaining refusal', async () => {
    const op = await person('op'), sub = await person('sub')
    expect((await json(app, 'POST', '/auth/support/start', { subjectId: sub.userId, reason: 'r' }, op.bearer)).status).toBe(200)
    const res = await json(app, 'POST', '/auth/support/start', { subjectId: 'no-such-user', reason: 'r2' }, op.bearer)
    expect(res.status).not.toBe(404)
  })
})
