import { $ } from '@frontierjs/junction'
// src/jobs/context.ts
// What a handler in this directory is handed, and the one refusal it can make.
//
// Caravan puts the running Junction app on every JobContext, typed `App |
// undefined` because caravan can run standalone. Basecamp cannot: every job
// here reads rows and talks to a machine through plugins the app configured.
// So the absence is an error stated once rather than a non-null assertion in
// four files.

import type { JobContext } from '@frontierjs/caravan'
import type { BasecampApp } from '../basecamp.types.ts'

export function appFrom(ctx: JobContext<unknown>, job: string): BasecampApp {
  if (!ctx.app) throw new Error(
    `[${job}] no Junction app on the job context — this handler reads rows and ` +
    `sends to an outpost, and caravan is running standalone.`
  )
  return ctx.app as unknown as BasecampApp
}
