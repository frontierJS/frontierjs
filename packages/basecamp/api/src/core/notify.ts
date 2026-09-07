// src/core/notify.ts — who gets told, and on which transports.
//
// `@frontierjs/notifications` answers *what a notification looks like* and
// *how it is delivered*. What it cannot answer is **whether this person wants
// it**, because the preference is this app's model: `NotificationPreference`,
// one row per (person, kind), and the absence of a row is a default rather than
// silence. That resolution is here and may be nowhere else — a sender that
// decided for itself is a preference screen honoured by some callers and
// ignored by others, which is worse than no screen at all (`FJS-967`).
//
// ─── Why the transports ride on the RECIPIENT ────────────────────────────
//
// `notify()` reads `via(payload, recipient)` and does not await it, so a
// definition cannot read a row to decide. That is the right shape and not a
// limitation: a preference is per PERSON, so two recipients of one notification
// legitimately get different transports, and a `via` that answered once for the
// whole send could not say that. So this module resolves per recipient and
// stamps `transports` on the Recipient, and every definition's `via` is
// `(_, r) => r.transports`.
//
// ─── Email is a capability, not a preference ─────────────────────────────
//
// A Basecamp with no mail provider is a supported configuration
// (`core/mailer.ts`), and `notify()` THROWS on a transport with no formatter or
// no driver — before anything is delivered. So a person who asked for email on
// an app that cannot mail must get their in-app copy rather than an exception
// that costs them both. The drop is here, once, and it is silent by design:
// the screen already says the app has no mailer.

import { NOTIFICATION_KINDS, notificationKind } from '../services/notification-preferences/kinds.ts'
import type { BasecampApp } from '../basecamp.types.ts'

/** The transports this app can actually deliver on. `inApp` always; `email`
 *  only where a provider is configured, which `app.mail` is the one answer to. */
function available(app: BasecampApp): Set<string> {
  const set = new Set(['inApp'])
  if ((app as { mail?: unknown }).mail) set.add('email')
  return set
}

/**
 * What one person wants for one kind, as transport names.
 *
 * The default comes from `kinds.ts` — the same table the preferences screen
 * renders — so a person who has never opened that screen is delivered to rather
 * than skipped. A kind nobody declared answers nothing rather than guessing:
 * that is a notification whose file name is not a `NotificationKind`, which the
 * schema test refuses, so reaching it means the two lists have already parted.
 */
export async function transportsFor(
  app:    BasecampApp,
  userId: string,
  kind:   string,
): Promise<string[]> {
  const def = notificationKind(kind)
  if (!def) return []

  // asSystem(): this runs from jobs and from hooks alike, and a preference row
  // is `@@gate("1")` with `userId == auth().id`. Reading somebody ELSE's row is
  // exactly what a sender does, and no caller's standing makes that legal —
  // which is why the bypass is stated rather than routed around.
  const row = await (app.db as any).asSystem().notificationPreference.findFirst({
    where: { userId, kind },
  })

  const want = { inApp: row?.inApp ?? def.inApp, email: row?.email ?? def.email }
  const can  = available(app)
  return (['inApp', 'email'] as const).filter(t => want[t] && can.has(t))
}

/** One addressee, with the answer already on it. */
export interface Addressee {
  id:          string
  email?:      string
  name?:       string
  transports:  string[]
  [key: string]: unknown
}

/**
 * Tell people about something.
 *
 * Answers how many were actually delivered to, which is the number a caller
 * can log — *nobody wanted this* and *nothing was sent* are different facts and
 * a void return collapses them.
 *
 * A throw from one recipient does not cost the others theirs. `notify()`
 * validates eagerly and throws before delivering, and the likeliest cause is a
 * formatter this app has not written — one bad definition must not silence a
 * whole deploy's worth of recipients.
 */
export async function notifyPeople(
  app:     BasecampApp,
  kind:    string,
  userIds: string[],
  payload: unknown,
): Promise<number> {
  const factory = (app as any).notifications?.get(kind)
  if (!factory) {
    // The one failure this shape adds, and it is loud rather than a dropped
    // send: the loader stamps a file name as the type, so a missing factory
    // means no `<kind>.notification.ts` exists — a kind the screen offers and
    // nothing can deliver.
    console.error(`[notify] no notification declared for kind '${kind}' — nothing sent`)
    return 0
  }

  const sys   = (app.db as any).asSystem()
  const seen  = new Set<string>()
  let   sent  = 0

  for (const userId of userIds) {
    // A person named twice — two memberships, a subject they both own and
    // watch — is told once. The de-dupe is here rather than at each call site
    // because every caller assembles its list from a different query.
    if (!userId || seen.has(userId)) continue
    seen.add(userId)

    const transports = await transportsFor(app, userId, kind)
    if (!transports.length) continue

    const user = await sys.user.findFirst({ where: { id: userId } })
    // A suspended account is still a person with rows; it is not somebody to
    // page. Deleted is the same answer for a different reason.
    if (!user || user.status !== 'active' || user.deletedAt) continue

    try {
      await (app as any).notify(
        { id: user.id, email: user.email, name: user.name, transports },
        factory(payload),
      )
      sent++
    } catch (err) {
      console.error(`[notify] ${kind} → ${userId}: ${(err as Error).message}`)
    }
  }
  return sent
}

/**
 * Everybody in a workspace, optionally narrowed to roles.
 *
 * Membership is read through `asSystem()` for `transportsFor`'s reason: a job
 * has no caller, and the people to tell are not a function of who asked.
 * `acceptedAt` is required — an invitation nobody accepted is not a member, and
 * mailing one is telling a stranger about a fleet.
 */
export async function workspaceMembers(
  app:         BasecampApp,
  workspaceId: string,
  roles?:      string[],
): Promise<string[]> {
  const rows = await (app.db as any).asSystem().workspaceMember.findMany({
    where: {
      workspaceId,
      ...(roles?.length ? { role: { in: roles } } : {}),
      acceptedAt: { not: null },
    },
  })
  return rows.map((r: any) => r.userId as string)
}

/** Every kind this app declares, for the test that holds the three lists
 *  together. Exported from here rather than restated: `kinds.ts` is the table
 *  the screen renders, and this is the same list under a name that says what it
 *  is being used for. */
export const DECLARED_KINDS = NOTIFICATION_KINDS.map(k => k.kind)
