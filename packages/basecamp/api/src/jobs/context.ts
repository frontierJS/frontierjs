// src/jobs/context.ts
// What a handler in this directory is handed, and the two refusals it can make.
//
// Caravan puts the running Junction app on every JobContext, typed `App |
// undefined` because caravan can run standalone. Basecamp cannot: every job
// here reads rows and talks to a machine through plugins the app configured.
// So the absence is an error stated once rather than a non-null assertion in
// four files.
//
// ─── Who a job runs as ───────────────────────────────────────────────────
//
// A request carries both answers — a signed-in caller, and a workspace named in
// a header. A job wakes up an hour later with neither, and until 2026-08-23 the
// framework had no way to give them back, so all five handlers here opened
// `app.db.asSystem()` behind a comment saying a job has no caller. That drops
// the gate, the row policies and the audit actor together to relax the one that
// was in the way (`FJS-384`).
//
// It has a caller now. Caravan records `actor_id` and `tenant_id` at dispatch,
// junction re-binds both through `app.runAs`, and the membership is READ AGAIN
// when the job runs — so an actor who lost access between asking and running is
// refused rather than replayed.
//
// **The dispatch site declares and the handler asserts**, which is what these
// two functions are for. The failure they exist to prevent is the one that
// built the old shape: a handler that wanted a caller, found none, and helped
// itself to system quietly.
//
//   runsAsCaller  the work is somebody's. Refuses unless the queue recorded an
//                 actor AND a tenant, so a dispatch that forgot to state one
//                 fails by name instead of escalating.
//   runsAsApp     the work is the app's own — a cron fire, a sweep. There is no
//                 membership to resolve and a service call answers 401, so this
//                 is the system client, said out loud.
//
// What NEITHER mode changes is which rows may be written at all. `RecipeRun`,
// `DeploymentStep`, `CleanupRun` and `JobRun` are gated at SYSTEM for update —
// the schema saying a run's OUTCOME belongs to the machine and not to whoever
// asked — and no standing a workspace grants reaches them (`owner` is 6). So a
// caller-mode handler does its gated writes through an `internalOnly()` service
// method, where the CONFINEMENT is the parent read above the write: a row in
// another workspace answers nothing, which is the refusal `asSystem()` cannot
// make.

import type { JobContext }  from '@frontierjs/caravan'
import type { BasecampApp } from '../basecamp.types.ts'

export function appFrom(ctx: JobContext<unknown>, job: string): BasecampApp {
  if (!ctx.app) throw new Error(
    `[${job}] no Junction app on the job context — this handler reads rows and ` +
    `sends to an outpost, and caravan is running standalone.`
  )
  return ctx.app as unknown as BasecampApp
}

/** A handler's own answer to *whose work is this*. */
export interface CallerJob {
  mode:   'caller'
  app:    BasecampApp
  /** The workspace the work was queued for — junction re-bound it, so it is
   *  the tenant every service call below resolves against. */
  tenant: string
  /** Who asked. Already re-resolved by `runAs`; here for a record that names them. */
  actor:  string
}

export interface AppJob {
  mode: 'app'
  app:  BasecampApp
  /** The system client, and the only mode entitled to one. */
  db:   any
}

/**
 * The work is somebody's — assert it, do not assume it.
 *
 * Refuses rather than falling back, because the fallback is what this exists to
 * remove: a job dispatched without an actor would otherwise run as the app, at
 * SYSTEM, against rows nobody checked it may touch. A caller who lost their
 * membership is refused deeper, by `membershipClaim` on the first service call.
 */
export function runsAsCaller(ctx: JobContext<unknown>, job: string): CallerJob {
  const app    = appFrom(ctx, job)
  const actor  = app.principal()?.userId
  const tenant = app.tenant()

  if (!actor || !tenant) throw new Error(
    `[${job}] declares runsAsCaller and the queue recorded ${actor ? 'no tenant' : 'no actor'}. ` +
    `A dispatch inside a request carries both; one made outside one has to state them ` +
    `(caravan's \`actor\` and \`tenant\` options). Refused rather than run as the app: ` +
    `this handler's writes are confined by a read at the caller's standing, and there is ` +
    `no caller.`
  )

  return { mode: 'caller', app, tenant, actor: String(actor) }
}

/**
 * The work is the app's own.
 *
 * A cron fire has no actor by construction, and a service call from here
 * answers 401 at `authenticate` — measured, not assumed — so system is the
 * only client this mode can have. It refuses when an actor IS in scope: that
 * means the dispatch neither stated `actor: null` nor meant this mode, and
 * running somebody's request as the app is the escalation in the other
 * direction.
 */
export function runsAsApp(ctx: JobContext<unknown>, job: string): AppJob {
  const app   = appFrom(ctx, job)
  const actor = app.principal()?.userId

  if (actor) throw new Error(
    `[${job}] declares runsAsApp and the queue recorded actor '${actor}'. Somebody asked ` +
    `for this work, so it runs as them — declare runsAsCaller, or state \`actor: null\` at ` +
    `the dispatch to say the app owns it even though a request started it.`
  )

  return { mode: 'app', app, db: app.db.asSystem() }
}

/**
 * A job dispatched BOTH ways — `job:run` is triggered by a person and fired by
 * a cron — so the handler must hold both paths and says so here rather than
 * discovering which one it is in the middle of its work.
 */
export function runsEitherWay(ctx: JobContext<unknown>, job: string): CallerJob | AppJob {
  return appFrom(ctx, job).principal()?.userId
    ? runsAsCaller(ctx, job)
    : runsAsApp(ctx, job)
}
