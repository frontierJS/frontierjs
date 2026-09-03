// api/src/core/channels.ts — who receives a broadcast.
//
// A service declares `channel: 'orders'` and Junction publishes every write on
// it. Nothing is delivered until a CONNECTION has joined that channel, and
// joining is this file's decision — the one an app makes and the framework
// cannot.
//
// It exists because both halves of the decision fail silently.
//
//   · **A channel nobody joined broadcasts into nothing.** No error, no log,
//     no dropped frame — the publish succeeds and reaches an empty set, and
//     the symptom is a screen that never updates. 28 services here declare a
//     channel and three are joined below; the other 25 announce to nobody,
//     which is correct and is stated rather than discovered (see the list).
//
//   · **A channel a connection joined used to hand it every row published
//     there, with no policy applied** — `@@allow` compiles into a SELECT's
//     WHERE and a broadcast is not a SELECT, so joining was an ungraded GRANT
//     (`FJS-631`). Junction grades a broadcast per recipient now, through
//     `$readAs` at the Data boundary, so joining a channel is a subscription
//     and no longer a permission. What is below is therefore a list of what
//     each connection LISTENS to, not of what it may read.
//
// ─── What is joined ───────────────────────────────────────────────────────
//
//   products     Product reads at STRANGER(0) and carries no row policy, so
//                the broadcast tells nobody anything a GET would not — and
//                junction skips grading it entirely for that reason.
//   orders       Order reads at VISITOR(1) behind two policies — staff, or
//                the shopper it belongs to. Each frame is now graded and
//                SHAPED per recipient, so a shopper receives their own orders
//                and nobody else's, and an anonymous connection receives none.
//   customers    Customer, same shape, same treatment.
//
// ─── The one channel that is not a service's ──────────────────────────────
//
// `@frontierjs/notifications`' in-app transport publishes to
// `notifications:user:<id>`. That name is the PACKAGE's, spelled here once so
// a connection can join its own; an anonymous connection has none to join,
// which is the only reason this is not "join everything".

import type { App } from '@frontierjs/junction'

/** Channels every connection joins, whoever is on the other end. */
export const OPEN_CHANNELS = ['orders', 'products', 'customers'] as const

/** The in-app notification channel for one person. `@frontierjs/notifications`
 *  owns this spelling; it is repeated here and nowhere else. */
export const notificationChannel = (userId: string): string => `notifications:user:${userId}`

/** A session as this app can read one. Auth's own shape puts the id at
 *  `userId`; a hand-built principal puts it at `id`, so both are read — the
 *  wrong one is `undefined`, which joins nothing and says nothing. */
type Session = { userId?: string; id?: string } | null | undefined

/** Everything one connection listens to. Called once, on connection. */
export function joinChannels(app: App, session: Session, conn: unknown): void {
  for (const name of OPEN_CHANNELS) app.channel!(name).join(conn as never)

  const userId = session?.userId ?? session?.id
  if (userId) app.channel!(notificationChannel(userId)).join(conn as never)
}
