// api/src/core/gate.ts — the one place a session becomes a number.
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
 * The principal the shop is when it acts on its own behalf.
 *
 * Passed once, as `createApp({ system: SYSTEM })`, and reached by exactly one
 * path: deferred work that NOBODY asked for. The nightly abandoned-order sweep
 * is the only such work here — a timer fired it, so there is no caller to run
 * as, and no caller is STRANGER(0), refused by Order's own `@@gate` exactly as
 * an anonymous browser would be.
 *
 * Work a PERSON asked for does not use this. Caravan records who dispatched a
 * job and Junction re-resolves them when it runs, so booking a courier happens
 * with the standing of the staff member who pressed Ship. Every job here used
 * to pass `{ auth: { user: SYSTEM } }` by hand instead, which quietly gave a
 * customer's checkout the authority of the shop.
 *
 * Graded in this file like every other principal — `role: 'system'` is SYSADMIN
 * above. It is NOT a row in the users table and cannot log in: nothing issues a
 * session with this role, so it is unreachable from the wire.
 */
export const SYSTEM = {
  userId:     'system',
  userType:   'service',
  role:       'system',
  email:      'system@shop.test',
  authMethod: 'created' as const,

  // The shop acting on its own behalf is one of ours, and this is not a
  // formality. `Order` and `Customer` carry `@@allow('read', auth().isStaff)`,
  // and a job runs through the caller's SCOPED client — not `asSystem()`, so
  // that the audit actor and the announcement survive. Without this the nightly
  // sweep grades SYSADMIN(7), clears every gate, reads NO ROWS because it
  // satisfies neither policy, and cancels nothing. No error, no refusal: a
  // background job that quietly stops working, which is the failure a row
  // policy makes and a gate never does.
  isStaff:    true,
}
