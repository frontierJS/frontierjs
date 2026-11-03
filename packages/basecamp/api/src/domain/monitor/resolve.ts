// src/domain/monitor/resolve.ts — closing the incident a down monitor opened.
//
// The sweep reads monitors that are not paused, and a delete cascades the
// monitor's channel links. Either way nothing is left that would ever send the
// recovery, so a page opened by the outage stays open on the pager
// (`FJS-3874`). The caller of this is the service that pauses or removes.

import { fanOutToChannels } from '../notification/delivery.ts'
import type { App } from '@frontierjs/junction'

/**
 * Send the resolve for a monitor that was `down`, through its channels.
 *
 * The dedup key is the sweep's own (`basecamp:monitor:<id>`), which is what
 * lets the receiver close the incident the outage opened. Call it BEFORE a
 * delete, while the channel links exist. Never throws: the pause or delete it
 * accompanies has already been decided.
 */
export async function resolveDownMonitor(
  app:     App,
  monitor: { id: string; name: string; status: string },
  reason:  string,
): Promise<void> {
  if (monitor.status !== 'down') return
  try {
    const db    = (app.db as any).asSystem()
    const links = await db.monitorChannel.findMany({
      where:   { monitorId: monitor.id },
      include: { channel: true },
    })
    await fanOutToChannels(app, () => db, links.map((l: any) => l.channel), {
      title:    `[recovered] ${monitor.name}`,
      text:     reason,
      severity: 'info',
      action:   'resolve',
      dedupKey: `basecamp:monitor:${monitor.id}`,
    }, `monitor ${monitor.name}`)
  } catch (err) {
    console.error(`[monitor] resolving ${monitor.name}: ${(err as Error).message}`)
  }
}
