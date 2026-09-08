import { $ } from '@frontierjs/junction'
// src/jobs/server-provision.job.ts
// Makes one machine at a cloud. Dispatched as `server:provision`.
//
// The row exists BEFORE this runs — `servers.provision` creates it at
// `provisioning` and mints the enrollment token — so a crash anywhere here
// leaves a machine somebody can see and act on rather than nothing at all.
//
// ─── What makes it safe to retry ─────────────────────────────────────────
//
// This is the one job in the app that spends money, and a redelivery is
// ordinary: the queue retries, a deploy restarts, somebody double-clicks.
// Three separate things stop it minting two machines.
//
//   The dispatch id      `server:provision:<serverId>` is the job's PRIMARY
//                        KEY, so a second dispatch for one row is a no-op for
//                        all time — not a `unique` key, which frees itself the
//                        moment the job is terminal (`@frontierjs/caravan`).
//   The recorded id      A run that finds `providerServerId` already set does
//                        not create; it picks up where it left off. That is
//                        the one that survives a crash BETWEEN the vendor
//                        answering and the row being written.
//   The tag              Every machine carries `basecamp:server:<id>`, so the
//                        case neither of the above can cover — the create
//                        succeeded and the process died before recording
//                        anything — is findable by `fleet:reconcile` instead
//                        of billing forever.
//
// The third is the honest one: an orphan is not prevented here, it is made
// visible. Nothing on this side can be atomic with somebody else's API.

import { defineJob }   from '@frontierjs/caravan'
import { runsAsCaller } from './context.ts'
import type { BasecampApp } from '../basecamp.types.ts'

/** How long a machine has to reach `installing` before this gives up on it.
 *  A cloud that has not made a machine in five minutes is not making one, and
 *  a row sitting at `provisioning` forever is the failure `FJS-1021` names one
 *  state over: an operator cannot tell it from a machine still booting. */
const BUILD_DEADLINE_MS = 5 * 60 * 1000

/** How often the vendor is asked. Slower than it could be on purpose: a create
 *  takes tens of seconds at every cloud, and a tight poll is rate limit spent
 *  on an answer that has not changed. */
const POLL_MS = 5_000

async function provision(app: BasecampApp, serverId: string): Promise<void> {
  const log     = app.logger.child('server-provision')
  const servers = app.service('servers')

  // Every write goes through the service, which owns the row, announces the
  // change and records the event — so a screen watching this machine moves
  // without polling. A job writing the row directly is a screen that freezes.
  // `any` rather than a hand-written row interface, and deliberately: the
  // shapes here are the schema's, and the mirror that gets written instead goes
  // stale in snake_case the way `JobRow` did. `db/schema.d.ts` is the fix and is
  // not wired into a service call's return type yet.
  type Row = any
  let row: Row
  try {
    row = await servers.call('provisionStep', serverId, { step: 'start' }) as Row
  } catch (err) {
    // A machine that has gone, or that this actor may no longer reach, is a
    // no-op rather than a crash loop.
    log.warn('provision not startable', { id: serverId, error: (err as Error).message })
    return
  }

  // ── The create ──────────────────────────────────────────────────────
  // Skipped where a previous attempt already got an id out of the vendor.
  if (!row.providerServerId) {
    row = await servers.call('provisionStep', serverId, { step: 'create' }) as Row
    log.info('machine created at provider', { id: serverId, provider_server_id: row.providerServerId })
  }

  // ── The wait ────────────────────────────────────────────────────────
  // Until the vendor says the machine is running and has an address. The
  // machine installs ITSELF from here — cloud-init runs, the Outpost enrolls,
  // and the heartbeat is what finally moves the row to `online`. Nothing in
  // this job opens a connection to it (`FJS-D241`).
  const until = Date.now() + BUILD_DEADLINE_MS
  while (Date.now() < until) {
    const seen = await servers.call('provisionStep', serverId, { step: 'poll' }) as Row
    if (seen.status === 'installing' || seen.status === 'online') {
      log.info('machine is up and installing itself', { id: serverId })
      return
    }
    if (seen.status === 'destroying' || seen.status === 'destroyed') {
      log.info('provision abandoned — the machine was destroyed', { id: serverId })
      return
    }
    await new Promise(r => setTimeout(r, POLL_MS))
  }

  // A deadline that is REPORTED. The row stays where it is — the machine may
  // well exist and an operator has to decide — but the trail says the wait
  // ended and why, which is the difference between a failure and a silence.
  await servers.call('provisionStep', serverId, { step: 'timeout' })
  log.error('machine did not come up inside the deadline', { id: serverId })
}

export default defineJob<{ serverId: string; workspaceId: string }>(
  'server:provision',
  async (ctx) => {
    const { app } = runsAsCaller(ctx, 'server:provision')
    await provision(app, ctx.data.serverId)
  },
  {
    queue: 'fleet',
    // ONE attempt. Every other job here retries; this one must not, because a
    // retry is the queue deciding to spend money again and the recovery for a
    // half-made machine is a person looking at a row, not a backoff. The steps
    // inside are individually re-runnable — a person pressing Provision again
    // is the retry, and the dispatch id makes that safe.
    maxAttempts: 1,
  },
)
