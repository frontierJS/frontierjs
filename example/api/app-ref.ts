// api/app-ref.ts — how an autoloaded job reaches the app.
//
// A Caravan handler is called with ONE argument, the job:
//
//   defineJob('book-courier', async (job) => { … })
//
// There is no `job.app` and no second parameter, so a `*.job.ts` file
// autoloaded from `jobsDir` has no way to reach `app.service(…)` — and calling
// a service is the whole reason background work exists in a framework that
// owns its announcements. (Junction hands `app` to every plugin's `register()`;
// Caravan keeps it for itself.)
//
// Two ways out. Registering the handlers in `app.ts` with a closure over `app`
// works and needs no module like this one — but it gives up `jobsDir`, which is
// the feature being exercised here, and it puts the body of every job in the
// assembly file. So instead: `app.ts` publishes the app here once it exists,
// and the job files read it back when they run, which is always after boot.
//
// Filed as a gap against Caravan rather than dressed up as a pattern.

import type { App } from '@frontierjs/junction'

let _app: App | null = null

export function setApp(app: App): void {
  _app = app
}

/**
 * The running app. Throws rather than returning null: a job that cannot reach
 * the service layer must fail loudly and be retried, not quietly do nothing.
 */
export function getApp(): App {
  if (!_app) throw new Error('app-ref: setApp() has not run — a job fired before boot')
  return _app
}
