// src/services/servers/servers.service.ts
// Server fleet — provisioned and imported machines.
//
// CRUD — mounted at /servers, NOT /api/servers. Junction mounts a service at
// /{name}; the /api prefix in the old header was aspirational and every path
// below it 404'd.
//   GET    /servers        → find
//   GET    /servers/:id    → get
//   POST   /servers        → create
//   PATCH  /servers/:id    → patch
//   DELETE /servers/:id    → remove
//
// Custom methods dispatch on the X-Service-Method HEADER, not a sub-path
// (DECISIONS.md). `POST /servers/:id/drain` is a 404; the call is
// `POST /servers/:id` with `X-Service-Method: drain`.
//   events · reboot · drain · undrain · sync
//   heartbeat — the agent's, HMAC at the transport, exempted from sessionScope
//
// The wire contract is the SCHEMA's field names, because autoValidate strips
// anything else: `ipAddress`, not `ip_address`. A snake_case key does not
// error — it silently vanishes and the column comes back null.
//
// ─── Data access ─────────────────────────────────────────────────────────
// Every read and write goes through the Litestone client. There is no raw SQL
// in this file, and adding some would reintroduce the drift that made the
// previous version unrunnable: it queried snake_case columns (`workspace_id`,
// `created_at`) and epoch-ms timestamps, neither of which the schema emits.
//
// The scoped helpers — dbOf / getScoped / findScoped / narrowPatch — come from
// core/resource.ts and are shared with the other six workspace-scoped services.
// This file used to carry its own copies of all of them, which meant the
// workspace clause was written out by hand here and could have been omitted in
// one method without any other service disagreeing. Add to the shared module,
// not beside it.
//
// `asSystem()` appears exactly once, in heartbeat, and is commented there.
//
// JSON columns (`plan`, `health`, `labels`, `dockerState`, `actualSpecs`,
// `metadata`) are `Json` in the schema, so the client hands back objects.
// The old parseServer()/parseEvent() JSON.parse helpers are gone — parsing an
// already-parsed object is how you get "[object Object]" in a column.

import { createService, NotFound, BadRequest, publishToChannels } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination } from '../../core/hooks.ts'
import {
  dbOf, wsOf, actorOf,
  findScoped, getScoped, assertSlugFree, stampWorkspace, narrowPatch,
} from '../../core/resource.ts'
import { envRef }                from '../../core/credentials.ts'
import type { BasecampApp }      from '../../basecamp.types.ts'
import type { ServiceContext }   from '@frontierjs/junction'
import type { TargetDescriptor } from '@frontierjs/conduit'

// ─── Types ───────────────────────────────────────────────────────────────

export interface HeartbeatData {
  agent_version: string
  health:        Record<string, unknown>
  specs?:        Record<string, unknown>
  docker?:       Record<string, unknown>
  agent_url?:    string
}

// ─── Factory ─────────────────────────────────────────────────────────────

export function createServersService(app: BasecampApp) {

  async function recordEvent(
    ctx:      ServiceContext,
    serverId: string,
    kind:     string,
    message:  string,
    metadata: Record<string, unknown> = {}
  ) {
    await dbOf(ctx).serverEvent.create({ data: { serverId, kind, message, metadata } })
  }

  /** Set status + record an event, the shape reboot/drain/undrain all share. */
  async function transition(
    ctx: ServiceContext,
    opts: { from: string[]; to: string; kind: string; message: string; verb: string }
  ) {
    const id     = ctx.id as string
    const server = await getScoped(ctx, 'server', 'Server')

    if (!opts.from.includes(server.status))
      throw new BadRequest(`Cannot ${opts.verb} a server with status '${server.status}'`)

    await dbOf(ctx).server.update({ where: { id }, data: { status: opts.to } })
    await recordEvent(ctx, id, opts.kind, opts.message, { requested_by: actorOf(ctx) })

    return getScoped(ctx, 'server', 'Server')
  }

  return createService({
    name:  'servers',
    model: 'Server',   // ← schema-derived validation; see note at the bottom

    // ── find ──────────────────────────────────────────────────────────
    async find(ctx: ServiceContext) {
      const status = ctx.query.status as string | undefined
      const role   = ctx.query.role   as string | undefined
      const search = ctx.query.search as string | undefined

      const where: Record<string, unknown> = {}
      if (status) where.status = status
      if (role)   where.role   = role
      if (search) where.name   = { contains: search }

      // findScoped merges workspaceId into the where-clause. Building it here
      // instead is the one place a filter set could ship without it.
      return findScoped(ctx, 'server', { where, ...getPagination(ctx) })
    },

    // ── get ───────────────────────────────────────────────────────────
    async get(ctx: ServiceContext) {
      return getScoped(ctx, 'server', 'Server')
    },

    // ── create ────────────────────────────────────────────────────────
    async create(ctx: ServiceContext) {
      const db   = dbOf(ctx)
      const data = ctx.data as Record<string, unknown>
      if (!data?.name?.toString().trim()) throw new BadRequest('name is required')

      // workspaceId and slug were stamped by stampWorkspace in before/create.
      const wsId = data.workspaceId as string
      const slug = data.slug        as string

      await assertSlugFree(ctx, 'server', { workspaceId: wsId, slug },
        `A server named '${slug}' already exists`)

      // ctx.data has already been through autoValidate(model, 'create'): unknown
      // keys are stripped and types are checked against the schema, so it is a
      // clean Server-shaped payload. Spreading it is the whole point of
      // `model: 'Server'` — every default this used to restate by hand
      // (status, role, providerKind, region, sshPort, sshUser, registerMethod,
      // plan, labels) is declared in schema.lite and applied by the client.
      //
      // Corollary: the wire contract is the SCHEMA's field names. `ipAddress`,
      // not `ip_address` — a snake_case key is silently stripped and the column
      // comes back null.
      const server = await db.server.create({ data })

      await recordEvent(ctx, server.id, 'created', 'Server registered', { created_by: actorOf(ctx) })
      return server
    },

    // ── patch ─────────────────────────────────────────────────────────
    async patch(ctx: ServiceContext) {
      const id = ctx.id as string
      await getScoped(ctx, 'server', 'Server')   // 404s outside the caller's workspace

      // autoValidate(model, 'patch') has already stripped unknown keys and
      // checked types, so ctx.data is a partial Server. narrowPatch drops the
      // rest — a client must not move a server between workspaces, rewrite its
      // slug, or set status behind the drain/reboot transitions.
      const patch = narrowPatch(ctx.data as Record<string, unknown>, ['slug', 'status'])

      if (!Object.keys(patch).length) return getScoped(ctx, 'server', 'Server')

      // updatedAt is a schema trigger — setting it here would fight the DB.
      return dbOf(ctx).server.update({ where: { id }, data: patch })
    },

    // ── remove ────────────────────────────────────────────────────────
    async remove(ctx: ServiceContext) {
      const id     = ctx.id as string
      const server = await getScoped(ctx, 'server', 'Server')

      if (server.status === 'online')
        throw new BadRequest('Cannot remove an online server — drain it first')

      // remove() is the soft delete (schema has @@softDelete); delete() would
      // be the hard one. The row stays, stamped, and drops out of every read.
      const removed = await dbOf(ctx).server.remove({ where: { id } })
      await recordEvent(ctx, id, 'removed', 'Server removed', { removed_by: actorOf(ctx) })
      return Array.isArray(removed) ? removed[0] : removed
    },

    // ── events — POST /servers/:id  X-Service-Method: events ──────────
    async events(ctx: ServiceContext) {
      const id = ctx.id as string
      await getScoped(ctx, 'server', 'Server')   // ownership check

      const { limit, offset } = getPagination(ctx, { limit: 50 })
      const kind = ctx.query.kind as string | undefined

      return dbOf(ctx).serverEvent.findMany({
        where:   { serverId: id, ...(kind ? { kind } : {}) },
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })
    },

    // ── feed — POST /servers  X-Service-Method: feed ──────────────────
    // The whole fleet's event stream, in one request.
    //
    // `events` above is per-server, which is right for a server's own screen
    // and wrong for everything else: any screen wanting what the FLEET has been
    // doing had to make one request per server and merge them in the browser
    // (`FJS-104`). `/activity/` therefore covered the audit trail only — a
    // record of what PEOPLE did — while the mock's feed is mostly what the
    // machines did.
    //
    // `ServerEvent` has no `workspaceId` of its own, deliberately: an event is
    // meaningless without its server, and denormalising the workspace onto it
    // would be a second owner of the tenancy fact. So the scope is a join —
    // the server ids in this workspace, then the events on them. Two queries,
    // both indexed, instead of N+1 over the network.
    async feed(ctx: ServiceContext) {
      ctx.dispatch = false   // read-shaped
      const { limit, offset } = getPagination(ctx, { limit: 50, max: 200 })
      const kind = ctx.query.kind as string | undefined

      const servers = await dbOf(ctx).server.findMany({
        where:  { workspaceId: wsOf(ctx) },
        select: { id: true, name: true },
        limit:  500,
      })
      if (!servers.length) return { total: 0, limit, offset, data: [] }

      const byId = new Map(servers.map((s: { id: string; name: string }) => [s.id, s.name]))
      const { rows, total } = await dbOf(ctx).serverEvent.findManyAndCount({
        where:   { serverId: { in: [...byId.keys()] }, ...(kind ? { kind } : {}) },
        orderBy: { createdAt: 'desc' },
        limit, offset,
      })

      // The server's NAME, resolved here rather than by the browser. A feed of
      // "server 4f3a-… rebooted" is a feed nobody reads, and the alternative
      // is an `include` that ships the whole server row per event.
      return {
        total, limit, offset,
        data: rows.map((e: Record<string, unknown>) => ({ ...e, serverName: byId.get(e.serverId as string) ?? null })),
      }
    },

    // ── reboot / drain / undrain ──────────────────────────────────────
    reboot: (ctx: ServiceContext) => transition(ctx, {
      from: ['online', 'unreachable'], to: 'pending',
      kind: 'reboot_requested', message: 'Reboot requested', verb: 'reboot',
    }),

    drain: (ctx: ServiceContext) => transition(ctx, {
      from: ['online'], to: 'draining',
      kind: 'drain_started', message: 'Server drain initiated', verb: 'drain',
    }),

    undrain: (ctx: ServiceContext) => transition(ctx, {
      from: ['draining'], to: 'online',
      kind: 'drain_cancelled', message: 'Server drain cancelled', verb: 'undrain',
    }),

    // ── sync — POST /servers/:id  X-Service-Method: sync ─────────────
    async sync(ctx: ServiceContext) {
      const id     = ctx.id as string
      const server = await getScoped(ctx, 'server', 'Server')

      await recordEvent(ctx, id, 'sync_requested', 'Status sync requested', { requested_by: actorOf(ctx) })

      if (server.providerKind && server.providerKind !== 'custom') {
        const targetId = `provider:${server.providerKind}`
        const result   = await app.conduit.send({
          target:  targetId,
          method:  'GET',
          path:    `/servers/${server.providerServerId}`,
          headers: { 'x-basecamp-server-id': id },
        })

        if (result.error) {
          if (result.error.kind === 'target_not_found') {
            app.logger.warn('conduit: provider target not registered', { target: targetId, server_id: id })
          } else {
            app.logger.error('conduit: provider sync failed', { target: targetId, kind: result.error.kind })
          }
        } else {
          const providerData = result.data as Record<string, unknown> | null
          if (providerData?.status) {
            const statusMap: Record<string, string> = {
              running: 'online', off: 'stopped', rebuilding: 'provisioning',
              starting: 'provisioning', stopping: 'stopped', deleting: 'destroyed',
            }
            const newStatus = statusMap[providerData.status as string] ?? server.status
            if (newStatus !== server.status) {
              await dbOf(ctx).server.update({ where: { id }, data: { status: newStatus } })
              await recordEvent(ctx, id, 'status_synced', `Status synced from provider: ${newStatus}`,
                { provider_status: providerData.status })
            }
          }
        }
      } else {
        app.logger.debug('conduit: sync skipped — no provider configured', { server_id: id })
      }

      return getScoped(ctx, 'server', 'Server')
    },

    // ── heartbeat — POST /servers/:id  X-Service-Method: heartbeat ────
    // Called by the Basecamp agent, which holds no session — it authenticates
    // by HMAC at the transport. asSystem() is therefore the correct client
    // here and NOT a shortcut: there is no user to scope to, and the request
    // legitimately writes to a server in any workspace.
    async heartbeat(ctx: ServiceContext) {
      // Typed the same way dbOf() types the scoped client: the Litestone
      // accessors have no generated types yet (`litestone types` is pending),
      // so every `sys.server` read is otherwise `unknown` and each one is its
      // own diagnostic.
      const sys  = app.data.asSystem() as any
      const id   = ctx.id as string
      const data = ctx.data as HeartbeatData

      const server = await sys.server.findUnique({ where: { id } })
      if (!server) throw new NotFound(`Server '${id}' not found`)

      // The after-hook publishes to `workspace:${ctx.locals.workspaceId}`, and
      // sessionScope — the hook that normally sets it — deliberately skips
      // heartbeat, because an agent carries no session and no workspace header.
      // So every check-in published to nothing: the one update in this app that
      // arrives without a person clicking was the one nobody could see.
      //
      // The server itself knows which workspace it is in, and that is the
      // correct answer regardless of who called: the event belongs to the
      // machine's workspace, not the caller's.
      ctx.locals.workspaceId = server.workspaceId

      const now = new Date().toISOString()
      const transitionStates = new Set(['pending', 'installing', 'unreachable'])
      const newStatus = transitionStates.has(server.status) ? 'online' : server.status

      // Capture the updated row: it is both this method's answer and the
      // payload the channel publishes. Answering `{ ok, server_id, status }`
      // instead — as this used to — gives a subscriber a shape with no `id`,
      // so a client merging the event into the row it is rendering cannot even
      // find the row. Same trap `setVariable` had, and the deployment engine's
      // projection before it: a partial row is indistinguishable from a full
      // one until it breaks.
      const updated = await sys.server.update({
        where: { id },
        data: {
          status:          newStatus,
          agentVersion:    data.agent_version,
          health:          { ...data.health, checked_at: now },
          lastHeartbeatAt: now,
          // Only overwrite when the agent actually reported — the old SQL used
          // COALESCE(?, col) for exactly this.
          ...(data.specs  ? { actualSpecs: data.specs  } : {}),
          ...(data.docker ? { dockerState: data.docker } : {}),
        },
      })

      if (newStatus !== server.status) {
        await sys.serverEvent.create({
          data: { serverId: id, kind: 'came_online', message: 'Agent connected',
                  metadata: { agent_version: data.agent_version } },
        })
      }

      // The agent as a Conduit target — the address anything outbound reaches
      // this machine at, and what `volumes.remove` refuses to act without.
      //
      // Keyed on the URL, NOT on the status transition it used to sit inside.
      // A machine that is already online when its agent first reports a URL —
      // or that moves address without going unreachable in between — never
      // transitions, so it was never registered, and every outbound call to it
      // failed as `target_not_found` while the server screen showed it healthy.
      const target = `agent:${id}`
      const known  = await app.conduit.resolve(target).catch(() => null)

      if (data.agent_url && known?.address !== data.agent_url) {
        await app.conduit.register({
          id:            target,
          kind:          'agent',
          protocol:      'http',
          address:       data.agent_url,
          // A REF, resolved at send time. This carried the secret itself
          // (`{ secret: … }`) until 2026-08-09, which was wrong twice: conduit's
          // hmac signer reads `ref` and nothing else, so every outbound call to
          // an agent failed `auth_failed` naming credential `undefined`; and the
          // material was written into the registry, where `GET /conduit-targets`
          // hands it back. Nothing had ever sent to an agent, so neither showed.
          auth:          { type: 'hmac', ref: envRef('AGENT_SECRET') },
          registered_at: Date.now(),
          last_seen_at:  Date.now(),
        } as TargetDescriptor)
        app.logger.info('conduit: agent registered', { server_id: id, url: data.agent_url })
      } else if (known) {
        // Touch last_seen_at on every other heartbeat (non-critical).
        app.conduit.register({ ...known, last_seen_at: Date.now() }).catch(() => {})
      }

      return updated
    },

    hooks: {
      before: {
        // heartbeat is the agent's endpoint — no session, HMAC at the
        // transport. It must be exempted HERE; a comment on the method is not
        // an exemption, and it used to 401 every check-in.
        all:       [sessionScope(app, { except: ['heartbeat'] })],
        create:    [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), stampWorkspace],
        patch:     [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove:    [requireWorkspaceRole(app, 'admin', 'owner')],
        reboot:    [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        drain:     [requireWorkspaceRole(app, 'admin', 'owner')],
        undrain:   [requireWorkspaceRole(app, 'admin', 'owner')],
        sync:      [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        // heartbeat: HMAC auth at Conduit transport level — no session hook
      },
      after: {
        all: [publishToChannels(workspaceChannel(app))],
      },
    },
  })
}
