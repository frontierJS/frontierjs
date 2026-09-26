// test/expiry.test.ts
//
// What a DECLARED deadline buys this package, and none of it could be written
// before the declaration existed.
//
// `Session`, `Verification`, `LoginChallenge` and `OauthFlow` each carry
// `@@expires(expiresAt)`, so the window is enforced at the Data boundary
// and the seven `expiresAt: { gt: new Date() }` clauses that used to enforce it
// are gone. Two things follow, and they are what this file grades.
//
// FIRST, and it is the reason the hand-written version was untestable: the
// filter reads the CLIENT's clock. A `new Date()` inside this module read the
// host's, so staging a lapsed session meant either waiting thirty days or
// writing a row with a past `expiresAt` — which tests the FIXTURE and not the
// lapse. Here the clock moves and nothing else does: no write, no sweep, no
// round trip. That is the shape a person's session actually takes.
//
// SECOND, the window filters WRITES too (`FJS-D351`), which is a trap as much
// as a feature: a delete keyed on a row that has already lapsed matches nothing
// and answers a count, silently. Every purge in auth.ts says `withExpired`
// through the `PURGE` const, and the rows below are what would catch its
// removal — `revokeSession` on a lapsed row, and the sweep itself.

import { describe, test, expect, afterAll } from 'bun:test'
import { createAuthCleanupJobs } from '../cleanup.ts'
import { makeAuth, signedIn, type Harness } from './harness.ts'

const harnesses: Harness[] = []
afterAll(() => harnesses.forEach(h => h.cleanup()))

const DAY = 24 * 60 * 60 * 1000

/**
 * A harness whose clock this test owns.
 *
 * It starts YEARS from the host's clock, and that is the assertion on the
 * write side: every deadline auth mints comes off `sys.$now()`, so a helper
 * that went back to `Date.now()` would write deadlines years before this clock
 * and every sign-in below would be born lapsed.
 */
async function staged() {
  let at = Date.parse('2031-05-05T09:00:00.000Z')
  const h = await makeAuth({}, { now: () => new Date(at) })
  harnesses.push(h)
  return { ...h, at: () => at, advance: (ms: number) => { at += ms } }
}

const PASSWORD = 'correct horse battery'

const signIn = async (auth: Harness['auth'], email: string) => {
  await auth.createUser({ email, password: PASSWORD, name: 'Person' })
  return signedIn(await auth.login(email, PASSWORD))
}

describe('a session lapses on the clock, with nothing written', () => {

  test('the same token answers, then does not, and the row is untouched either way', async () => {
    const { auth, sys, advance } = await staged()
    const { token } = await signIn(auth, 'lapse@example.com')

    expect((await auth.verifySession(token))?.email).toBe('lapse@example.com')

    // The default TTL is 30 days. Nothing here writes, sweeps or reconnects.
    advance(31 * DAY)
    expect(await auth.verifySession(token)).toBeNull()

    // The ROW is still there — this is a read filter and not a deletion, which
    // is what makes the sweep a separate concern rather than a correctness one.
    const still = await sys.session.findFirst({ where: { token }, withExpired: true })
    expect(still).not.toBeNull()
  })

  test('listSessions stops listing it, without a filter of its own', async () => {
    const { auth, advance } = await staged()
    const { user } = await signIn(auth, 'list@example.com')

    expect((await auth.listSessions!(user.userId)).length).toBe(1)
    advance(31 * DAY)
    expect((await auth.listSessions!(user.userId)).length).toBe(0)
  })
})

describe('the window filters writes, so a purge has to say so', () => {

  test('revokeSession removes a session that has already lapsed', async () => {
    const { auth, sys, advance } = await staged()
    const { token, user } = await signIn(auth, 'revoke@example.com')
    const row = await sys.session.findFirst({ where: { token } })

    // A person opens the sessions screen, goes to lunch, and clicks Revoke. The
    // row lapsed in between. Without `withExpired` on that delete the count is
    // 0 and they are told `No session with id …`, which is both wrong and
    // unactionable — and nothing else in the suite would have noticed.
    advance(31 * DAY)
    await auth.revokeSession!(user.userId, String(row.id))

    expect(await sys.session.findFirst({ where: { id: row.id }, withExpired: true })).toBeNull()
  })

  test('the sweep takes the lapsed rows and leaves the live ones', async () => {
    const { db, auth, sys, at } = await staged()
    const { user } = await signIn(auth, 'sweep@example.com')

    // Both rows written here rather than signed in for, because the edge is
    // what is under test: one either side of the staged instant.
    const hour = 60 * 60 * 1000
    await sys.session.create({
      data: { userId: user.userId, token: 'LAPSED', expiresAt: new Date(at() - hour) },
    })
    await sys.session.create({
      data: { userId: user.userId, token: 'LIVE', expiresAt: new Date(at() + hour) },
    })

    // The SHIPPED predicate, which is now `onlyExpired` rather than a
    // hand-written comparison. A sweep that lost the word would take every row
    // here; one that kept a `{ lt: now }` where would take none, because the
    // window is ANDed onto a delete too.
    await createAuthCleanupJobs(db).sweepNow()

    // Named rather than counted: the sign-in above left a live session of its
    // own, and a count would pass against a sweep that took the wrong one.
    const left = (await sys.session.findMany({ withExpired: true })).map((r: any) => r.token)
    expect(left).toContain('LIVE')
    expect(left).not.toContain('LAPSED')
  })
})

describe('the one read that wants the lapsed row', () => {

  test('a ticket that ran out is told apart from one that never existed', async () => {
    const { auth, sys, at, advance } = await staged()
    await auth.createUser({ email: 'totp@example.com', password: PASSWORD, name: 'P' })

    // A challenge stands in for the real second-factor flow, which needs an
    // enrolled credential; what is under test is the READ in completeLogin, and
    // it is reached the same way either way.
    const user = await sys.user.findFirst({ where: { email: 'totp@example.com' } })
    await sys.loginChallenge.create({
      data: { userId: user.id, value: 'TICKET', expiresAt: new Date(at() + 5 * 60 * 1000) },
    })

    advance(10 * 60 * 1000)

    // Both refuse, and that is the point: the DIFFERENCE is in the audit trail
    // and in `retryable`. A plain filtered read collapses the two into
    // `no-such-challenge`, and a person whose code arrived a minute late is
    // told the ticket never existed.
    await expect(auth.completeLogin!('TICKET',  '000000')).rejects.toThrow()
    await expect(auth.completeLogin!('NOTHING', '000000')).rejects.toThrow()

    const trail = await sys.auditLogs.findMany({})
    const reasons = trail
      .filter((r: any) => r.operation === 'login.failed')
      .map((r: any) => (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta)?.reason)
    expect(reasons).toContain('challenge-expired')
    expect(reasons).toContain('no-such-challenge')
  })
})
