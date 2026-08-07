// api/gate.ts — the one place a session becomes a number.
//
// Litestone owns the SCALE (0–7). Each app owns the mapping from its own user
// shape onto it. This file is that mapping, and it is four lines because
// Junction already ships the general case.
//
// ─── Why this file has to exist ───────────────────────────────────────────
//
// Not because the default is broken — it is not. A schema declaring ANY @@gate
// auto-installs GatePlugin({ getLevel: FrontierGateGetLevel }), and since that
// resolver was fixed on 2026-08-04 it grades a verified @frontierjs/auth session
// USER(4) on its own. An app with plain signed-in/signed-out authority can pass
// no getLevel at all and be correct. ("Install no plugin" is still NOT the same
// as "no gate" — the default installs itself, deliberately, because a
// declared-but-unenforced gate is a fail-open default.)
//
// This file exists for the one thing the default cannot do: reach ADMIN(5).
// It grades standing from `isAdmin` / `isOwner` / `isSystemAdmin` — booleans
// auth's toContext() does not emit — and it reads `role` only as a presence
// check, never interpreting the string. That is deliberate on both sides:
// 'admin' means whatever an app decides it means, and guessing would hand out
// level 5 on a string match.
//
// Verified by running it: without the wrapper below, a user with role 'admin'
// creates fine and is refused DELETE at level 4. With it, 5.
//
// ─── Verified ladder ──────────────────────────────────────────────────────
//
//                                     default   with this file
//   no session                        0         0   STRANGER       reads only
//   registered, email unverified      1         1   VISITOR        reads only
//   registered, email verified        4         4   USER           create + update
//   verified, role 'admin'            4         5   ADMINISTRATOR  + delete, + refund
//
// The unverified→1 step is not an accident to work around: `verifiedAt: null`
// means "this app models verification and this user has not reached it". An app
// with no verification flow emits no verifiedAt at all and its users grade 4 —
// absence is not an objection.

import { sessionGateLevel } from '@frontierjs/junction'
import { LEVELS }           from '@frontierjs/litestone'

/** A SessionContext, or null for an unauthenticated caller. */
type Gradable = { role?: string } | null | undefined

export function shopGateLevel(user: Gradable): number {
  if (user?.role === 'system') return LEVELS.SYSADMIN        // 7 — see SYSTEM below
  if (user?.role === 'admin')  return LEVELS.ADMINISTRATOR   // 5
  return sessionGateLevel(user)
}

/**
 * The principal background work runs as.
 *
 * A Caravan job has no session — nobody is making the request. Junction's
 * in-process caller defaults to `auth: { user: null }`, which grades STRANGER(0)
 * here, so `book-courier` writing back through the orders service was refused by
 * the model's own `@@gate` exactly as an anonymous browser would be. Correct, and
 * the reason it must be said out loud rather than worked around: the alternative
 * is the job reaching for `db.asSystem()` and writing at the DATA boundary, where
 * nothing announces the change and no tab ever hears about it.
 *
 * So background work gets a principal, and it is graded in the same file every
 * other principal is graded in. `api/jobs/*.job.ts` pass it as
 * `app.service('orders').patch(id, data, { auth: { user: SYSTEM } })`.
 *
 * It is NOT a row in the users table and cannot log in — nothing issues a
 * session with this role, so it is unreachable from the wire.
 */
export const SYSTEM = { role: 'system', userId: 'system', email: 'system@shop.test' }
