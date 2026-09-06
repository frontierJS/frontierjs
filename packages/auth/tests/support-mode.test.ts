// tests/support-mode.test.ts
//
// Support mode: an operator acts as somebody else, bounded at that person's own
// standing and recorded against the operator's name.
//
// Every refusal here is PAIRED with the same call made outside an episode. A
// guard that refused everybody would satisfy any test that only asked about the
// refusal, and would look identical from the refused side (`FJS-351`).
//
// The three that are not negotiable — the ones this feature IS — are the
// credential paths, the expiry read at resolution, and the operator surviving
// on the principal. Everything else here is shape.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { makeAuth, rejectsWith, type Harness } from './harness.ts'
import { AuthConfigError, UserNotFoundError, InvalidTokenError } from '../errors.ts'

let h: Harness
beforeAll(async () => { h = await makeAuth() })
afterAll(() => h.cleanup())

let n = 0
async function person(tag: string) {
  const email = `${tag}-${n++}@example.com`
  const user  = await h.auth.createUser({ email, password: 'pw-correct-1', name: tag })
  const { token } = await h.auth.login(email, 'pw-correct-1')
  return { email, userId: user.userId, token }
}

describe('an episode resolves to the subject and remembers the operator', () => {

  test('the principal is the subject, with the operator on `support`', async () => {
    const operator = await person('op')
    const subject  = await person('sub')

    // Before: the token is the operator's own and answers as them.
    const before = await h.auth.verifySession(operator.token)
    expect(before?.userId).toBe(operator.userId)
    expect(before?.support).toBeUndefined()

    await h.auth.startSupport!(operator.token, subject.userId, 'ticket-4192')

    const during = await h.auth.verifySession(operator.token)
    // The half that bounds it: every layer above grades THIS principal.
    expect(during?.userId).toBe(subject.userId)
    expect(during?.email).toBe(subject.email)
    // The half that makes it evidence: the operator is still here.
    expect(during?.support?.operatorId).toBe(operator.userId)
    expect(during?.support?.reason).toBe('ticket-4192')
    // The episode is this session's excursion, so its id is the session's.
    expect(during?.support?.episodeId).toBe(during?.sessionId)
  })

  test('ending it gives the operator their own account back', async () => {
    const operator = await person('op')
    const subject  = await person('sub')

    await h.auth.startSupport!(operator.token, subject.userId, 'ticket-1')
    expect((await h.auth.verifySession(operator.token))?.userId).toBe(subject.userId)

    const { ended } = await h.auth.endSupport!(operator.token)
    expect(ended).toBe(true)

    const after = await h.auth.verifySession(operator.token)
    expect(after?.userId).toBe(operator.userId)
    expect(after?.support).toBeUndefined()
  })

  test('ending one that is not running is a no-op, not an error', async () => {
    // What a reconnecting tab sends.
    const operator = await person('op')
    expect(await h.auth.endSupport!(operator.token)).toEqual({ ended: false })
  })
})

describe('the ceiling is read at resolution, not swept', () => {

  test('an expired episode stops applying with nothing having run', async () => {
    const operator = await person('op')
    const subject  = await person('sub')

    await h.auth.startSupport!(operator.token, subject.userId, 'ticket-2', '1 second')
    expect((await h.auth.verifySession(operator.token))?.userId).toBe(subject.userId)

    // Move the column into the past by hand, which is what the clock does. No
    // job runs, nothing is cleaned up: the next resolution is simply the
    // operator's own. A cron makes an episode end eventually; this makes it end.
    const row = await h.sys.session.findFirst({ where: { token: operator.token } })
    await h.sys.session.update({
      where: { id: row.id },
      data:  { impersonationEndsAt: new Date(Date.now() - 1000).toISOString() },
    })

    const after = await h.auth.verifySession(operator.token)
    expect(after?.userId).toBe(operator.userId)
    expect(after?.support).toBeUndefined()
  })

  test('a ttl longer than the cap is capped', async () => {
    const operator = await person('op')
    const subject  = await person('sub')
    // The harness takes the default cap of 30 minutes.
    const { endsAt } = await h.auth.startSupport!(operator.token, subject.userId, 'ticket-3', '30 days')
    expect(new Date(endsAt).getTime() - Date.now()).toBeLessThan(31 * 60 * 1000)
  })

  test('a subject who no longer exists leaves the operator as themselves', async () => {
    // Not null. Answering null would sign an operator out of their OWN account
    // because somebody else was deleted.
    const operator = await person('op')
    const subject  = await person('sub')
    await h.auth.startSupport!(operator.token, subject.userId, 'ticket-5')
    await h.auth.deleteUser(subject.userId)

    const after = await h.auth.verifySession(operator.token)
    expect(after?.userId).toBe(operator.userId)
  })
})

describe('what the provider refuses whatever the app allows', () => {

  test('no reason', async () => {
    const operator = await person('op')
    const subject  = await person('sub')
    await rejectsWith(() => h.auth.startSupport!(operator.token, subject.userId, '   '), AuthConfigError)
    // Paired: the identical call with a reason is accepted.
    expect(await h.auth.startSupport!(operator.token, subject.userId, 'ticket-6')).toHaveProperty('endsAt')
  })

  test('yourself', async () => {
    const operator = await person('op')
    await rejectsWith(() => h.auth.startSupport!(operator.token, operator.userId, 'ticket-7'), AuthConfigError)
  })

  test('an episode that has LAPSED does not block the next one', async () => {
    // The column stays set until something clears it, and the resolution path
    // reads the clock — so reading the column alone here made a lapse
    // permanent: the operator resolves as themselves again, correctly, and
    // every start after that is refused for an episode nobody is in, with no
    // way out a person could find. Found by `example`: `verify:support`.
    const operator = await person('op')
    const a = await person('sub-a')
    const b = await person('sub-b')

    await h.auth.startSupport!(operator.token, a.userId, 'ticket-lapse')
    const row = await h.sys.session.findFirst({ where: { token: operator.token } })
    await h.sys.session.update({
      where: { id: row.id },
      data:  { impersonationEndsAt: new Date(Date.now() - 1000).toISOString() },
    })

    expect(await h.auth.startSupport!(operator.token, b.userId, 'ticket-next')).toHaveProperty('endsAt')
    expect((await h.auth.verifySession(operator.token))?.userId).toBe(b.userId)
  })

  test('an episode inside an episode', async () => {
    // Chaining would record the SUBJECT as the operator of the next one — the
    // trail would name a person who did nothing.
    const operator = await person('op')
    const a = await person('sub-a')
    const b = await person('sub-b')
    await h.auth.startSupport!(operator.token, a.userId, 'ticket-8')
    await rejectsWith(() => h.auth.startSupport!(operator.token, b.userId, 'ticket-9'), AuthConfigError)
  })

  test('a subject who does not exist', async () => {
    const operator = await person('op')
    await rejectsWith(() => h.auth.startSupport!(operator.token, 'no-such-user', 'ticket-10'), UserNotFoundError)
  })

  test('a token with no live session', async () => {
    const subject = await person('sub')
    await rejectsWith(() => h.auth.startSupport!('not-a-token', subject.userId, 'ticket-11'), InvalidTokenError)
  })
})

describe('the trail names the operator', () => {

  test('starting and ending are recorded against the operator, not the subject', async () => {
    const operator = await person('op')
    const subject  = await person('sub')

    await h.auth.startSupport!(operator.token, subject.userId, 'ticket-12')
    await h.auth.endSupport!(operator.token)
    await new Promise((r) => setImmediate(r))

    const rows = await h.sys.auditLogs.findMany({ where: { actorId: operator.userId } })
    const ops  = rows.map((r: any) => r.operation)
    expect(ops).toContain('support.started')
    expect(ops).toContain('support.ended')

    const started = rows.find((r: any) => r.operation === 'support.started')
    const meta    = typeof started.meta === 'string' ? JSON.parse(started.meta) : started.meta
    expect(meta.subjectId).toBe(subject.userId)
    expect(meta.reason).toBe('ticket-12')

    // Paired with the inverse, which is the whole complaint `FJS-142` files:
    // nothing about this episode is filed under the person it was done to.
    const underSubject = await h.sys.auditLogs.findMany({ where: { actorId: subject.userId } })
    expect(underSubject.map((r: any) => r.operation)).not.toContain('support.started')
  })
})
