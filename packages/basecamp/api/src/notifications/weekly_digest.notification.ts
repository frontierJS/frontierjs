// src/notifications/weekly_digest.notification.ts
//
// **`kinds.ts` promised deploys, alerts AND SPEND, and spend has no source.**
// `cloudSpend` is a declared adapter with nothing behind it (`docs/ADAPTERS.md`),
// so a digest reporting a figure would be inventing one. The description in
// `kinds.ts` says what this actually counts; the day the adapter is wired, the
// payload grows a field and the description grows a word.
//
// Every number here is COUNTED at send time by `jobs/weekly-digest.job.ts` over
// rows this app already has. Nothing is stored: a digest is a rendering of the
// week, and a stored one is a second answer that goes stale the moment anything
// is backfilled.

import { defineNotification, inApp, mail } from '@frontierjs/notifications'
import { declaredTransports, appUrl }      from './_shared.ts'

export interface DigestPayload {
  workspaceId:   string
  workspaceName: string
  /** ISO dates, inclusive start and exclusive end — the same half-open window
   *  the rest of this app uses for a period. */
  from:          string
  to:            string
  deploysOk:     number
  deploysFailed: number
  alertsFired:   number
  jobsFailed:    number
}

/** The one sentence, built once so the in-app line and the email's first line
 *  cannot drift apart. A digest that said different things on two transports is
 *  two digests. */
function summary(p: DigestPayload): string {
  const bits = [
    `${p.deploysOk} deploy${p.deploysOk === 1 ? '' : 's'}`,
    p.deploysFailed ? `${p.deploysFailed} failed` : null,
    p.alertsFired   ? `${p.alertsFired} alert${p.alertsFired === 1 ? '' : 's'}` : null,
    p.jobsFailed    ? `${p.jobsFailed} job failure${p.jobsFailed === 1 ? '' : 's'}` : null,
  ].filter(Boolean)
  // A quiet week is a real answer and reads better than a row of zeroes.
  return bits.length === 1 && !p.deploysOk ? 'A quiet week — nothing to report.' : bits.join(' · ')
}

export default defineNotification<DigestPayload>({
  via: declaredTransports,

  inApp: (p) => inApp()
    .title(`Week in ${p.workspaceName}`)
    .body(summary(p))
    .action('Open dashboard', '/')
    .context('Workspace', p.workspaceId)
    .data({
      from: p.from, to: p.to,
      deploysOk: p.deploysOk, deploysFailed: p.deploysFailed,
      alertsFired: p.alertsFired, jobsFailed: p.jobsFailed,
    }),

  email: (p) => mail()
    .subject(`Week in ${p.workspaceName}`)
    .line(summary(p))
    .line(`${p.from} to ${p.to}.`)
    .action('Open dashboard', appUrl('/')),
})
