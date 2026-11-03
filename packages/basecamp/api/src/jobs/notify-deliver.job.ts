// src/jobs/notify-deliver.job.ts — the delivery that did not land the first time.
//
// Two payloads, one owed-delivery concept (`FJS-D1801`):
//
//   { owed, eventId }       a state move's notice, still owed on its event row
//                           (`noticeOwedAt`), queued by the next sweep after a
//                           crash between the move and the send.
//   { channelId, message }  one channel that refused, queued by
//                           `fanOutToChannels`. The message is in the payload
//                           because the subject may have moved on by the retry.
//
// A channel retry THROWS on failure, so caravan's ladder is the backoff and
// `dead` is where a channel that never answers ends. It does not go back
// through `fanOutToChannels`, which would queue a second retry per attempt.

import { defineJob }        from '@frontierjs/caravan'
import { runsAsApp }        from '../domain/job/job-context.ts'
import {
  deliverToChannel, mailerOf, recordDeliveryFailure, stampDelivery, type ChannelRetry,
} from '../domain/notification/delivery.ts'
import { deliverOwed, type OwedKind } from '../domain/notification/owed.ts'

export type NotifyDeliver = ChannelRetry | { owed: OwedKind; eventId: string }

export default defineJob<NotifyDeliver>({
  name:        'notify:deliver',
  queue:       'default',
  // Thirty seconds to two hours: a Slack 500 is usually gone in a minute, and a
  // PagerDuty 429 asks for a back-off measured in minutes.
  maxAttempts: 6,
  retryDelay:  [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000],
  timeout:     60_000,
  handler: async (ctx) => {
    const { app, db } = runsAsApp(ctx, 'notify:deliver')
    const data = ctx.data

    if ('owed' in data) {
      await deliverOwed(app, data.owed, data.eventId)
      return
    }

    // `deletedAt` by hand: `asSystem()` bypasses `@@softDelete`, and a channel
    // retired since the first attempt must not be paged.
    const channel = await db.notificationChannel.findFirst({ where: { id: data.channelId } })
    if (!channel || channel.isActive === false || channel.deletedAt) return

    const sys = () => db
    const res = await deliverToChannel(
      { conduit: (app as any).conduit, sys, mail: mailerOf(app) }, channel, data.message)
    if (!res.ok) {
      await recordDeliveryFailure(sys, channel.id, res.error)
      throw new Error(`[${data.label}] channel '${channel.name}': ${res.error}`)
    }
    await stampDelivery(sys, channel.id)
  },
})
