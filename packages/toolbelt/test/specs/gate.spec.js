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

import { LEVELS, levelName, levelPasses, gradeStanding, canAtLevel }
  from '../../src/gate/gate.js'

// ─── the scale ────────────────────────────────────────────────────────────────

test('gate: the scale is 0-9 and the names are derived from it', function () {
  assert.equal(LEVELS.STRANGER, 0)
  assert.equal(LEVELS.USER, 4)
  assert.equal(LEVELS.SYSTEM, 8)
  assert.equal(LEVELS.LOCKED, 9)

  // One map, both directions. `levelName` is the only inverse — a second
  // exported map was the same object under a name that read as its opposite
  // (FJS-981).
  for (const [name, n] of Object.entries(LEVELS)) assert.equal(levelName(n), name)

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

// ─── the affordance ───────────────────────────────────────────────────────────
//
// canAtLevel arrived here from Sierra, where it was reachable only through a
// browser client. Its two halves fail in opposite directions and neither is
// visible from a screen: a wrong method→position map answers about the wrong
// gate, and a `>=` in place of levelPasses answers about the wrong ladder.

test('gate: every method name reaches the position it modifies', function () {
  // One distinct number per position, so a mapping that lands on the wrong one
  // is a different answer rather than the same answer by luck.
  const gate = { read: 2, create: 3, update: 4, delete: 5 }

  const expected = {
    read: 2, find: 2, get: 2, aggregate: 2,
    create: 3,
    update: 4, patch: 4, upsert: 4, restore: 4,
    delete: 5, remove: 5,
  }

  for (const [method, need] of Object.entries(expected)) {
    assert.equal(canAtLevel(gate, method, need),     true,  `${method} at ${need}`)
    assert.equal(canAtLevel(gate, method, need - 1), false, `${method} at ${need - 1}`)
  }

  // `restore` and `aggregate` are the two that read as verbs of their own and
  // are not: a table omitting either falls through to the gate's own key, finds
  // nothing, and answers permissive — for a WRITE, in restore's case.
  assert.equal(canAtLevel(gate, 'restore',   3), false)
  assert.equal(canAtLevel(gate, 'aggregate', 1), false)
})

test('gate: the sentinels are asked through canAtLevel', function () {
  const locked = { read: 5, create: 8, update: 9, delete: 9 }

  assert.equal(canAtLevel(locked, 'patch',  LEVELS.SYSTEM),   false, 'LOCKED refuses 8')
  assert.equal(canAtLevel(locked, 'remove', LEVELS.SYSTEM),   false, 'LOCKED refuses 8')
  assert.equal(canAtLevel(locked, 'create', LEVELS.SYSADMIN), false, 'SYSTEM is not 7')
  assert.equal(canAtLevel(locked, 'create', LEVELS.SYSTEM),   true,  'SYSTEM is 8')

  // Where `>=` and levelPasses actually part, stated exactly rather than
  // gestured at: over required 0-9 × level 0-8 they agree everywhere. The only
  // divergence is a caller AT 9, which no resolver mints — so this guards
  // against a resolver that has gone wrong rather than against a schema that
  // has. Written as an enumeration because the wrong version of this test
  // asserts a divergence at level 8 and fails, which is how the overstatement
  // gets found.
  const naive = (need, l) => l >= need
  const disagree = []
  for (let need = 0; need <= 9; need++)
    for (let l = 0; l <= 9; l++)
      if (levelPasses(need, l) !== naive(need, l)) disagree.push(`${need}/${l}`)

  assert.deepEqual(disagree, ['8/9', '9/9'])
})

test('gate: unknowns are permissive, each paired with the shape that refuses', function () {
  const gate = { read: 5, create: 5, update: 5, delete: 5 }

  // No gate declared at all — the model says nothing, so nothing is withheld.
  assert.equal(canAtLevel(null,      'delete', 0), true)
  assert.equal(canAtLevel(undefined, 'delete', 0), true)
  assert.equal(canAtLevel(gate,      'delete', 0), false)

  // A position the gate does not mention. `read` alone is a real declaration.
  assert.equal(canAtLevel({ read: 5 }, 'delete', 0), true)
  assert.equal(canAtLevel({ read: 5 }, 'find',   0), false)

  // An operation nothing maps and nothing declares.
  assert.equal(canAtLevel(gate, 'somethingElse', 0), true)

  // No level known. A session that has not resolved yet is not a stranger —
  // grading it as one hides every control until the client catches up.
  assert.equal(canAtLevel(gate, 'delete', undefined), true)
  assert.equal(canAtLevel(gate, 'delete', null),      true)
  assert.equal(canAtLevel(gate, 'delete', 0),         false)
})
