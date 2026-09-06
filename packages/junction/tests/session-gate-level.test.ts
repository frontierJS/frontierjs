// tests/session-gate-level.test.ts
//
// sessionGateLevel() is Junction's mapping of a SessionContext onto Litestone's
// 0–7 access scale. Litestone owns the scale; each caller owns the mapping from
// its own user shape onto it.
//
// It is `@frontierjs/toolbelt/gate`'s `gradeStanding` under Junction's name, and
// Litestone's `FrontierGateGetLevel` is the same binding. It was a hand copy on
// both sides of a boundary Litestone cannot cross, and it drifted: 8 of the 216
// combinations of the fields a session carries graded CREATOR(3) there and
// USER(4) here (`FJS-520`, ruled `FJS-D197`).
//
// The load-bearing rule is that absence is not an objection: `undefined` means
// the app does not model that stage, `null` means it does and this user has not
// reached it. Getting that backwards is what made every app look unverified.
//
// `role` is the exception and is read for PRESENCE, which is the branch that
// drifted. The kit's own spec walks the whole 216; what is asserted here is
// that Junction's export is that function and grades a Junction session.

import { describe, test, expect } from 'bun:test'
import { sessionGateLevel, LEVELS } from '../src/core/litestone.ts'
import { gradeStanding, LEVELS as KIT_LEVELS } from '@frontierjs/toolbelt/gate'
import type { SessionContext } from '../src/auth/types.ts'

// `role` is on the fixture because a real SessionContext carries one:
// `@frontierjs/auth`'s User ships `role String @default("user")` and the session
// builder copies it. Omitting it here made every test in this file also a test
// of the role branch by accident, which is the branch the two graders drifted
// on — see `the role branch` below, where it is asked deliberately.
const session = (over: Partial<SessionContext> = {}): SessionContext => ({
  userId: 'u1', userType: 'user', authMethod: 'session', role: 'user', ...over,
})

describe('the scale matches Litestone\'s', () => {
  test('values are the wire numbers @@gate is written against', () => {
    // A drift here silently re-grades every gated model in every app. It cannot
    // drift now — this is the kit's own object, not a mirror of it — and the
    // literals stay because they are the wire values the @@gate grammar fixes,
    // so a change to the KIT has to fail here too.
    expect(LEVELS).toMatchObject({
      STRANGER: 0, VISITOR: 1, READER: 2, CREATOR: 3,
      USER: 4, ADMINISTRATOR: 5, OWNER: 6, SYSADMIN: 7,
    })
  })

  test('it is the kit\'s ladder and not a copy of it', () => {
    expect(LEVELS).toBe(KIT_LEVELS)
    expect(sessionGateLevel).toBe(gradeStanding)
  })
})

describe('the role branch', () => {
  // The pair that could not be asked while the two graders were separate: the
  // old test named *agrees with junction sessionGateLevel* lived in litestone,
  // imported only litestone, and used a fixture carrying `role`.
  test('a session with no role is a CREATOR, and one with a role is a USER', () => {
    const { role, ...noRole } = session()
    expect(sessionGateLevel(noRole as SessionContext)).toBe(LEVELS.CREATOR)
    expect(sessionGateLevel(session())).toBe(LEVELS.USER)
  })

  test('standing still outranks it', () => {
    const { role, ...noRole } = session()
    expect(sessionGateLevel({ ...noRole, isAdmin: true } as SessionContext)).toBe(LEVELS.ADMINISTRATOR)
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
    // unverified. This is the distinction the old behavior collapsed.
    expect(sessionGateLevel(session({ verifiedAt: undefined }))).toBe(LEVELS.USER)
  })

  test('verifiedAt null is the app saying "not verified"', () => {
    expect(sessionGateLevel(session({ verifiedAt: null }))).toBe(LEVELS.VISITOR)
  })

  test('a verified user passes the verification stage', () => {
    expect(sessionGateLevel(session({ verifiedAt: new Date() }))).toBe(LEVELS.USER)
    // Serialized sessions carry strings, not Dates.
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
