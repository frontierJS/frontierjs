import { $ } from '@frontierjs/junction'
// src/jobs/server-destroy.job.ts
// Unmakes one machine at a cloud. Dispatched as `server:destroy`.
//
// The opposite safeguard to `server:provision.job.ts`, and the asymmetry is the
// point. A provision runs ONCE and never retries, because a retry is the queue
// deciding to spend money again. A destroy retries, because the failure mode is
// the other way round: a machine that is still running after the row says
// `destroying` is a bill, and every step of a destroy is idempotent — a vendor
// that has never heard of the id answers *destroyed*, which is the same outcome.
//
// Both use a stated dispatch id, so a double-click is one job either way.

import { defineJob }    from '@frontierjs/caravan'
import { runsAsCaller } from './context.ts'
import type { BasecampApp } from '../basecamp.types.ts'

export default defineJob<{ serverId: string; workspaceId: string }>(
  'server:destroy',
  async (ctx) => {
    const { app } = runsAsCaller(ctx, 'server:destroy')
    const log     = app.logger.child('server-destroy')

    try {
      await app.service('servers').call('destroyStep', ctx.data.serverId)
      log.info('machine destroyed', { id: ctx.data.serverId })
    } catch (err) {
      // Thrown so the queue applies its backoff. A machine that could not be
      // destroyed must keep being asked about — it is costing money until it
      // is gone, and a swallowed failure leaves a row at `destroying` that
      // nothing will ever move.
      log.error('destroy failed — will retry', {
        id: ctx.data.serverId, error: (err as Error).message,
      })
      throw err
    }
  },
  {
    queue: 'fleet',
    // Three attempts with a widening backoff. A cloud having a bad minute is
    // the ordinary case, and the thing being retried cannot double-charge.
    maxAttempts: 3,
    retryDelay:  [10_000, 60_000],
  },
)
