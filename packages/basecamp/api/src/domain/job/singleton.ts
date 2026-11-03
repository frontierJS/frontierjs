// src/domain/job/singleton.ts — a sweep that does not stack on itself.
//
// Caravan fires a cron under a per-minute key, so a sweep that outlives its
// minute is joined by the next minute's, and a slow probe or a slow database
// then runs two copies of the same reads and writes (`FJS-3871`). Both would
// grade the same rows, double-count a failure streak, and page twice.
//
// The check reads caravan's own table, so it holds across replicas as well as
// within one process. It answers `false` whenever it cannot see the queue (a
// test that calls a handler with a bare app, caravan standalone): not knowing
// must run the sweep, because a sweep that silently never runs is the failure
// these jobs exist to prevent.

import type { JobContext } from '@frontierjs/caravan'

export function otherRunIsLive(ctx: JobContext<unknown>, name: string): boolean {
  const jobs = (ctx.app as { jobs?: { list?: Function } } | undefined)?.jobs
  if (typeof jobs?.list !== 'function') return false
  try {
    const running = jobs.list({ status: 'running', limit: 200 }) as Array<{ id: string; name: string }>
    return running.some(j => j.name === name && j.id !== ctx.id)
  } catch {
    return false
  }
}
