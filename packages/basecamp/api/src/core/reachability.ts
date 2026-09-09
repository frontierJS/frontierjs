// src/core/reachability.ts — has this machine gone away, and how would we know.
//
// `ServerStatus.unreachable` was the target of NO transition: it appeared five
// times as a from-state and nowhere as a to-state, so the machine could leave a
// state it could never enter. `lastHeartbeatAt` was written by the heartbeat
// and read by three screens to print *"4h ago"*, and nothing compared it to the
// clock. So a machine that died stayed `online` for ever, green on every screen
// (`FJS-1021`).
//
// The recovery half was already built and unreachable by construction:
// `checkIn: [pending, installing, unreachable] -> online` has always accepted
// the return. What was missing was the departure.
//
// ─── Four answers, and three of them are not "it is gone" ────────────────
//
// A machine that has stopped answering and a machine nobody is watching look
// identical from a query that only asks *is the heartbeat old*, and the wrong
// one of those is an operator paged about a box they stopped themselves. So the
// grading is separated here, out of the sweep, where an instant can be handed
// to it:
//
//   not-watched  the status is not `online`. `stopped` and `draining` are
//                states an operator PUT the machine in, and `installing` is an
//                enrollment that never completed — a different fact with a
//                different fix. None of them is a machine that went away.
//   never-spoke  `online`, and no check-in has EVER been recorded. The vendor
//                said the box was running (`reportRunning`) and no Outpost has
//                ever reported. *Never arrived* and *stopped arriving* are
//                different facts and only the second is unreachable; folding
//                them loses the one an operator can act on.
//   answering    a check-in inside the grace window.
//   quiet        the only one that moves the row.

import { isStale } from '@frontierjs/junction'

/**
 * How long a machine may say nothing before it is unreachable — **when this
 * installation has no settings row**.
 *
 * The real answer is `HubConfig.heartbeatTimeoutSeconds`, which was declared
 * `@default(120) @gte(30) @lte(3600)`, rendered on the hub settings screen with
 * a hint describing this exact behavior, and read by nothing. A constant here
 * would be a second opinion about a number an operator can already set, and the
 * screen would go on offering a knob that changes nothing.
 *
 * The fallback is the schema's own default rather than a number chosen here:
 * a settings row is created the first time somebody saves, and until then the
 * app must behave the way the column says it will.
 */
export const DEFAULT_HEARTBEAT_TIMEOUT_S = 120

/** `graceMs` when there is no settings row. */
export const HEARTBEAT_GRACE_MS = DEFAULT_HEARTBEAT_TIMEOUT_S * 1_000

/**
 * The configured grace, in milliseconds.
 *
 * Read through the system client: this runs from a cron with no caller, and
 * `HubConfig` is behind `requireSystemAdmin` — the settings are the
 * installation's, and who is asking cannot change what the timeout IS.
 */
export async function heartbeatGraceMs(app: { db: unknown }): Promise<number> {
  const row = await (app.db as any).asSystem().hubConfig.findFirst({ where: { id: 'hub' } })
  const seconds = Number(row?.heartbeatTimeoutSeconds)
  return (Number.isFinite(seconds) ? seconds : DEFAULT_HEARTBEAT_TIMEOUT_S) * 1_000
}

export type Reachability = 'not-watched' | 'never-spoke' | 'answering' | 'quiet'

/** Only the columns the verdict is made from. A grader that could reach the
 *  rest of the row would start deciding on things the sweep cannot query. */
export interface ReachabilitySubject {
  status:          string
  lastHeartbeatAt: string | Date | null | undefined
}

/**
 * Grade one machine at one instant.
 *
 * `at` is a parameter and not `Date.now()`, for the reason `sweepRenewals` takes
 * one: the failure this file exists to prevent is invisible to a test that
 * cannot stand at a chosen moment, and every drive in this app checks in and
 * then asserts immediately — nothing anywhere lets time pass.
 */
export function gradeReachability(
  server:  ReachabilitySubject,
  at:      number,
  graceMs: number = HEARTBEAT_GRACE_MS,
): Reachability {
  if (server.status !== 'online')  return 'not-watched'
  if (!server.lastHeartbeatAt)     return 'never-spoke'
  return isStale(server.lastHeartbeatAt, at, graceMs) ? 'quiet' : 'answering'
}
