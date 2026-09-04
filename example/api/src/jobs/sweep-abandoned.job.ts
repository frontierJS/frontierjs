// api/jobs/sweep-abandoned.job.ts — the recurring one.
//
// An order left `pending` is a checkout somebody walked away from. Left alone
// it holds a reference forever and makes every count wrong, so once a night the
// shop cancels the ones old enough to be certain about.
//
// The whole declaration is here: what it does, which queue it runs on, and —
// `cron` on the definition — when it runs on its own. Autoloading this file
// from `jobsDir` is the only wiring; nothing about the sweep is stated in
// app.ts. The file name is the job's name, and Caravan refuses a `defineJob`
// name that disagrees with it.

import { defineJob } from '@frontierjs/caravan'
import type { JobContext } from '@frontierjs/caravan'

/** Orders older than this and still `pending` are abandoned. */
export const ABANDON_AFTER_DAYS = 14

interface OrderRow { id: number; reference: string; createdAt: string }

/**
 * Cancel every `pending` order older than `days`.
 *
 * Parameterised so it can be RUN rather than waited for: a cron whose only
 * proof is `nextRuns()` is a schedule, not a behavior. The scheduled fire
 * passes no data and gets the default; `POST /jobs/run/sweep-abandoned` with
 * `{"days":0}` treats every pending order as abandoned, which is how the drive
 * exercises the handler without waiting until 03:00.
 *
 * Takes the whole job context rather than the days alone, because the app is on
 * it — and there is no other route to the service layer from a handler.
 *
 * Nothing here names a principal. A cron fire is dispatched with `actor: null`,
 * so this runs as the app's own `system` (api/gate.ts, `createApp({ system })`)
 * — which is what the sweep IS. Every call below used to carry
 * `{ auth: { user: SYSTEM } }` by hand for the same effect.
 *
 * Returns the references it cancelled, which is what a log line wants.
 */
export async function sweepAbandoned(ctx: JobContext<{ days?: number }>): Promise<string[]> {
  const app    = ctx.app!
  const days   = ctx.data?.days ?? ABANDON_AFTER_DAYS
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1_000

  // A read announces nothing, so this could have gone straight to the db — it
  // goes through the service anyway, because then the gate, the policies and
  // the envelope are the same ones every other caller gets. `find` returns the
  // LIST envelope; the rows are on `.data`.
  const result = await app.service('orders').find({ status: 'pending' }) as { data: OrderRow[] }

  // Litestone stores DateTime as ISO-8601 TEXT, not epoch millis — parse it,
  // never compare it as a number.
  const stale = result.data.filter(o => Date.parse(o.createdAt) <= cutoff)

  const cancelled: string[] = []
  for (const order of stale) {
    try {
      // The named move, not a PATCH to `status`: the schema says what `cancel`
      // is legal from and Litestone refuses it under an optimistic lock, so a
      // customer paying at the same moment as this sweep produces one winner
      // and one 409 rather than a cancelled order that took money.
      await app.service('orders').call('cancel', order.id, null)
      cancelled.push(order.reference)
    } catch (err) {
      // A 409 here is the sweep losing a race, which is the machine working.
      console.warn(`[sweep] ${order.reference}: ${(err as Error).message}`)
    }
  }

  if (cancelled.length)
    console.log(`[sweep] cancelled ${cancelled.length} abandoned order(s): ${cancelled.join(', ')}`)

  return cancelled
}

/**
 * 03:00 daily, because a shop cancels abandoned checkouts at night and not
 * while people are buying.
 *
 * The scheduled fire passes no data, so the handler takes its default window;
 * `POST /jobs/run/sweep-abandoned` with `{"days":0}` is the same handler with a
 * different one. The wrapper drops the returned references — a job handler
 * answers nothing to the queue, and the sweep's own caller wants them.
 */
export default defineJob<{ days?: number }>(
  'sweep-abandoned',
  async (ctx) => { await sweepAbandoned(ctx) },
  { cron: '0 3 * * *' },
)
