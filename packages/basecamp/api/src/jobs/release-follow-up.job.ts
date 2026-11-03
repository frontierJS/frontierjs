// src/jobs/release-follow-up.job.ts
// The release a push asked for while another was still queued or building.
// Dispatched as `release:follow-up` by the push receiver (`plugins/git-push.ts`).
//
// `deployments.create` refuses a second release in flight, so a push that
// lands mid-release cannot start one. It queues this instead, and the newest
// code ships once the in-flight release ends, however it ends: a git release
// builds the branch HEAD on the machine, so one follow-up covers every push
// that arrived meanwhile.
//
// ─── Waiting ─────────────────────────────────────────────────────────────
//
// The wait is caravan's retry ladder, not a re-dispatch. The receiver's
// `unique: followup:<appId>` is a lock on work in flight, and a job that
// dispatched itself again would find its own running row holding the key and
// get a no-op back. A retry leaves the row `pending`, so the key stays held
// the whole time and a push arriving during the wait still collapses into this
// job. The attempts are sized to outlast `RELEASE_BOUND_MS`, and the job gives
// up on its own clock past that (`queuedAt`) rather than counting attempts.
//
// ─── Who it runs as ──────────────────────────────────────────────────────
//
// As the app: the push has no caller. The release itself is made through the
// same `startPushRelease` the receiver uses, which reads the standing of
// whoever enabled push again, so a person removed meanwhile gets no release.
// Any failure past the wait is logged here and never thrown: a retry would
// loop on a refusal that cannot change.

import { defineJob }  from '@frontierjs/caravan'
import { Conflict }   from '@frontierjs/junction'
import { runsAsApp }  from '../domain/job/job-context.ts'
import { inFlightRelease, RELEASE_BOUND_MS } from '../domain/release/release-record.ts'
import { startPushRelease, type PushHints } from '../plugins/git-push.ts'

/** Between looks at the in-flight release. */
const WAIT_MS = 30_000

/**
 * How long a follow-up waits. `sweepStuckReleases` fails a release only once it
 * is older than `RELEASE_BOUND_MS`, and a failed one is what frees the App, so
 * the wait outlasts the bound by a sweep's cadence.
 */
export const FOLLOW_UP_BOUND_MS = RELEASE_BOUND_MS + 10 * 60_000

const ATTEMPTS = Math.ceil(FOLLOW_UP_BOUND_MS / WAIT_MS) + 2

export interface FollowUp { appId: string, queuedAt: number, hints: PushHints }

export default defineJob<FollowUp>({
  name:        'release:follow-up',
  queue:       'deployments',
  maxAttempts: ATTEMPTS,
  retryDelay:  [WAIT_MS],
  timeout:     60_000,
  handler: async (ctx) => {
    const { app, db } = runsAsApp(ctx, 'release:follow-up')
    const log = app.logger.child('release-follow-up')
    const { appId, queuedAt, hints } = ctx.data

    const row = await db.app.findFirst({ where: { id: appId, deletedAt: null } })
    if (!row?.isDeployedOnPush || !row.pushActorId) {
      log.info('push is off, nothing to release', { appId })
      return
    }

    const inFlight = await inFlightRelease(app, appId)
    if (inFlight) {
      if (Date.now() - queuedAt > FOLLOW_UP_BOUND_MS) {
        log.warn('gave up waiting for the release in flight', { appId, behind: inFlight.id, status: inFlight.status })
        return
      }
      throw new Error(`release ${inFlight.id} is still ${inFlight.status}`)
    }

    try {
      const made = await startPushRelease(app, row, hints)
      log.info('released', { appId, deploymentId: made?.id })
    } catch (err) {
      // A button press can win the App between the look above and the create.
      if (err instanceof Conflict) throw err
      log.error('follow-up release refused', { appId, error: (err as Error).message })
    }
  },
})
