// src/services/deployments/deployments.service.ts
// A Deployment is one release of an App to its Environment — a Manifest
// realized at a point in time (VISION.md §Where Basecamp Fits).
//
// Mounted at /deployments. Append-only from a person's point of view: creating
// one is a user action, advancing its status is the job's, and `remove` is
// a cancel rather than a delete — deployment history is the audit surface for
// "what is actually running", so it is never erased here.
//
// The join to app+environment is
// `include: { app: { include: { environment: true } } }` — declared in the
// schema rather than spelled out as SQL.

import { createService, NotFound, BadRequest, parseWhere, $ } from '@frontierjs/junction'
import { sessionScope, internalOnly, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, getScoped, narrowPatch, changesNothing, ws, actor, callerOrder } from '../../core/resource.ts'
import { resolveExecutor, isExecutor } from '../../providers/executor.ts'
import deploymentRun from '../../jobs/deployment-run.job.ts'
import { startRelease, recordStep, finishRelease, pushRow as pushReleaseRow } from '../../domain/release/release-record.ts'
import { isInline, isGit, imageOf, inlineFilesFor } from '../../domain/release/app-source.ts'
import { snapshotVariables } from '../../domain/release/variables.ts'
import { runtimeOf, type Runtime, CONTAINER_TYPES } from '../../domain/release/runtime.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'

// A release went to its app's environment, which is `@immutable`, so the app
// is where a row reads it (`FJS-D1609`).
const WITH_APP = { app: { include: { environment: true } } }

/**
 * The step list a deployment starts with.
 *
 * Read off the SOURCE first and the type second, because what a release has to
 * do is decided by where its bytes come from: an inline app is files behind a
 * web server, and every container word — build, push, start — describes work
 * that does not exist for it.
 *
 * The four inline steps are each one call to the machine, which is what makes
 * the list worth having: a step that stalls names what stalled. Upload and
 * activate are apart because writing the bytes and making them the live ones
 * are separate on the machine too — a release that failed to upload is never
 * the one being served.
 *
 * A container release has no stop step. Outpost's `/deploy` removes the old
 * container itself, after every check it can refuse on, so a refused release
 * leaves the live one serving; a stop sent first had already taken it down by
 * the time the refusal arrived (`FJS-1682`).
 *
 * A git release builds on the machine that runs it, so it has a build and no
 * push: there is no registry between the two. `built` is a release putting back
 * bytes an earlier one already built (a rollback) — building again would ship
 * the branch as it is now, which is neither release.
 *
 * An inline source holding no files is a release of bytes the machine already
 * holds, named by digest — a preview's Freeze publishes its build itself.
 *
 * A static git app is a site the machine builds and deploys to its Worker in
 * one call (`domain/site/site-publish.ts`), so it has one step past Validate. Its
 * release records a commit and no image, so `rollback` refuses one; a site
 * goes back by a revert on its branch (`IDEAS/owner-editing.md` 1.5).
 *
 * A container release of an app with a data volume copies it before the swap
 * (`Back up volume`, `IDEAS/backups.md` 1.6, `FJS-D1496`): the new image's
 * entrypoint migrates the volume forward, so the copy is the way back. Read
 * off the release's own runtime snapshot, as every other step is — a rollback
 * puts back a release whose snapshot differs from the app.
 */
function buildInitialSteps(target: { type: string; source?: unknown; runtime?: Runtime }, built = false): string[] {
  if (target.type === 'static' && isGit(target.source)) return ['Validate', 'Build and deploy']
  if (isInline(target.source))
    return inlineFilesFor(target.source).length
      ? ['Validate', 'Upload files', 'Activate', 'Health check']
      : ['Validate', 'Activate', 'Health check']
  const copy = target.runtime?.volumePath ? ['Back up volume'] : []
  if ((target.type === 'container' || target.type === 'function') && isGit(target.source))
    return built
      ? ['Validate', ...copy, 'Start container', 'Health check']
      : ['Validate', 'Build image', ...copy, 'Start container', 'Health check']
  // An image somebody else built has nothing to build, and a list that says
  // otherwise sends no /pull at all and reports the build as done. A database is
  // a container too: a blueprint app carries an image source, and a list of its
  // own reached Outpost as command-less /exec calls, acknowledged with nothing
  // started and the App marked running (`FJS-1764`).
  return ['Validate', 'Pull image', ...copy, 'Start container', 'Health check']
}


function steps(deploymentId: string) {
  return db().deploymentStep.findMany({
    where:   { deploymentId },
    orderBy: { position: 'asc' },
  })
}


/**
 * The release this call is about, read through the CALLER's client.
 *
 * The confinement (`FJS-384`): `Deployment` carries its own `workspaceId`, so
 * a release in another workspace answers nothing here — and every write below
 * is addressed by an id that came out of this read rather than off a payload.
 */
async function deployInScope(id: string) {
  const row = await db().deployment.findUnique({ where: { id } })
  if (!row) throw new NotFound(`Deployment '${id}' not found`)
  return row as Record<string, any>
}

/**
 * A release of `target` with the app's own settings, its steps, and the job
 * that runs it — `create` and `rebind` both. `built` names bytes an earlier
 * release already made, so a git app is started and not rebuilt; `held` is an
 * inline release of bytes the machine holds, whose snapshot uploads no files.
 */
async function queueRelease(target: { id: string; environmentId: string; type: string; source?: unknown }, data: Record<string, unknown>, { held = false, built = false } = {}) {
  // What the app looked like at release time: how its container starts
  // (`domain/release/runtime.ts`) and its variables — plain values copied, secrets by
  // id (`domain/release/variables.ts`).
  data.configSnapshot = {
    source: held ? { kind: 'inline', files: [] } : target.source ?? {}, runtime: runtimeOf(target),
    ...await snapshotVariables(db(), target),
  }
  data.toImage      ??= imageOf(target.source)
  data.triggeredBy    = actor() === 'system' ? null : actor()

  // Chain to the last successful release so a rollback knows where to go.
  const prev = await db().deployment.findFirst({
    where:   { appId: target.id, status: 'success' },
    orderBy: { finishedAt: 'desc' },
  })
  if (prev) data.previousDeploymentId = prev.id

  const deployment = await db().deployment.create({ data })

  await db().deploymentStep.createMany({
    data: buildInitialSteps({ type: target.type, ...(data.configSnapshot as { source: unknown; runtime: Runtime }) }, built).map((name, position) => ({
      deploymentId: deployment.id, position, name, status: 'pending',
    })),
  })

  // Durable hand-off — survives a restart mid-release.
  // The actor and the tenant are carried by the dispatch: caravan reads
  // both off the request in scope, and the handler declares
  // `runsAsCaller` — so this work runs as the person who asked for it,
  // in the workspace they asked in (`FJS-384`).
  await $.app.jobs.dispatch(deploymentRun, {
    deployment_id: deployment.id,
    app_id:        target.id,
    workspace_id:  ws(),
  }, { queue: 'deployments', priority: 5 })

  return deployment
}


const pushRow = (id: string) => pushReleaseRow($.app, id)

export default createService({
  name:  'deployments',
  scope: keyScope('deployments'),
  model: 'Deployment',
  // Announced by the service DEFINITION, not by an after hook: `callService`
  // is junction's one announcement point and it excludes `find`/`get` by name,
  // where an `after: { all: [...] }` hook broadcast every read to every browser
  // in the workspace (FJS-031). Declaring both is refused at construction.
  channel: workspaceChannel,
  // `?environmentId=` is the app's column, not this model's, so it is reserved
  // rather than graded as a filter, and read below.
  reservedQuery: [...WORKSPACE_QUERY, 'environmentId'],

  async find() {
    const { limit, offset } = getPagination()
    const environmentId = $.reserved.environmentId as string | undefined
    // Every filter the caller sent, not a chosen few. autoFilter has already
    // refused a key that is not a column, so a key it admitted and this body
    // skipped answered every row as a match — the /deployments/ filter bar
    // offers a dozen columns and filtered on two.
    const { rows, total } = await db().deployment.findManyAndCount({
      where:   {
        ...parseWhere($.query), workspaceId: ws(),
        ...(environmentId ? { app: { is: { environmentId } } } : {}),
      },
      include: WITH_APP,
      orderBy: callerOrder({ queuedAt: 'desc' }),
      limit, offset,
    })
    return { total, limit, offset, data: rows }
  },

  async get() {
    const row = await db().deployment.findFirst({
      where:   { id: $.id as string, workspaceId: ws() },
      include: WITH_APP,
    })
    if (!row) throw new NotFound(`Deployment '${$.id}' not found`)
    return { ...row, steps: await steps(row.id) }
  },

  async create() {
    const data  = $.data as Record<string, unknown>
    const appId = data.appId as string

    const target = await db().app.findFirst({ where: { id: appId, workspaceId: ws() } })
    if (!target) throw new NotFound(`App '${appId}' not found in this workspace`)

    // Refused here, where the person who pressed the button is still looking.
    // The job asks the same question again when it runs — this is not
    // the enforcement, it is the message: a release created and failed a
    // second later tells an operator their app is broken, where a 400 naming
    // the missing placement tells them what to do (FJS-257).
    const executor = await resolveExecutor($.app, appId)
    if (!isExecutor(executor)) throw new BadRequest(executor.reason)

    // A source that is neither an image nor something that builds one leaves
    // the start step asking docker to pull the app's NAME from a public
    // registry. Only a git container is built, here on the machine; a
    // database is an image or nothing.
    const builds = isGit(target.source) && target.type !== 'database'
    // The branch a git release builds is the App's unless the caller named
    // one; the button has no payload, so the row would otherwise say nothing.
    if (isGit(target.source) && data.branch == null && (target.source as { branch?: string }).branch)
      data.branch = (target.source as { branch?: string }).branch
    if (CONTAINER_TYPES.has(target.type as string)
        && !isInline(target.source) && !builds && !imageOf(target.source) && !data.toImage)
      throw new BadRequest(
        `App '${target.name}' names no image — ` +
        `set its source to an image (e.g. nginx:alpine), a git repository or inline files`)

    // A release that states a digest is of bytes already on the machine, and
    // builds nothing. An inline one is a preview's Freeze, so its snapshot
    // holds no files: the app's own would be uploaded over the digest, and a
    // rollback to it would put back the app's files rather than the bytes that
    // served. A container one is an image `fli basecamp:deploy` built where
    // the workspace is and loaded onto the machine (`FJS-D942`): building the
    // app's git source instead would ship the branch, not those bytes.
    const named = data.builtImage != null
    if (named && !/^sha256:[0-9a-f]{64}$/.test(String(data.builtImage)))
      throw new BadRequest(`'${data.builtImage}' is not a digest — a release of bytes the machine holds names them as sha256:<64 hex>`)
    const held = named && isInline(target.source)
    return queueRelease(target, data, { held, built: named && !held })
  },

  // ── rebind — the `domain:dns` job's release (FJS-D577) ────────────
  //
  // A hostname added or removed between releases moves the app's route and
  // not its BIND: `/route` answers `rebind`, and the container's port stays
  // on every interface (around Caddy) or on loopback (behind nothing) until a
  // release recreates it. This is that release — the app's own settings and
  // the LIVE bytes, so a git app is not rebuilt from a branch that has moved.
  // A rollback is not: its settings are the target's.
  //
  // Internal, and run as whoever wrote the Domain: the restart is theirs, and
  // `Deployment`'s create gate grades them as it grades a release pressed by
  // hand. A release already queued or building binds from the live hostnames
  // when it starts, so a second is not minted beside it — two Domains added
  // together each see `rebind`.
  async rebind() {
    const appId  = String($.id)
    const target = await db().app.findFirst({ where: { id: appId, workspaceId: ws() } })
    if (!target) throw new NotFound(`App '${appId}' not found in this workspace`)

    const inFlight = await db().deployment.findFirst({ where: { appId, status: { in: ['pending', 'building'] } } })
    if (inFlight) return { skipped: `release ${inFlight.id} is already ${inFlight.status}, and binds from the live hostnames when it starts` }

    const live = await db().deployment.findFirst({ where: { appId, status: 'success' }, orderBy: { finishedAt: 'desc' } })
    if (!live?.builtImage) return { skipped: 'no release of this app recorded the bytes it ran, so there is nothing to start again' }

    return queueRelease(target, {
      appId, trigger: 'rebind',
      toImage: live.toImage ?? null, builtImage: live.builtImage,
      commitSha: live.commitSha ?? null, commitMessage: live.commitMessage ?? null,
      branch: live.branch ?? null, author: live.author ?? null,
    }, { built: true })
  },

  async patch() {
    const deployment = await getScoped('deployment', 'Deployment')

    // No terminal-state guard here. `@@transitions(status, …)` on Deployment
    // is the one statement of what a release may do next, and it is enforced
    // at the Data boundary — so a status this row cannot reach is refused
    // with a 409 that NAMES the moves it can make.
    const patch = narrowPatch($.data as Record<string, unknown>)

    if (changesNothing(patch)) return deployment

    return db().deployment.update({ where: { id: deployment.id }, data: patch })
  },

  // `remove` cancels an in-flight release. It does NOT delete the row: the
  // deployment record is how you answer "what shipped, when, by whom", and a
  // cancelled release is part of that answer.
  async remove() {
    const deployment = await getScoped('deployment', 'Deployment')

    // `cancel: [pending, building] -> cancelled` is the
    // guard, declared on the model. Writing the status IS the enforced path;
    // `transition()` is sugar for the move alone and this one stamps
    // `finishedAt` with it.
    const updated = await db().deployment.update({
      where: { id: deployment.id },
      data:  { status: 'cancelled', finishedAt: new Date().toISOString() },
    })
    return updated
  },


  // ── rollback — POST /deployments/:id  X-Service-Method: rollback ──
  //
  // Put back what this release replaced.
  //
  // Every part of this was already being written and none of it was read:
  // `previousDeploymentId` is chained on every create under a comment saying
  // a rollback would want it, `configSnapshot` records what the app looked
  // like at release time, and `rollback: success -> rolled_back @gate(5)` is
  // declared on the model — while four screens carried a tone for a state no
  // write could produce (`FJS-517`).
  //
  // ─── What a rollback IS here ─────────────────────────────────────
  //
  // A NEW release of the OLD bytes, not a rerun of the old row. A Deployment
  // records what shipped and when; re-running one would rewrite that, and the
  // fact that somebody rolled back at 11pm on a Friday is the thing an
  // operator most wants to find afterwards.
  //
  // **The settings come from the TARGET and never from the app.** That is the
  // whole of what separates this from a redeploy: the app's columns are the
  // desired state somebody has since edited, and rolling back to the old image
  // with the new settings puts back neither release.
  //
  // ─── Why the retire happens HERE and not when the replacement lands ──
  //
  // `rolled_back` is a DECISION, not an outcome — an operator with standing 5
  // withdrew this release — so it is written at the moment the decision is
  // made, and `@gate(5)` on the move is what grades them, at the Data
  // boundary, before anything is created (Invariant 6). Deferring it to the
  // replacement's success would put the authority check on a system write in
  // a job, where no standing is left to grade.
  //
  // A replacement that then fails is three accurate rows rather than one
  // wrong one: this release withdrawn, the replacement `failed`, and
  // `App.status` still saying what is actually running.
  async rollback() {
    const being = await deployInScope(String($.id))

    // ─── The order, which is the whole of what this method has to get right ──
    //
    // Grade, then validate, then MOVE, then create. Nothing before the move
    // writes anything, so every refusal below leaves the release exactly as it
    // was — a first deploy answered *there is nothing to roll back to* with
    // the row already retired would be the worst outcome available here.
    //
    // The grade is the SCHEMA's own answer, asked rather than restated: it is
    // the same list the screen reads to decide whether to draw the button. It
    // is not the enforcement — `transition()` below is, at the Data boundary
    // (Invariant 6) — it is what puts the refusal in front of the writes.
    const move = (await db().deployment.transitions(being))
      .find((t: any) => t.name === 'rollback')
    if (!move?.allowed) throw new BadRequest(
      being.status === 'success'
        ? `Rolling back a release takes a higher standing than shipping one.`
        : `A ${being.status} release cannot be rolled back — only one that shipped.`)

    const target = being.previousDeploymentId
      ? await db().deployment.findUnique({ where: { id: being.previousDeploymentId } })
      : null

    // Nothing to go back to. Named rather than answered with an empty
    // release: the first deploy of an app has no predecessor, and that is a
    // different sentence from a predecessor that has gone.
    if (!target) throw new BadRequest(
      being.previousDeploymentId
        ? `The release this one replaced is no longer here, so there is nothing to put back.`
        : `This was the first release of this app — there is nothing to roll back to.`)

    // The bytes, as that release recorded them. `builtImage` is a digest and
    // `toImage` is the name a registry pulls by, so the digest is preferred
    // and the name travels with it.
    const image = (target.toImage ?? target.builtImage) as string | null
    if (!image) throw new BadRequest(
      `The release this one replaced recorded no image, so there is nothing to put back.`)

    const into = await db().app.findFirst({ where: { id: being.appId, workspaceId: ws() } })
    if (!into) throw new NotFound(`App '${being.appId}' not found in this workspace`)

    // Asked here for `create`'s reason: the person who pressed the button is
    // still looking, and a release that fails a second later tells them their
    // app is broken where this tells them what to do.
    const executor = await resolveExecutor($.app, being.appId)
    if (!isExecutor(executor)) throw new BadRequest(executor.reason)

    // The move, and the enforcement: `success -> rolled_back @gate(5)` is the
    // model's and so is the level. Everything above this line was a read.
    await db().deployment.transition(being.id, 'rollback')

    const replacement = await db().deployment.create({ data: {
      appId:         being.appId,
      workspaceId:   ws(),
      trigger:       'rollback',
      // What was running, and what is going back on.
      fromImage:     being.toImage ?? being.builtImage ?? null,
      toImage:       image,
      builtImage:    target.builtImage ?? null,
      // The target's, never the app's — see above.
      configSnapshot: target.configSnapshot ?? {},
      commitSha:      target.commitSha ?? null,
      commitMessage:  target.commitMessage ?? null,
      branch:         target.branch ?? null,
      author:         target.author ?? null,
      // The release this one replaces, which is `create`'s own meaning for
      // the column: the one that was current before it.
      previousDeploymentId: being.id,
      triggeredBy:    actor() === 'system' ? null : actor(),
    } })

    await db().deploymentStep.createMany({
      // The step list the TARGET's source needs, not the app's current one.
      // An app switched from inline to a container since that release would
      // otherwise be rolled back through a pipeline its old bytes cannot run.
      data: buildInitialSteps({
        type:    into.type,
        source:  (target.configSnapshot as any)?.source ?? into.source,
        runtime: (target.configSnapshot as any)?.runtime ?? runtimeOf(into),
      }, true).map((name, position) => ({
        deploymentId: replacement.id, position, name, status: 'pending',
      })),
    })

    await $.app.jobs.dispatch(deploymentRun, {
      deployment_id: replacement.id,
      app_id:        being.appId,
      workspace_id:  ws(),
    }, { queue: 'deployments', priority: 5 })

    await pushRow(being.id)

    // The REPLACEMENT is the answer: it is the row the screen navigates to
    // and the one with a status worth watching. The retired release is on the
    // page the caller is already looking at, and the push above updates it.
    return replacement
  },

  // ── The engine's writes ───────────────────────────────────────────
  //
  // `deployment:run` used to open `asSystem()` and advance the release
  // itself. It runs as whoever asked for the deploy now (`FJS-384`), and the
  // confinement is `deployInScope` — a release in another workspace answers
  // nothing, where an id off the payload used to be written wherever it
  // pointed. The writes are `domain/release/release-record.ts`'s, which a site
  // publish shares.
  //
  // All four are `internalOnly`: a person moving a release through its own
  // steps by hand is a fabricated history, and the screen reads these rows.

  async startRun() {
    return startRelease($.app, await deployInScope(String($.id)))
  },

  async stepStatus() {
    return recordStep($.app, await deployInScope(String($.id)), ($.data ?? {}) as Parameters<typeof recordStep>[2])
  },

  async finishRun() {
    return finishRelease($.app, await deployInScope(String($.id)), ($.data ?? {}) as Parameters<typeof finishRelease>[2])
  },

  hooks: {
    before: {
      all:    [sessionScope()],
      // No deriveSlug: `Deployment` has neither `name` nor `slug`, so it was a
      // hook that could never fire.
      // The engine's three. The standing was graded when `create` queued the
      // release; the queue runs as that same actor.
      startRun:   [internalOnly()],
      stepStatus: [internalOnly()],
      finishRun:  [internalOnly()],
      rebind:     [internalOnly()],
    },
  },
})
