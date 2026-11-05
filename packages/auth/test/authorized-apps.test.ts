// test/authorized-apps.test.ts
//
// Living with an authorized app (`FJS-D1950`): it is listed among the person's
// sessions by the host of its client document, revoking it ends its next
// refresh and is written as `app.revoked`, a credential change ends it, and the
// hourly sweep removes it once expired along with any code nobody came back
// for. The access token already minted is not chased: it answers until it
// expires, which `access-token.test.ts` holds.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { connector, refusedWith, CODE_ID, RESOURCE, type Connector } from './connector.ts'
import { totp } from '../totp.ts'

let offset = 0
const clock = { now: () => new Date(Date.now() + offset) }

let c: Connector
beforeAll(async () => { c = await connector(clock) })
afterAll(() => c.h.cleanup())

const settle = () => new Promise((r) => setImmediate(r))
const trailFor = async (sessionId: string) =>
  (await c.h.sys.auditTrail.findMany({ where: { model: 'Session' } }))
    .filter((e: any) => JSON.stringify(e.records).includes(sessionId))

describe('the sessions list', () => {
  test('an authorized app is listed with its client id and host; a browser session with no client', async () => {
    const a   = await c.approve()
    const tok = (await c.exchange(a)).body
    const sid = await c.sessionOf(tok.access_token)
    await c.h.auth.login(a.email, 'pw-token-1')

    const rows = await c.h.auth.listSessions!(a.userId)
    expect(rows).toHaveLength(2)
    const app     = rows.find(r => r.id === sid)!
    const browser = rows.find(r => r.id !== sid)!
    expect(app.client).toEqual({ id: CODE_ID, host: 'claude.ai' })
    expect(browser.client).toBeNull()
    expect(JSON.stringify(rows)).not.toContain(tok.refresh_token)
  })
})

describe('revoking an authorized app', () => {
  test('revokeSession ends its next refresh and writes app.revoked, not session.revoked', async () => {
    const a   = await c.approve()
    const tok = (await c.exchange(a)).body
    const sid = await c.sessionOf(tok.access_token)
    const row = await c.h.sys.session.findFirst({ where: { id: sid } })

    await c.h.auth.revokeSession!(a.userId, sid)
    refusedWith(await c.refresh(tok.refresh_token), 'invalid_grant')

    await settle()
    const entries = await trailFor(sid)
    const ops     = entries.map((e: any) => e.operation)
    expect(ops).toContain('app.revoked')
    expect(ops).not.toContain('session.revoked')
    const revoked = entries.find((e: any) => e.operation === 'app.revoked')
    expect(revoked.actorId).toBe(a.userId)
    expect(revoked.meta.clientId).toBe(CODE_ID)
    // Invariant 7: the refresh columns are @guarded, so no entry carries a
    // token or its hash, and an image that names one redacts it.
    const text = JSON.stringify(entries)
    expect(text).not.toContain(tok.refresh_token)
    expect(text).not.toContain(row.refreshToken)
    for (const e of entries) for (const image of [e.before, e.after])
      if (image && 'refreshToken' in image) expect(image.refreshToken).toBe('[redacted]')
  })

  test('a browser session revoked is still session.revoked, and another person\'s app is not reachable', async () => {
    const a = await c.approve()
    const tok = (await c.exchange(a)).body
    const sid = await c.sessionOf(tok.access_token)
    const b = await c.approve()
    await expect(c.h.auth.revokeSession!(b.userId, sid)).rejects.toThrow()
    expect(await c.h.sys.session.findFirst({ where: { id: sid } })).not.toBeNull()

    await c.h.auth.login(a.email, 'pw-token-1')
    const browserId = (await c.h.auth.listSessions!(a.userId)).find(r => !r.client)!.id
    await c.h.auth.revokeSession!(a.userId, browserId)
    await settle()
    expect((await trailFor(browserId)).map((e: any) => e.operation)).toContain('session.revoked')
  })
})

describe('a credential change', () => {
  test('changePassword writes app.revoked for each app it ends', async () => {
    const a  = await c.approve()
    const t1 = (await c.exchange(a)).body
    const s1 = await c.sessionOf(t1.access_token)
    const again = await c.approve({ email: a.email })
    const t2 = (await c.exchange(again)).body
    const s2 = await c.sessionOf(t2.access_token)

    await c.h.auth.changePassword!(a.userId, 'pw-token-2')
    await settle()
    for (const sid of [s1, s2])
      expect((await trailFor(sid)).filter((e: any) => e.operation === 'app.revoked')).toHaveLength(1)
    refusedWith(await c.refresh(t1.refresh_token), 'invalid_grant')
    refusedWith(await c.refresh(t2.refresh_token), 'invalid_grant')
  })

  test('turning on a second factor ends the authorized app: its next refresh is invalid_grant', async () => {
    const a   = await c.approve()
    const tok = (await c.exchange(a)).body
    const { secret } = await c.h.auth.setupTotp!(a.userId)
    await c.h.auth.confirmTotp!(a.userId, totp(secret, clock.now()))
    refusedWith(await c.refresh(tok.refresh_token), 'invalid_grant')
  })
})

describe('the sweep', () => {
  test('sweepNow removes an expired authorized app and an unspent code, and keeps a live app', async () => {
    const start = offset
    const old   = (await c.exchange(await c.approve())).body
    const oldId = await c.sessionOf(old.access_token)

    offset = start + 31 * 86_400_000
    const live   = (await c.exchange(await c.approve())).body
    const liveId = await c.sessionOf(live.access_token)
    const unspent = await c.approve()
    const codes = async () => (await c.h.sys.credential.findMany({ where: { type: 'authCode' } })).length
    const before = await codes()
    expect(before).toBeGreaterThan(0)

    offset += 60 * 60_000
    await (c.h.auth as any).cleanup.sweepNow()
    const all = await c.h.sys.session.findMany({ where: { clientId: CODE_ID }, withExpired: true })
    expect(all.some((s: any) => String(s.id) === oldId)).toBe(false)
    expect(all.some((s: any) => String(s.id) === liveId)).toBe(true)
    expect(await codes()).toBe(0)
    refusedWith(await c.exchange(unspent), 'invalid_grant')
    offset = start
  })
})

describe('every other way a person\'s sessions end', () => {
  // One authorized app, ended by `end`: its next refresh is refused and the
  // trail names it once, by `app.revoked`, with the actor `end` stated.
  async function endedBy(end: (a: { userId: string, email: string }) => Promise<unknown>, actorOf?: (a: { userId: string }) => string) {
    const a   = await c.approve()
    const tok = (await c.exchange(a)).body
    const sid = await c.sessionOf(tok.access_token)
    await end(a)
    refusedWith(await c.refresh(tok.refresh_token), 'invalid_grant')
    await settle()
    const revoked = (await trailFor(sid)).filter((e: any) => e.operation === 'app.revoked')
    expect(revoked).toHaveLength(1)
    expect(revoked[0].meta.clientId).toBe(CODE_ID)
    expect(revoked[0].actorId).toBe(actorOf ? actorOf(a) : a.userId)
  }

  test('an operator resetting the second factor writes app.revoked as the operator', async () => {
    // An app approved after enrollment: enrollment itself ends the earlier
    // ones, and /authorize then owes a code, so the verb is called directly.
    const operator = (await c.approve()).userId
    const a = await c.approve()
    const { secret } = await c.h.auth.setupTotp!(a.userId)
    await c.h.auth.confirmTotp!(a.userId, totp(secret, clock.now()))
    const tok: any = await (c.h.auth as any).authorizeApp({ userId: a.userId, clientId: CODE_ID, audience: RESOURCE })
    const sid = await c.sessionOf(tok.accessToken)
    await c.h.auth.resetTotp!(a.userId, { actorId: operator })
    refusedWith(await c.refresh(tok.refreshToken), 'invalid_grant')
    await settle()
    const revoked = (await trailFor(sid)).filter((e: any) => e.operation === 'app.revoked')
    expect(revoked).toHaveLength(1)
    expect(revoked[0].actorId).toBe(operator)
  })

  test('a password reset writes app.revoked', async () => {
    await endedBy(async (a) => {
      await c.h.requestReset(a.email)
      await c.h.auth.confirmPasswordReset!(c.h.resetToken(), 'pw-reset-2')
    })
  })

  test('removing the account writes app.revoked, and the entry outlives the row', async () => {
    const operator = (await c.approve()).userId
    await endedBy((a) => c.h.auth.deleteUser!(a.userId, { actorId: operator }), () => operator)
  })
})
