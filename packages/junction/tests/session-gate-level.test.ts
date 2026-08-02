// tests/session-gate-level.test.ts
//
// sessionGateLevel() is Junction's mapping of a SessionContext onto Litestone's
// 0–7 access scale. Litestone owns the scale; each caller owns the mapping from
// its own user shape onto it.
//
// It exists because Litestone's default, FrontierGateGetLevel, grades a
// different shape — verifiedAt → activatedAt → role → isAdmin/isOwner — that a
// SessionContext overlaps on `role` alone, and `role` is tested third. A
// session with no verifiedAt therefore graded as VISITOR(1) whatever it
// carried, so @@gate could not authorize a write for a LOGGED-IN user:
//
//   403  "Post.create" requires level 4, user has level 1
//
// returned after Junction's own gateAuth hook had already approved the request.
//
// The load-bearing rule is that absence is not an objection: `undefined` means
// the app does not model that stage, `null` means it does and this user has not
// reached it. Getting that backwards is what made every app look unverified.

import { describe, test, expect } from 'bun:test'
import { sessionGateLevel, LEVELS } from '../src/core/litestone.ts'
import type { SessionContext } from '../src/auth/types.ts'

const session = (over: Partial<SessionContext> = {}): SessionContext => ({
  userId: 'u1', userType: 'user', authMethod: 'session', ...over,
})

describe('the scale matches Litestone\'s', () => {
  test('values are the wire numbers @@gate is written against', () => {
    // A drift here silently re-grades every gated model in every app.
    expect(LEVELS).toMatchObject({
      STRANGER: 0, VISITOR: 1, READER: 2, CREATOR: 3,
      USER: 4, ADMINISTRATOR: 5, OWNER: 6, SYSADMIN: 7,
    })
  })
})

describe('grading', () => {

  test('no session is a STRANGER', () => {
    expect(sessionGateLevel(null)).toBe(LEVELS.STRANGER)
    expect(sessionGateLevel(undefined)).toBe(LEVELS.STRANGER)
  })

  test('a plain authenticated session is a USER', () => {
    // The case that was broken: this is what a session looks like in an app
    // with no verification flow, and it must satisfy @@gate("0.4.4.5") writes.
    expect(sessionGateLevel(session())).toBe(LEVELS.USER)
  })

  test('explicit standing outranks USER', () => {
    expect(sessionGateLevel(session({ isAdmin: true }))).toBe(LEVELS.ADMINISTRATOR)
    expect(sessionGateLevel(session({ isOwner: true }))).toBe(LEVELS.OWNER)
    expect(sessionGateLevel(session({ isSystemAdmin: true }))).toBe(LEVELS.SYSADMIN)
  })

  test('the highest standing wins when several are set', () => {
    expect(sessionGateLevel(session({ isAdmin: true, isOwner: true }))).toBe(LEVELS.OWNER)
    expect(sessionGateLevel(session({ isAdmin: true, isOwner: true, isSystemAdmin: true })))
      .toBe(LEVELS.SYSADMIN)
  })

  test('never returns SYSTEM — that is asSystem() only', () => {
    const everything = session({ isSystemAdmin: true, isOwner: true, isAdmin: true })
    expect(sessionGateLevel(everything)).toBeLessThan(LEVELS.SYSTEM)
  })
})

describe('absence is not an objection', () => {

  test('verifiedAt undefined does not hold a user back', () => {
    // An app with no verification flow is not an app whose users are all
    // unverified. This is the distinction the old behaviour collapsed.
    expect(sessionGateLevel(session({ verifiedAt: undefined }))).toBe(LEVELS.USER)
  })

  test('verifiedAt null is the app saying "not verified"', () => {
    expect(sessionGateLevel(session({ verifiedAt: null }))).toBe(LEVELS.VISITOR)
  })

  test('a verified user passes the verification stage', () => {
    expect(sessionGateLevel(session({ verifiedAt: new Date() }))).toBe(LEVELS.USER)
    // Serialised sessions carry strings, not Dates.
    expect(sessionGateLevel(session({ verifiedAt: '2026-01-01T00:00:00Z' }))).toBe(LEVELS.USER)
  })

  test('activatedAt behaves the same way, one stage later', () => {
    expect(sessionGateLevel(session({ activatedAt: undefined }))).toBe(LEVELS.USER)
    expect(sessionGateLevel(session({ activatedAt: null }))).toBe(LEVELS.READER)
    expect(sessionGateLevel(session({ verifiedAt: new Date(), activatedAt: null })))
      .toBe(LEVELS.READER)
  })

  test('unverified outranks unactivated when both are unmet', () => {
    expect(sessionGateLevel(session({ verifiedAt: null, activatedAt: null })))
      .toBe(LEVELS.VISITOR)
  })

  test('standing beats an unmet lifecycle', () => {
    // An owner who never completed an activation step is still the owner.
    expect(sessionGateLevel(session({ isOwner: true, verifiedAt: null })))
      .toBe(LEVELS.OWNER)
  })
})

describe('role strings are not interpreted', () => {

  test('role alone changes nothing', () => {
    // 'admin' means whatever an app decides it means; matching on the string
    // would hand out level 5 to anyone who happened to use that word.
    expect(sessionGateLevel(session({ role: 'admin' }))).toBe(LEVELS.USER)
    expect(sessionGateLevel(session({ role: 'anything' }))).toBe(LEVELS.USER)
  })

  test('an app grades by role by wrapping the resolver', () => {
    const getLevel = (u: SessionContext | null) =>
      u?.role === 'staff' ? LEVELS.ADMINISTRATOR : sessionGateLevel(u)

    expect(getLevel(session({ role: 'staff' }))).toBe(LEVELS.ADMINISTRATOR)
    expect(getLevel(session({ role: 'member' }))).toBe(LEVELS.USER)
    expect(getLevel(null)).toBe(LEVELS.STRANGER)
  })
})
