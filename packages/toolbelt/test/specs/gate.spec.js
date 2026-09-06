/*
 * gate.spec.js
 *
 * The ladder was a hand copy at four places and it drifted. What follows is
 * written against the shape of that drift rather than against the functions:
 * the disagreements were 8 cases in 216 and 212 in 216, and neither was
 * reachable from a test that asked one grader about one caller.
 *
 * So the grader is graded over the whole product of the fields it reads, and
 * `levelPasses` over the whole 0–9 × 0–9 square. An exhaustive test of a pure
 * function of two small domains costs nothing to run and is the only shape that
 * could have caught either one.
 */

import { LEVELS, LEVEL_NAMES, levelName, levelPasses, gradeStanding }
  from '../../src/gate/gate.js'

// ─── the scale ────────────────────────────────────────────────────────────────

test('gate: the scale is 0-9 and the names are derived from it', function () {
  assert.equal(LEVELS.STRANGER, 0)
  assert.equal(LEVELS.USER, 4)
  assert.equal(LEVELS.SYSTEM, 8)
  assert.equal(LEVELS.LOCKED, 9)

  // Derived, never restated: a rung cannot exist as a digit and not as a name.
  assert.deepEqual(Object.keys(LEVEL_NAMES).sort(), Object.keys(LEVELS).sort())
  for (const [name, n] of Object.entries(LEVELS)) assert.equal(LEVEL_NAMES[name], n)

  assert.equal(levelName(5), 'ADMINISTRATOR')
  assert.equal(levelName(42), '42')
})

// ─── the comparison ───────────────────────────────────────────────────────────

test('gate: levelPasses over the whole square, 8 and 9 as sentinels', function () {
  for (let required = 0; required <= 9; required++) {
    for (let level = 0; level <= 9; level++) {
      const got = levelPasses(required, level)

      // The expectation is spelled out here rather than computed from the
      // function under test — an oracle that shares the implementation's
      // reasoning cannot fail when the reasoning is what is wrong.
      const want =
        required === 9 ? false :
        required === 8 ? level === 8 :
        level >= required

      assert.equal(got, want, `levelPasses(${required}, ${level})`)
    }
  }
})

test('gate: the two sentinels are what a hand-spelled >= gets wrong', function () {
  // Every one of these is TRUE under `level >= required`, which is what three
  // of the four copies spelled.
  assert.equal(levelPasses(9, 9), false)   // LOCKED refuses even itself
  assert.equal(levelPasses(9, 8), false)   // and asSystem()
  assert.equal(levelPasses(8, 9), false)   // 9 is not "more than" 8, it is elsewhere

  // And the one it gets wrong in the other direction.
  assert.equal(levelPasses(8, 7), false)   // SYSADMIN is a human; SYSTEM is not
  assert.equal(levelPasses(8, 8), true)
})

// ─── the grader ───────────────────────────────────────────────────────────────

test('gate: no session is a stranger', function () {
  assert.equal(gradeStanding(null), LEVELS.STRANGER)
  assert.equal(gradeStanding(undefined), LEVELS.STRANGER)
})

test('gate: standing outranks the lifecycle', function () {
  // An owner who never completed an activation step is still the owner. The
  // role check running first is what made this grade CREATOR once.
  assert.equal(gradeStanding({ isOwner: true, verifiedAt: null }), LEVELS.OWNER)
  assert.equal(gradeStanding({ isSystemAdmin: true, activatedAt: null }), LEVELS.SYSADMIN)
  assert.equal(gradeStanding({ isAdmin: true, role: undefined }), LEVELS.ADMINISTRATOR)

  // And the order among the three.
  assert.equal(gradeStanding({ isSystemAdmin: true, isOwner: true, isAdmin: true }), LEVELS.SYSADMIN)
  assert.equal(gradeStanding({ isOwner: true, isAdmin: true }), LEVELS.OWNER)
})

test('gate: absent is not null, and only null grades down', function () {
  // The pair is the test. An app with no verifiedAt column must not have every
  // one of its callers graded VISITOR, and an app that has the column must have
  // the caller who has not reached it graded exactly that.
  assert.equal(gradeStanding({ role: 'user' }), LEVELS.USER)
  assert.equal(gradeStanding({ role: 'user', verifiedAt: undefined }), LEVELS.USER)
  assert.equal(gradeStanding({ role: 'user', verifiedAt: null }), LEVELS.VISITOR)

  assert.equal(gradeStanding({ role: 'user', activatedAt: null }), LEVELS.READER)
  assert.equal(gradeStanding({ role: 'user', verifiedAt: 'x', activatedAt: null }), LEVELS.READER)

  // verifiedAt is asked first: a caller who has reached neither is a VISITOR.
  assert.equal(gradeStanding({ verifiedAt: null, activatedAt: null }), LEVELS.VISITOR)
})

test('gate: role is read for PRESENCE and no role is CREATOR', function () {
  // This is the branch the two copies disagreed on — 8 of 216 combinations,
  // every one of them this shape (`FJS-520`, ruled `FJS-D197`).
  assert.equal(gradeStanding({}), LEVELS.CREATOR)
  assert.equal(gradeStanding({ role: 'user' }), LEVELS.USER)

  // The ladder cannot rank what is IN the column, only whether the app gave the
  // caller one — so every non-empty value is the same answer, including the
  // ones that read like standing.
  assert.equal(gradeStanding({ role: 'admin' }), LEVELS.USER)
  assert.equal(gradeStanding({ role: 'guest' }), LEVELS.USER)

  // Empty, null and absent are one answer here, unlike the lifecycle fields.
  assert.equal(gradeStanding({ role: '' }), LEVELS.CREATOR)
  assert.equal(gradeStanding({ role: null }), LEVELS.CREATOR)
})

test('gate: the grid the three copies disagreed over', function () {
  // Every combination of the six fields, which is what makes this able to fail:
  // the drift was one branch, and asking about one caller at a time is what
  // hid it for a month. The old tripwire was named *agrees with junction* and
  // used a fixture carrying `role` — the field whose absence IS the drift.
  const vals = {
    verifiedAt:    [undefined, null, 'd'],
    activatedAt:   [undefined, null, 'd'],
    isAdmin:       [undefined, true],
    isOwner:       [undefined, true],
    isSystemAdmin: [undefined, true],
    role:          [undefined, null, 'user'],
  }
  const keys = Object.keys(vals)
  const rows = []
  const walk = (i, acc) => {
    if (i === keys.length) { rows.push(acc); return }
    for (const v of vals[keys[i]]) walk(i + 1, v === undefined ? acc : { ...acc, [keys[i]]: v })
  }
  walk(0, {})

  assert.equal(rows.length, 216)

  for (const u of rows) {
    const got = gradeStanding(u)
    const want =
      u.isSystemAdmin      ? LEVELS.SYSADMIN :
      u.isOwner            ? LEVELS.OWNER :
      u.isAdmin            ? LEVELS.ADMINISTRATOR :
      u.verifiedAt === null  ? LEVELS.VISITOR :
      u.activatedAt === null ? LEVELS.READER :
      !u.role              ? LEVELS.CREATOR :
                             LEVELS.USER
    assert.equal(got, want, `gradeStanding(${JSON.stringify(u)})`)
  }

  // Nothing in the grid reaches a sentinel: 8 and 9 are not standings a session
  // can hold, they are how the application and the wall are spelled.
  for (const u of rows) assert.ok(gradeStanding(u) <= LEVELS.SYSADMIN)
})
