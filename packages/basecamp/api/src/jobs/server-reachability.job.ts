// src/jobs/server-reachability.job.ts — the thing that notices a machine is gone.
//
// Everything needed to answer *is this box still there* was already here and
// nothing asked: `lastHeartbeatAt` written every check-in, `unreachable`
// declared on the enum, and `checkIn` already accepting the way back. What
// there was no producer for is the departure, so a machine that died stayed
// `online` for ever (`FJS-1021`).
//
// ─── Why it is a sweep and not a timer per machine ───────────────────────
//
// A timer armed at check-in and cancelled by the next one is the shape that
// looks cheaper and cannot survive a restart: the process that holds the timers
// is the process that goes down with the deploy, and every machine then reads
// `online` until it checks in again — which is exactly the machine that never
// will. A sweep reads the rows it grades, so it is correct on its first fire
// after any restart.
//
// The verdict is `core/reachability.ts` and may not be re-derived here: the
// three answers that are NOT *it went away* are the whole content, and a sweep
// that inlined `isStale` would have the interesting half in a WHERE clause
// nothing can test at a chosen instant.

import { defineJob }      from '@frontierjs/caravan'
import { runsAsApp }      from './context.ts'
import { gradeReachability, heartbeatGraceMs } from '../core/reachability.ts'
import { notifyPeople, workspaceMembers }        from '../core/notify.ts'
import type { BasecampApp } from '../basecamp.types.ts'

export interface SweepOptions {
  /** The instant to grade at. A parameter, not a clock read inside — see
   *  `gradeReachability`. */
  at?:      number
  /** Overrides the installation's `HubConfig.heartbeatTimeoutSeconds`. Stated
   *  by a test standing at an instant; the sweep itself reads the setting. */
  graceMs?: number
  /** One machine rather than the fleet, for an operator asking about a row in
   *  front of them. The same shape `dunSubscriptions` takes and for the same
   *  reason: a sweep worth running is worth running against one subject. */
  serverId?: string
}

export interface SweepResult {
  graded: number
  quiet:  number
  /** Named rather than counted: *the vendor says it is running and no Outpost
   *  has ever spoken* is a real state somebody has to fix, and a number nobody
   *  can act on is the same as silence. */
  neverSpoke: string[]
}

/**
 * Move every machine that has stopped answering to `unreachable`, and tell its
 * workspace.
 *
 * Exported so it can be run at a stated instant. The job below is one caller.
 */
export async function sweepUnreachable(
  app:  BasecampApp,
  opts: SweepOptions = {},
): Promise<SweepResult> {
  const db      = (app.db as any).asSystem()
  const at      = opts.at ?? Date.now()
  const graceMs = opts.graceMs ?? await heartbeatGraceMs(app)

  // Every workspace in one pass, the way `alert-evaluate` crosses them: the row
  // tenancy this app declares scopes to one workspace and a cron has none.
  // Narrowed to `online` here as well as in the grader — the grader is what
  // DECIDES, and this is what keeps the read off a fleet's worth of destroyed
  // rows. A row that slipped through still gets `not-watched`.
  const servers = await db.server.findMany({
    where: { status: 'online', ...(opts.serverId ? { id: opts.serverId } : {}) },
    limit: 5_000,
  })

  const result: SweepResult = { graded: servers.length, quiet: 0, neverSpoke: [] }

  for (const server of servers) {
    const verdict = gradeReachability(server, at, graceMs)
    if (verdict === 'never-spoke') { result.neverSpoke.push(server.name as string); continue }
    if (verdict !== 'quiet') continue

    // `transition`, never an update: the move is what `@@transitions` declares,
    // and it narrows the UPDATE's own WHERE to the from-state — so a machine
    // that checked in between the read above and this line stays `online`
    // instead of being marked unreachable by a sweep that read a stale row.
    try {
      await db.server.transition(server.id, 'loseContact')
    } catch {
      // The race, and it is the expected outcome rather than an error: the
      // machine came back while this pass was running. Nothing is announced,
      // because nothing happened.
      continue
    }
    result.quiet++

    await db.serverEvent.create({ data: {
      serverId: server.id,
      kind:     'unreachable',
      message:  `No check-in for ${Math.round((at - Date.parse(String(server.lastHeartbeatAt))) / 60_000)} minutes`,
      metadata: { last_heartbeat_at: server.lastHeartbeatAt, grace_ms: graceMs },
    } })

    // After the move, so a send that throws cannot leave the row `online` with
    // somebody already told it is gone.
    await notifyPeople(app, 'server_unreachable',
      await workspaceMembers(app, server.workspaceId as string), {
        serverId:   server.id,
        serverName: server.name,
        lastSeenAt: server.lastHeartbeatAt ?? null,
      })
  }

  return result
}

export default defineJob(
  'server-reachability',
  async (ctx) => {
    const { app } = runsAsApp(ctx, 'server-reachability')
    const res = await sweepUnreachable(app)

    if (res.neverSpoke.length)
      console.warn(
        `[server-reachability] ${res.neverSpoke.length} machine(s) are online by the ` +
        `vendor's account and no Outpost has ever checked in: ${res.neverSpoke.join(', ')}`)
  },
  // The scrape's own interval, and the same one `alert-evaluate` runs on: a
  // slower sweep adds its whole period to every detection without saying so.
  { cron: '* * * * *' },
)
