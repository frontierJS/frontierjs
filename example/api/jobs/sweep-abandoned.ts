// api/jobs/sweep-abandoned.ts — the recurring one.
//
// An order left `pending` is a checkout somebody walked away from. Left alone
// it holds a reference forever and makes every count wrong, so once a night the
// shop cancels the ones old enough to be certain about.
//
// ─── Why this file is not `*.job.ts` ──────────────────────────────────────
//
// It could be: the handler is an ordinary handler. But `defineJob`'s options
// are `{ queue, maxAttempts, retryDelay }` — there is **no `cron` key**, and
// `queue.schedule(name, expr, handler)` is the only way to register a recurring
// job. So a file in `jobsDir` can declare everything about itself EXCEPT when
// it runs, and a job that autoloaded and then never fired would be the worst of
// both. Naming it `.ts` keeps it out of the autoload glob and puts the whole
// declaration — handler, expression, queue — in one call in `app.ts`.
//
// Filed as a gap against Caravan. If `defineJob` grows `cron`, this file
// becomes `sweep-abandoned.job.ts` and the line in `app.ts` goes away.

import { getApp } from '../app-ref.ts'
import { SYSTEM } from '../gate.ts'

/** Orders older than this and still `pending` are abandoned. */
export const ABANDON_AFTER_DAYS = 14

interface OrderRow { id: number; reference: string; createdAt: string }

/**
 * Cancel every `pending` order older than `days`.
 *
 * Parameterised so it can be RUN rather than waited for: a cron whose only
 * proof is `nextRuns()` is a schedule, not a behaviour. The scheduled fire
 * passes no data and gets the default; `POST /jobs/run/sweep-abandoned` with
 * `{"days":0}` treats every pending order as abandoned, which is how the drive
 * exercises the handler without waiting until 03:00.
 *
 * Returns the references it cancelled, which is what a log line wants.
 */
export async function sweepAbandoned(days = ABANDON_AFTER_DAYS): Promise<string[]> {
  const app    = getApp()
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1_000

  // A read announces nothing, so this could have gone straight to the db — it
  // goes through the service anyway, because then the gate, the policies and
  // the envelope are the same ones every other caller gets. `find` returns the
  // LIST envelope; the rows are on `.data`.
  const result = await app.service('orders').find({ status: 'pending' }, {
    auth: { user: SYSTEM as never },
  }) as { data: OrderRow[] }

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
      await app.service('orders').call('cancel', order.id, null, {
        auth: { user: SYSTEM as never },
      })
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
