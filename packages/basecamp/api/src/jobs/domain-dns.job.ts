// src/jobs/domain-dns.job.ts
// Pushes one Domain to its zone. Dispatched as `domain:dns`.
//
// Two things make a zone wrong, and both dispatch this: a `Domain` written
// (created, changed, deleted), and a release landing on a machine the App's
// ingress record does not name. The push itself is `edge.syncStep` — this file
// decides only whether to try again.
//
// Each dispatch STATES its id — `dns:<domainId>:<version>` for a write,
// `dns:<domainId>:release:<deploymentId>` for a release — so a replayed write
// is one push for all time, and a second release is a second push rather than
// a no-op keyed on a version that did not move.
//
// ─── Which failures are retried ──────────────────────────────────────────
//
// The vendor having a bad minute is a 502 and is retried: the write is one
// batch that applied whole or not at all, so a second attempt repeats it rather
// than finishing half of it. Anything below 500 is the same answer next time —
// a record somebody else made at the hostname, a Domain that is gone — so it is
// marked terminal and the job's error is the sentence a person reads. *Not
// yet* is neither: `syncStep` answers it as skipped, and the drift on `/dns/`
// still names the hostname as missing.

import { defineJob }    from '@frontierjs/caravan'
import { runsAsCaller } from './context.ts'

export default defineJob<{ domainId: string }>(
  'domain:dns',
  async (ctx) => {
    const { app } = runsAsCaller(ctx, 'domain:dns')
    const log     = app.logger.child('domain-dns')

    try {
      const out = await app.service('edge').call('syncStep', ctx.data.domainId) as { hostname: string; skipped?: string }
      if (out.skipped) log.info('not pushed', { id: ctx.data.domainId, hostname: out.hostname, reason: out.skipped })
      else             log.info('pushed', { id: ctx.data.domainId, hostname: out.hostname })
    } catch (err) {
      const code = Number((err as { code?: unknown }).code)
      if (code >= 400 && code < 500) (err as { terminal?: boolean }).terminal = true
      log.error('push failed', { id: ctx.data.domainId, error: (err as Error).message, retried: code >= 500 || !code })
      throw err
    }
  },
  {
    queue:       'fleet',
    maxAttempts: 5,
    retryDelay:  [10_000, 60_000],
    // A push is a few vendor calls. One hung on a vendor that never answers
    // would hold a slot on the queue provisions and destroys also wait on.
    timeout:     120_000,
  },
)
