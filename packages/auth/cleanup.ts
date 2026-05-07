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

import { createScheduler } from '../junction/index.ts'
import type { JobHandle }  from '../junction/index.ts'

interface LitestoneClient {
  asSystem(): any
}

export interface AuthCleanupHandle {
  start(): void
  stop():  void
}

export function createAuthCleanupJobs(db: LitestoneClient): AuthCleanupHandle {

  const scheduler = createScheduler()
  const sys       = db.asSystem()

  let sessionJob:      JobHandle | null = null
  let verificationJob: JobHandle | null = null

  return {

    start() {
      sessionJob = scheduler.every('1 hour', async () => {
        await sys.sessions.deleteMany({
          where: { expiresAt: { lt: new Date() } }
        })
      })

      verificationJob = scheduler.every('1 hour', async () => {
        await sys.verifications.deleteMany({
          where: { expiresAt: { lt: new Date() } }
        })
      })
    },

    stop() {
      sessionJob?.stop()
      verificationJob?.stop()
      sessionJob      = null
      verificationJob = null
    },
  }
}
