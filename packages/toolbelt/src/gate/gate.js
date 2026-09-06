/*
 * gate.js — the access LADDER: the scale, the comparison, and the grader.
 *
 * A gate is a number on a model and a number on a caller, and the question is
 * whether the second passes the first. Three realms need the answer and the
 * dependency direction forbids two of them from asking the one that owns it:
 * Litestone ENFORCES it, Junction hands it the caller it graded, and Sierra
 * renders a screen from it in plain Node with no client import at all. So the
 * ladder was a hand copy at four places, with a comment at each saying *change
 * one, change both* (`FJS-520`).
 *
 * It drifted, and the shape of the drift is the argument for this file. The
 * three graders answered three different things for one caller:
 *
 *   a signed-in caller with no `role`      Litestone 3 · Junction 4
 *   a signed-in caller with isSystemAdmin  Litestone 7 · GatePlugin's own
 *                                          constructor fallback 4
 *
 * The first is 8 of 216 field combinations; the second is 212 of 216, because
 * that fallback read nothing but *is there a user*. A schema declaring any
 * `@@gate` auto-installs a grader, so which of the three answered depended on
 * how the app happened to be wired, and the same `@@gate("4")` read was a 403
 * under one and a 200 under another.
 *
 * The tripwire existed and could not fire: a test named *agrees with junction
 * sessionGateLevel* imported only Litestone's copy, asserted it against a
 * literal, and used a fixture carrying `role` — the one field whose ABSENCE is
 * the disagreement. `FJS-D197` is the ruling; one definition is the fix, and
 * this is where it can live without any realm importing another.
 *
 * Nothing here reads a clock, a database or a request. It is two numbers and a
 * plain object.
 */

// ─── the scale ────────────────────────────────────────────────────────────────
//
// 0–7 are rungs a caller can occupy and 8–9 are SENTINELS, which is why the
// comparison below is not `>=`. 8 is *the application acting on its own behalf*
// — `asSystem()`, a job, a migration — and 9 is *there is no code path at all*,
// which is what makes an append-only table declarable. Reading the ladder does
// not separate them; writing 9 where 8 was meant produces a model that
// migrates, snapshots and passes every check, then refuses the first write the
// application makes.

export const LEVELS = Object.freeze({
  STRANGER:      0,   // not logged in
  VISITOR:       1,   // modeled as unverified
  READER:        2,   // verified, modeled as not yet activated (read-only)
  CREATOR:       3,   // signed in, no role assigned — submit but not manage
  USER:          4,   // full CRUD
  ADMINISTRATOR: 5,   // isAdmin
  OWNER:         6,   // isOwner — account/tenant owner
  SYSADMIN:      7,   // isSystemAdmin — a real human, global, revocable
  SYSTEM:        8,   // asSystem() only — background jobs, migrations
  LOCKED:        9,   // absolute wall — asSystem() included
})

/**
 * The name a schema may write instead of a digit — `@@gate("USER")`,
 * `@gate(ADMINISTRATOR)`. Derived from `LEVELS` rather than restated, so a rung
 * cannot exist in one spelling and not the other.
 */
export const LEVEL_NAMES = Object.freeze(Object.fromEntries(Object.entries(LEVELS)))

/** `4 → 'USER'`, for a message somebody has to read. */
export function levelName(level) {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === level) ?? String(level)
}

// ─── the comparison ───────────────────────────────────────────────────────────

/**
 * Does a caller at `userLevel` pass a gate of `required`?
 *
 * The one definition. Anything that DESCRIBES a gate rather than enforcing it —
 * a generated matrix, an access snapshot, a screen deciding whether to render a
 * button — asks here too, because a second copy is an artefact certifying access
 * the enforcement does not grant.
 *
 * The two sentinels are the whole reason this is a function. A hand-spelled
 * `>=` reads 8 as a rung, so it admits SYSADMIN(7) to nothing and admits
 * everything at 8 or above to a LOCKED model.
 *
 * The independent copy is `expectedVerdict` in Litestone's `access.js`, which is
 * the oracle an exhaustive 0–9 × 0–8 test grades against and says at its own
 * declaration why it must not call this.
 */
export function levelPasses(required, userLevel) {
  if (required === LEVELS.LOCKED) return false                    // 9 — asSystem() included
  if (required === LEVELS.SYSTEM) return userLevel === LEVELS.SYSTEM  // 8 — SYSADMIN(7) is not it
  return userLevel >= required
}

// ─── the grader ───────────────────────────────────────────────────────────────

/**
 * A caller's standing, from the session an app hands the framework.
 *
 * **Standing outranks the lifecycle.** An owner who never completed an
 * activation step is still the owner, so the three explicit flags are read
 * first and a lifecycle stage can only grade somebody DOWN from USER.
 *
 * **Absence and `null` are different answers, and that is the contract.**
 * `undefined` means the app does not model this stage at all; `null` means it
 * models it and this caller has not reached it. So a User model with no
 * `verifiedAt` column grades nobody down, and one that has the column with a
 * null in it grades that caller to VISITOR. Getting this backwards makes every
 * caller of a simpler app a stranger.
 *
 * **`role` is the exception to that rule and is read for presence.** It is an
 * app-defined column with app-defined values, so the ladder cannot rank what is
 * IN it — only whether the app has given this caller one. No role is CREATOR:
 * signed in, may submit, may not manage. `@frontierjs/auth`'s `User` ships
 * `role String @default("user")`, so a stock app grades USER and this branch is
 * reached by a caller some other path built (`FJS-D197`).
 *
 * A caller who can WRITE the column they are graded from is a ladder that grades
 * nothing, which is why auth ships `@allow('write', auth().isAdmin)` on both
 * `role` and `emailVerified`.
 */
export function gradeStanding(user) {
  if (!user) return LEVELS.STRANGER

  if (user.isSystemAdmin) return LEVELS.SYSADMIN
  if (user.isOwner)       return LEVELS.OWNER
  if (user.isAdmin)       return LEVELS.ADMINISTRATOR

  if (user.verifiedAt  === null) return LEVELS.VISITOR
  if (user.activatedAt === null) return LEVELS.READER

  if (!user.role) return LEVELS.CREATOR
  return LEVELS.USER
}
