// src/services/apps/apps.service.ts
// Apps — the deployable unit. Lives in an Environment, runs on one or more
// Servers.
//
// Mounted at /apps. `model: 'App'` derives validation from db/schema.lite.
//
// Custom methods, addressed the way DECISIONS.md settled — `POST /apps/:id`
// with `X-Service-Method`, never a path segment:
//   place · unplace — which machines the app runs on
//   logs           — what the container is saying, read through the executor
//
// The table is `app`, not `service`. The old header here said "table name in
// DB: service (legacy — kept for migration continuity)"; that name was the
// exact overload VISION.md §Vocabulary forbids and it is gone — Service is the
// API realm's noun. See db/README.md §Two renames.
//
// The hand-rolled WITH_ENV JOIN is replaced by `include: { environment: true }`.
// The relation is declared in the schema, so the join is derived rather than
// spelled out — and it returns a nested object instead of flattened
// `environment_name` / `environment_tier` columns.

import { createService, NotFound, BadRequest, parseWhere, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, findScoped, getScoped, removeScoped, assertSlugFree, deriveSlug, narrowPatch, changesNothing, ws }
  from '../../core/resource.ts'
// The ONE definition of a certificate's condition, imported rather than
// recomputed: an include returns raw Domain rows, so without this the app
// detail screen received hostnames with no cert_status at all and every one of
// them rendered as "no certificate" — including the expired ones.
import { certStatusOf } from '../domains/domains.service.ts'
import { resolveExecutor, isExecutor } from '../../providers/executor.ts'
// The one reader of `App.source`. A service that parsed the blob itself would
// be the second, and the two would disagree the first time a kind was added.
import { parseAppSource, sourceKindOf, summarizeSource, describeSource } from '../../core/app-source.ts'
import type { BasecampApp }    from '../../basecamp.types.ts'

const WITH_ENV = { environment: true }

// The detail read. `domains` comes with the app because `App.domain` — one
// nullable string — is gone: a hostname is a row now, and an app with an apex
// and a www is the ordinary case rather than the case the column could not
// describe. Litestone batches an include into one `IN` per relation level, so
// this is a second query for the whole page, not one per app.
const WITH_DETAIL = { environment: true, domains: true }

export function createAppsService(app: BasecampApp) {

  /**
   * `source` and `type` are one decision, so they are checked together.
   *
   * An inline app has no image and no container — its release is files behind
   * a web server — and `AppType` already has the word for that. Letting the two
   * disagree would produce an app whose deploy pipeline is the container one
   * and whose bytes are an HTML file, which fails four steps in with a docker
   * error about an image nobody named.
   *
   * The parse REWRITES `data.source`: what gets stored is the normalized shape,
   * never the payload, so an unknown key cannot ride into the column and be
   * read back later as though something had meant it.
   */
  function checkSource(data: Record<string, unknown>, current?: Record<string, unknown>) {
    const source = 'source' in data ? parseAppSource(data.source) : null
    if ('source' in data) data.source = source ?? {}

    const kind = 'source' in data ? source?.kind : sourceKindOf(current?.source)
    const type = (data.type ?? current?.type ?? 'container') as string
    if (kind === 'inline' && type !== 'static')
      throw new BadRequest(
        `An inline source is served as files, so this app's type must be 'static' — it is '${type}'`)
  }

  async function assertEnvironmentInWorkspace(environmentId: string) {
    const env = await db().environment.findFirst({ where: { id: environmentId, workspaceId: ws() } })
    if (!env) throw new NotFound(`Environment '${environmentId}' not found in this workspace`)
  }

  // The detail read, shared by `get` and by every custom method that changes
  // the app's topology. A method that answered a bare row instead would hand
  // the screen a record with no `placement` key, and a client assigning that
  // over what it is rendering loses the section it just edited.
  async function detail(id: string) {
    const row = await db().app.findFirst({
      where:   { id, workspaceId: ws() },
      // The project too, for the screen's breadcrumb — an app's address is
      // project, then environment, and the list read has no use for it.
      include: { ...WITH_DETAIL, environment: { include: { project: true } } },
    })
    if (!row) throw new NotFound(`App '${id}' not found`)

    // What the detail screen needs and a list does not: where the replicas
    // landed, what has been released, and what runs on a schedule. Three
    // reads here rather than three round trips from the browser — the screen
    // is one question ("what is this app doing"), so it is one request.
    const [placement, deployments, jobs] = await Promise.all([
      db().appServer.findMany({ where: { appId: row.id }, include: { server: true } }),
      // Columns, not the row. `configSnapshot` holds an inline app's whole
      // source, so ten releases of a pasted page is ten copies of it on a
      // request that draws a ten-line table.
      db().deployment.findMany({
        where:   { appId: row.id },
        select:  { id: true, status: true, trigger: true, queuedAt: true, finishedAt: true,
                   durationMs: true, commitSha: true, commitMessage: true, branch: true,
                   author: true, builtImage: true, toImage: true, previousDeploymentId: true },
        orderBy: { queuedAt: 'desc' },
        limit:   10,
      }),
      db().job.findMany({ where: { appId: row.id }, orderBy: { createdAt: 'desc' }, limit: 10 }),
    ])

    return {
      ...row,
      domains: (row.domains ?? []).map((d: Record<string, unknown>) => ({ ...d, ...certStatusOf(d as never) })),
      sourceLabel: describeSource(row.source),
      placement,
      recent_deployments: deployments,
      jobs,
    }
  }

  return createService({
    name:  'apps',
    model: 'App',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    // `?serverId=` is not a column of App — a placement is an AppServer row —
    // so it is reserved rather than graded as a filter, and read below.
    reservedQuery: [...WORKSPACE_QUERY, 'serverId'],

    async find() {
      const { limit, offset } = getPagination()
      const serverId = $.reserved.serverId as string | undefined
      // Every filter the caller sent, not a chosen few. autoFilter has already
      // refused a key that is not a column, so a key it admitted and this body
      // skipped answered every row as a match: `?name=` or `?status=` came back
      // as the whole workspace.
      const { rows, total } = await db().app.findManyAndCount({
        where: {
          ...parseWhere($.query),
          workspaceId: ws(),
          ...(serverId ? { appServers: { some: { serverId } } } : {}),
        },
        include: WITH_DETAIL,
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })
      // See `summarizeSource`: a list says what each app's source is, the
      // detail read says what it holds.
      return { total, limit, offset, data: rows.map((r: any) => ({ ...r, source: summarizeSource(r.source), sourceLabel: describeSource(r.source) })) }
    },

    async get() {
      return detail($.id as string)
    },

    async create() {
      const data = $.data as Record<string, unknown>
      checkSource(data)
      await assertEnvironmentInWorkspace(data.environmentId as string)
      await assertSlugFree('app', { environmentId: data.environmentId, slug: data.slug },
        `App slug '${data.slug}' already exists in this environment`)

      const created = await db().app.create({ data })
      app.events.emit('app:created', {
        id: created.id, workspace_id: ws(), environment_id: created.environmentId, type: created.type,
      })
      return db().app.findFirst({ where: { id: created.id }, include: WITH_DETAIL })
    },

    async patch() {
      const current = await getScoped('app', 'App')
      // environmentId and slug are @immutable and status is @system — the
      // schema refuses all three by name, so nothing here restates them.
      const patch = narrowPatch($.data as Record<string, unknown>)
      checkSource(patch, current as Record<string, unknown>)
      if (!changesNothing(patch))
        await db().app.update({ where: { id: $.id as string }, data: patch })

      return db().app.findFirst({ where: { id: $.id as string }, include: WITH_DETAIL })
    },

    async remove() {
      const target = await getScoped('app', 'App')
      // Mark it stopped as well as deleted: a soft-deleted app that still reads
      // "running" would keep showing up as live in any status rollup.
      await db().app.update({ where: { id: $.id as string }, data: { status: 'stopped' }, system: ['status'] })

      // A container stops when nothing restarts it. FILES do not: an inline app
      // deleted here would go on serving its last release, at its own address,
      // to anybody who had the link — a row removed from a console and a page
      // still on the internet. So the machine is told, and a machine that
      // cannot be reached does not block the delete: the row is the operator's
      // decision and the retire is best effort, said in the log rather than
      // swallowed.
      if (sourceKindOf(target.source) === 'inline') {
        const executor = await resolveExecutor(app, target.id)
        if (isExecutor(executor)) {
          const reply = await executor.call('/static/retire', { app_id: target.id, slug: target.slug })
          if (reply.error)
            app.logger.warn(`app ${target.id} deleted, but the machine still serves it: ${reply.error.message}`)
        } else {
          app.logger.warn(`app ${target.id} deleted with no machine to retire it from: ${executor.reason}`)
        }
      }

      const removed = await removeScoped('app', 'App')
      app.events.emit('app:deleted', { id: $.id, workspace_id: ws() })
      return removed
    },


    // ── place / unplace — POST /apps/:id  X-Service-Method: place ─────
    //
    // Which machines an app runs on. Three jobs read `AppServer` and until
    // now nothing wrote one, so every app was placed nowhere and a deploy had
    // no machine to talk to — which is the state the deploy stub was hiding
    // (FJS-257).
    //
    // `AppServer` is `@@gate("2.8")`: readable by a member, writable only by a
    // system context. That is right — a placement is the app's topology, not a
    // row a caller edits — so the authority check is done here, against the
    // WORKSPACE, and the write goes through asSystem(). The second of the two
    // asSystem() calls in this file's realm; the other is the outpost heartbeat.

    // ─── logs ─────────────────────────────────────────────────────────────
    // What the container is saying, from a console rather than over ssh.
    //
    // The screen this feeds carried a comment saying its logs tab was absent
    // because *nothing stores or streams a log line* — true of the whole
    // fleet, not of that screen. `fli deploy:logs` answers the same question
    // for one app an operator is already sitting next to; this answers it for
    // a fleet somebody is looking after.
    //
    // A READ that leaves the process, so it goes through the executor like
    // every other machine call rather than reaching for a Conduit target by
    // hand — which is what keeps *who carries this out* a question with one
    // answer (`providers/executor.ts`).
    //
    // Scoped read first: `getScoped` proves the caller may see this app before
    // anything is asked of a machine on their behalf. Nothing is written, so
    // there is no audit event — the trail records writes, and a log read that
    // filed one would file one per poll.
    async logs() {
      const target = await getScoped('app', 'App')
      const data   = ($.data ?? {}) as Record<string, unknown>

      const executor = await resolveExecutor(app, target.id)
      // Not a 500: an app that is placed nowhere has no logs to give and that
      // is a state the operator can act on, which is what `reason` says.
      if (!isExecutor(executor))
        return { running: false, reason: executor.reason, stdout: '', stderr: '', serverId: null }

      const reply = await executor.call('/logs', {
        app_id: target.id,
        tail:   data.tail,
        since:  data.since,
      }, { timeoutMs: 20_000 })

      // The machine's own words. A generic failure here is how an operator ends
      // up ssh'ing to the box the console exists to replace.
      if (reply.error) throw new BadRequest(`Could not read logs: ${reply.error.message}`)

      const out = (reply.data ?? {}) as Record<string, unknown>
      return {
        running:  out.running ?? false,
        serverId: executor.serverId,
        tail:     out.tail  ?? null,
        since:    out.since ?? null,
        stdout:   out.stdout ?? '',
        stderr:   out.stderr ?? '',
        ...(out.error ? { reason: out.error } : {}),
      }
    },

    async place() {
      const data     = $.data as Record<string, unknown>
      const serverId = data.serverId as string | undefined
      if (!serverId) throw new BadRequest('place needs a serverId')

      const target = await getScoped('app', 'App')

      // Same workspace, and it must be a machine that can hold work. A
      // destroyed server still has a row, and placing on one produces a
      // deployment that can never resolve an executor.
      const server = await db().server.findFirst({ where: { id: serverId, workspaceId: ws() } })
      if (!server) throw new NotFound(`Server '${serverId}' not found in this workspace`)
      if (['destroyed', 'stopped'].includes(server.status))
        throw new BadRequest(`Cannot place an app on a ${server.status} server`)

      // The replica this placement is. Stated wins; otherwise the next free
      // index on this server, so placing twice adds a replica rather than
      // failing on the @@unique.
      const existing = await db().appServer.findMany({ where: { appId: target.id, serverId } })
      const replicaIndex = (data.replicaIndex as number | undefined)
        ?? existing.reduce((n: number, p: any) => Math.max(n, p.replicaIndex + 1), 0)

      if (existing.some((p: any) => p.replicaIndex === replicaIndex))
        throw new BadRequest(`Replica ${replicaIndex} of this app is already on '${server.name}'`)

      await $.db.asSystem().appServer.create({
        data: { appId: target.id, serverId, replicaIndex, status: 'unknown' },
      })

      return detail(target.id)
    },

    async unplace() {
      const data     = $.data as Record<string, unknown>
      const serverId = data.serverId as string | undefined
      if (!serverId) throw new BadRequest('unplace needs a serverId')

      const target = await getScoped('app', 'App')

      // Scoped read first, system write second: the caller proves they may see
      // this app before anything is removed on their behalf.
      const rows = await db().appServer.findMany({
        where: {
          appId: target.id, serverId,
          ...(data.replicaIndex !== undefined ? { replicaIndex: data.replicaIndex as number } : {}),
        },
      })
      if (!rows.length) throw new NotFound('This app is not placed on that server')

      const sys = $.db.asSystem()
      for (const row of rows) await sys.appServer.delete({ where: { id: row.id } })

      return detail(target.id)
    },

    hooks: {
      before: {
        all:    [sessionScope(app)],
        create: [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), deriveSlug],
        patch:  [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        // Topology, not content: the same authority that may patch the app.
        place:   [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        unplace: [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
      },
    },
  })
}
