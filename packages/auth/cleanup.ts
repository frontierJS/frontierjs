// cleanup.ts
// Scheduled jobs that prune expired sessions and verifications.
// Call createAuthCleanupJobs(db) and then .start() after app.start().
//
// Expired rows don't create security problems — auth lookups always check
// expiresAt > now() — but pruning keeps the tables lean.
//
// Usage in server.ts:
//
//   const cleanup = createAuthCleanupJobs(db)
//
//   app.configure({
//     name: 'auth-cleanup',
//     register() {},
//     async boot() { cleanup.start() },
//   })

import { createScheduler } from '@frontierjs/junction'
import type { JobHandle }  from '@frontierjs/junction'

interface LitestoneClient {
  asSystem(): any
}

export interface AuthCleanupHandle {
  start(): void
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

  // The predicate, named rather than written inline in the timer bodies. A
  // scheduled function lives in a closure nothing can reach, so an inline body
  // can only be tested by restating it — and a test holding its own copy of a
  // rule agrees with whatever the copy says, including when the shipped one has
  // changed underneath it. `sweepNow()` is the same two calls the timers make.
  const expired = () => ({ where: { expiresAt: { lt: new Date() } } })

  const sweepSessions  = async () => { await sys.session.deleteMany(expired()) }
  const sweepEphemeral = async () => {
    await sys.verification.deleteMany(expired())
    await sys.oauthFlow.deleteMany(expired())
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
      // Assigning over a live handle orphans it: nothing holds the old timer
      // any more, so `stop()` halts only the newest pair and the first sweep
      // runs for the life of the process. Restart rather than refuse — this is
      // reached from a plugin's `boot()`, where a throw costs more than the
      // mistake it reports — and say so, because a double boot is a caller's
      // bug either way (`FJS-1000`).
      if (sessionJob || verificationJob) {
        console.warn('[auth] cleanup jobs were already running — restarting them. `start()` is being called twice.')
        stopJobs()
      }

      sessionJob      = scheduler.every('1 hour', sweepSessions)
      // Both ephemeral tables, on one timer. An OAuthFlow lives minutes rather
      // than hours, so most of what this sweeps is already dead — but a flow
      // nobody came back from is a row nothing else ever deletes.
      verificationJob = scheduler.every('1 hour', sweepEphemeral)
    },

    stop() { stopJobs() },

    async sweepNow() {
      await sweepSessions()
      await sweepEphemeral()
    },
  }
}
