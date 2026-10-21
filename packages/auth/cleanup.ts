// cleanup.ts
// Scheduled jobs that prune expired sessions and verifications.
//
// createLitestoneAuth builds one as `auth.cleanup`, and auth starts
// it from work() and stops it at shutdown, so a one-shot boot (junction call,
// the snapshot tools) runs no sweep and an app writes no plugin for it.
// `auth.cleanup.sweepNow()` drains the tables on demand.
//
// Expired rows don't create security problems — auth lookups always check
// expiresAt > now() — but pruning keeps the tables lean.

import { createScheduler } from '@frontierjs/junction/scheduler'
import type { JobHandle } from '@frontierjs/junction/scheduler'

interface LitestoneClient {
  asSystem(): any
}

export interface AuthCleanupHandle {
  /** Take a hold on the hourly sweep; the first hold starts its timers. */
  start(): void
  /** Drop a hold; the last one stops the timers. */
  stop():  void
  /**
   * Run both sweeps once, now. An operator draining these tables ahead of the
   * hour wants it, and it is the only way anything can grade what the timers
   * actually do — the alternative is a test restating the predicate, which
   * passes against whichever of the two is wrong.
   */
  sweepNow(): Promise<void>
}

export function createAuthCleanupJobs(db: LitestoneClient): AuthCleanupHandle {

  const scheduler = createScheduler()
  const sys       = db.asSystem()

  let sessionJob:      JobHandle | null = null
  let verificationJob: JobHandle | null = null
  // One instance is mounted by every app a process builds from it — a test
  // suite builds one per test — so each app's work() takes a hold and its
  // shutdown drops one. A second start that made a second pair of timers would
  // orphan the first: stop() would halt only the newest and the first sweep
  // would run for the life of the process (FJS-1000).
  let holders = 0

  // The predicate, named rather than written inline in the timer bodies. A
  // scheduled function lives in a closure nothing can reach, so an inline body
  // can only be tested by restating it — and a test holding its own copy of a
  // rule agrees with whatever the copy says, including when the shipped one has
  // changed underneath it. `sweepNow()` is the same two calls the timers make.
  //
  // `onlyExpired` rather than a hand-written `expiresAt < now`: all four models
  // declare the window, so the edge is the schema's and the clock is the
  // client's. Written as `{ expiresAt: { lt: new Date() } }` it would now be
  // ANDed with the window and match nothing — a sweep that removes no rows and
  // reports a count (`FJS-D351`).
  const expired = () => ({ onlyExpired: true })

  const sweepSessions  = async () => { await sys.session.deleteMany(expired()) }
  const sweepEphemeral = async () => {
    await sys.verification.deleteMany(expired())
    await sys.oauthFlow.deleteMany(expired())
    // A lapsed challenge is refused at resolution whether or not this has run —
    // `completeLogin` compares `expiresAt` itself. This keeps the table from
    // growing by one row per abandoned sign-in, forever.
    await sys.loginChallenge.deleteMany(expired())
    // A handoff code no page came back with. Credential declares no window,
    // so its deadline is compared here.
    await sys.credential.deleteMany({ where: { type: 'handoff', tokenExpiresAt: { lt: sys.$now() } } })
  }

  // A closure rather than `this.stop()`: the handle's methods are ordinary
  // shorthand, so a caller who destructures `{ start }` off it has no `this`.
  function stopJobs() {
    sessionJob?.stop()
    verificationJob?.stop()
    sessionJob      = null
    verificationJob = null
  }

  return {

    start() {
      if (holders++ > 0) return
      sessionJob      = scheduler.every('1 hour', sweepSessions)
      // Both ephemeral tables, on one timer. An OAuthFlow lives minutes rather
      // than hours, so most of what this sweeps is already dead — but a flow
      // nobody came back from is a row nothing else ever deletes.
      verificationJob = scheduler.every('1 hour', sweepEphemeral)
    },

    stop() {
      if (holders === 0 || --holders > 0) return
      stopJobs()
    },

    async sweepNow() {
      await sweepSessions()
      await sweepEphemeral()
    },
  }
}
