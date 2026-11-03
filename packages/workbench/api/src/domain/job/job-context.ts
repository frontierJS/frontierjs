// src/domain/job/job-context.ts
// What a job handler is handed. Caravan types the running app `App | undefined`
// because it can run standalone; Workbench cannot, so the absence is an error
// stated once.

import type { JobContext } from '@frontierjs/caravan'
import type { App }        from '@frontierjs/junction'

/** The work is the installation's own: a cron fire, a sweep. There is no member to run as, so it is the system client. */
export function runsAsApp (ctx: JobContext<unknown>, job: string): { app: App, db: any } {
  if (!ctx.app) throw new Error(`[${job}] no Junction app on the job context -- caravan is running standalone.`)
  return { app: ctx.app, db: (ctx.app.db as any).asSystem() }
}
