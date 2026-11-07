// src/jobs/app-copy-dns.job.ts
// Pushes one App's read-only copy's address (`FJS-D1982`) through
// `edge.copyStep`. Dispatched as `app-copy:dns` after a refresh served the
// copy, and by `unserveCopy` when a copy is turned off, moved or its App
// deleted. On the `dns` queue with the other record writes, which is one wide,
// so two pushes to the zone never interleave.

import { defineJob }     from '@frontierjs/caravan'
import { runsEitherWay } from '../domain/job/job-context.ts'

const appCopyDns = defineJob<{ appId: string }>({
  name: 'app-copy:dns',
  handler: async (ctx) => {
    const { app } = runsEitherWay(ctx, 'app-copy:dns')
    const log   = app.logger.child('app-copy-dns')
    const appId = ctx.data.appId
    try {
      const out = await app.service('edge').call('copyStep', appId) as { name?: string; skipped?: string; removed?: unknown[] }
      if (out.skipped)      log.info('not pushed', { appId, reason: out.skipped })
      else if (out.removed) log.info('removed', { appId, name: out.name, records: out.removed.length })
      else                  log.info('pushed', { appId, name: out.name })
    } catch (err) {
      const code = Number((err as { code?: unknown }).code)
      if (code >= 400 && code < 500) (err as { retryable?: boolean }).retryable = false
      log.error('push failed', { appId, error: (err as Error).message, retried: code >= 500 || !code })
      throw err
    }
  },
  queue:       'dns',
  maxAttempts: 5,
  retryDelay:  [10_000, 60_000],
  timeout:     120_000,
})

export default appCopyDns
