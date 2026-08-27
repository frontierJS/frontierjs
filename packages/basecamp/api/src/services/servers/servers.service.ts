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
//   heartbeat — the outpost's, HMAC at the transport, exempted from sessionScope
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
// The scoped helpers — getScoped / findScoped / narrowPatch, changesNothing — come from
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

import { createService, NotFound, BadRequest, normalizeOrderBy, $ } from '@frontierjs/junction'
import type { SortParam } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, internalOnly, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws, actor, findScoped, getScoped, assertSlugFree, deriveSlug, narrowPatch, changesNothing } from '../../core/resource.ts'
import { envRef }                from '../../core/credentials.ts'
import type { BasecampApp }      from '../../basecamp.types.ts'
import type { TargetDescriptor } from '@frontierjs/conduit'

// ─── Types ───────────────────────────────────────────────────────────────

export interface HeartbeatData {
  outpost_version: string
  health:        Record<string, unknown>
  specs?:        Record<string, unknown>
  docker?:       Record<string, unknown>
  outpost_url?:    string
}

// What a provider's own word for a state means here, as a NAMED MOVE rather
// than a target value. The move is what `@@transitions` declares, so the
// from-list that decides whether the report may be acted on lives in the
// schema with every other one — this table only translates vocabulary.
//
// Two provider words share a move on purpose: `starting` and `rebuilding` are
// both `provisioning` here, and `stopping` lands on `stopped` because a machine
// on its way down is not one basecamp should route work to.
const PROVIDER_MOVES: Record<string, string> = {
  running:    'reportRunning',
  off:        'reportStopped',
  stopping:   'reportStopped',
  rebuilding: 'reportRebuilding',
  starting:   'reportRebuilding',
  deleting:   'reportDestroyed',
}

// Where each of those moves lands. Only for the sentence in the event and for
// the already-there check — the write reads the target out of the schema.
const PROVIDER_TARGET: Record<string, string> = {
  reportRunning:    'online',
  reportStopped:    'stopped',
  reportRebuilding: 'provisioning',
  reportDestroyed:  'destroyed',
}

// ─── Factory ─────────────────────────────────────────────────────────────

export function createServersService(app: BasecampApp) {

  async function recordEvent(
    serverId: string,
    kind:     string,
    message:  string,
    metadata: Record<string, unknown> = {}
  ) {
    await db().serverEvent.create({ data: { serverId, kind, message, metadata } })
  }

  /**
   * Make a named move, then record it — the shape reboot/drain/undrain share.
   *
   * The from-list and the level both live in `@@transitions(status, …)` on
   * `model Server`, so this function decides neither. What it used to do was
   * read the row, compare the status against a list written here, and write in
   * a second statement — three properties hand-rolled, and the last one wrong:
   * two concurrent drains both read `online`, both passed and both wrote.
   * `transition()` narrows the UPDATE's own WHERE to the from-state, so the
   * loser gets a retryable `TransitionConflictError` instead of nothing.
   *
   * `getScoped` still leads, and it is not a duplicate of the from-check: it is
   * the ownership check. Without it a caller naming a server in another
   * workspace would get a transition error rather than a 404 — a state oracle
   * over a row they may not read.
   */
  async function transition(opts: { name: string; kind: string; message: string }) {
    const id = $.id as string
    await getScoped('server', 'Server')   // 404s outside the caller's workspace

    const moved = await db().server.transition(id, opts.name)
    await recordEvent(id, opts.kind, opts.message, { requested_by: actor() })

    return moved
  }

  return createService({
    name:  'servers',
    model: 'Server',   // ← schema-derived validation; see note at the bottom
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    // ── find ──────────────────────────────────────────────────────────
    async find() {
      const status = $.query.status as string | undefined
      const role   = $.query.role   as string | undefined
      const search = $.query.search as string | undefined

      const where: Record<string, unknown> = {}
      if (status) where.status = status
      if (role)   where.role   = role
      if (search) where.name   = { contains: search }

      // `$orderBy` is honoured rather than ignored: this list is sorted from the
      // URL, so the order has to survive a reload and a pasted link like every
      // other part of the query. autoSort has already run — it validates the
      // key against the schema and answers a 400 naming it — but it leaves the
      // value RAW, so the parse is junction's own `normalizeOrderBy` rather
      // than a second reading of the same three spellings written here.
      //
      // findScoped merges workspaceId into the where-clause. Building it here
      // instead is the one place a filter set could ship without it.
      const sort = $.directives?.orderBy
      return findScoped('server', {
        where,
        ...getPagination(),
        ...(sort ? { orderBy: normalizeOrderBy(sort as SortParam) } : {}),
      })
    },

    // ── get ───────────────────────────────────────────────────────────
    async get() {
      return getScoped('server', 'Server')
    },

    // ── create ────────────────────────────────────────────────────────
    async create() {
      const data = $.data as Record<string, unknown>
      if (!data?.name?.toString().trim()) throw new BadRequest('name is required')

      // The slug was derived by deriveSlug in before/create. `workspaceId` is
      // not read here and is not in the uniqueness clause: the declaration
      // stamps the column at the Data boundary and scopes this `exists` to the
      // caller's own tenant, so a name is unique within a workspace for free.
      const slug = data.slug as string

      await assertSlugFree('server', { slug },
        `A server named '${slug}' already exists`)

      // $.data has already been through autoValidate(model, 'create'): unknown
      // keys are stripped and types are checked against the schema, so it is a
      // clean Server-shaped payload. Spreading it is the whole point of
      // `model: 'Server'` — every default this used to restate by hand
      // (status, role, providerKind, region, sshPort, sshUser, registerMethod,
      // plan, labels) is declared in schema.lite and applied by the client.
      //
      // Corollary: the wire contract is the SCHEMA's field names. `ipAddress`,
      // not `ip_address` — a snake_case key is silently stripped and the column
      // comes back null.
      const server = await db().server.create({ data })

      await recordEvent(server.id, 'created', 'Server registered', { created_by: actor() })
      return server
    },

    // ── patch ─────────────────────────────────────────────────────────
    async patch() {
      const id = $.id as string
      await getScoped('server', 'Server')   // 404s outside the caller's workspace

      // autoValidate(model, 'patch') has already stripped unknown keys and
      // checked types, so $.data is a partial Server. narrowPatch drops the
      // rest — a client must not move a server between workspaces, rewrite its
      // slug, or set status behind the drain/reboot transitions.
      const patch = narrowPatch($.data as Record<string, unknown>, ['slug', 'status'])

      if (changesNothing(patch)) return getScoped('server', 'Server')

      // updatedAt is a schema trigger — setting it here would fight the DB.
      return db().server.update({ where: { id }, data: patch })
    },

    // ── remove ────────────────────────────────────────────────────────
    async remove() {
      const id     = $.id as string
      const server = await getScoped('server', 'Server')

      if (server.status === 'online')
        throw new BadRequest('Cannot remove an online server — drain it first')

      // remove() is the soft delete (schema has @@softDelete); delete() would
      // be the hard one. The row stays, stamped, and drops out of every read.
      const removed = await db().server.remove({ where: { id } })
      await recordEvent(id, 'removed', 'Server removed', { removed_by: actor() })
      return Array.isArray(removed) ? removed[0] : removed
    },

    // ── events — POST /servers/:id  X-Service-Method: events ──────────
    async events() {
      const id = $.id as string
      await getScoped('server', 'Server')   // ownership check

      const { limit, offset } = getPagination({ limit: 50 })
      const kind = $.query.kind as string | undefined

      return db().serverEvent.findMany({
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
    async feed() {
      $.dispatch = false   // read-shaped
      const { limit, offset } = getPagination({ limit: 50, max: 200 })
      const kind = $.query.kind as string | undefined

      const servers = await db().server.findMany({
        where:  { workspaceId: ws() },
        select: { id: true, name: true },
        limit:  500,
      })
      if (!servers.length) return { total: 0, limit, offset, data: [] }

      const byId = new Map(servers.map((s: { id: string; name: string }) => [s.id, s.name]))
      const { rows, total } = await db().serverEvent.findManyAndCount({
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
    // Each names a move the schema declares. What is legal from where, and who
    // may make it, is `@@transitions` on `model Server` — there is no from-list
    // and no role hook here, because two statements of one rule is how the
    // browser's copy of these lists went stale.
    reboot: () => transition({
      name: 'reboot',
      kind: 'reboot_requested', message: 'Reboot requested',
    }),

    drain: () => transition({
      name: 'drain',
      kind: 'drain_started', message: 'Server drain initiated',
    }),

    undrain: () => transition({
      name: 'undrain',
      kind: 'drain_cancelled', message: 'Server drain cancelled',
    }),

    // ── sync — POST /servers/:id  X-Service-Method: sync ─────────────
    async sync() {
      const id     = $.id as string
      const server = await getScoped('server', 'Server')

      await recordEvent(id, 'sync_requested', 'Status sync requested', { requested_by: actor() })

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
          const reported     = providerData?.status as string | undefined
          const move         = reported ? PROVIDER_MOVES[reported] : undefined

          if (reported && move && PROVIDER_TARGET[move] !== server.status) {
            // Ask the machine rather than write the value. `transitions(row)`
            // returns exactly the moves legal from where this row IS, so a
            // provider reporting `running` for a machine we are DRAINING is
            // simply not in the list — where the old status map wrote it and
            // silently undid the drain. A report we cannot act on is recorded
            // rather than swallowed: an operator looking at a row that
            // disagrees with the provider needs to see why.
            // Membership in the list is the question — it holds exactly the
            // moves legal from where this row IS. `allowed` is a different
            // question and is deliberately not consulted: these moves are
            // `@system`, so it reads false for every caller, and the
            // application is about to make it AS the application.
            const legal = (await db().server.transitions(server))
              .some((t: { name: string }) => t.name === move)

            if (legal) {
              // `{ system: true }` names the column on the write, which is what
              // the `@system` on these moves requires. Not `asSystem()`: the
              // caller pressed a button, and the gate, the row policies and the
              // audit actor all still apply to them.
              await db().server.transition(id, move, { system: true })
              await recordEvent(id, 'status_synced',
                `Status synced from provider: ${PROVIDER_TARGET[move]}`,
                { provider_status: reported })
            } else {
              await recordEvent(id, 'status_sync_ignored',
                `Provider reports '${reported}' — a server at '${server.status}' does not move to '${PROVIDER_TARGET[move]}'`,
                { provider_status: reported, server_status: server.status })
            }
          }
        }
      } else {
        app.logger.debug('conduit: sync skipped — no provider configured', { server_id: id })
      }

      return getScoped('server', 'Server')
    },

    // ── heartbeat — POST /servers/:id  X-Service-Method: heartbeat ────
    // Called by the Basecamp outpost, which holds no session — it authenticates
    // by HMAC at the transport. asSystem() is therefore the correct client
    // here and NOT a shortcut: there is no user to scope to, and the request
    // legitimately writes to a server in any workspace.
    async heartbeat() {
      // Typed the same way `db()` is: the Litestone
      // accessors have no generated types yet (`litestone types` is pending),
      // so every `sys.server` read is otherwise `unknown` and each one is its
      // own diagnostic.
      const sys  = $.db.asSystem() as any
      const id   = $.id as string
      const data = $.data as HeartbeatData

      const server = await sys.server.findUnique({ where: { id } })
      if (!server) throw new NotFound(`Server '${id}' not found`)

      // The after-hook publishes to `workspace:${$.locals.workspaceId}`, and
      // sessionScope — the hook that normally sets it — deliberately skips
      // heartbeat, because an outpost carries no session and no workspace header.
      // So every check-in published to nothing: the one update in this app that
      // arrives without a person clicking was the one nobody could see.
      //
      // The server itself knows which workspace it is in, and that is the
      // correct answer regardless of who called: the event belongs to the
      // machine's workspace, not the caller's.
      $.locals.workspaceId = server.workspaceId

      const now = new Date().toISOString()

      // `checkIn` is declared `@system`: the move is the machine's, not a
      // person's. It is still written as one column of ONE update rather than
      // through `transition()`, because splitting it out would write the row
      // twice and announce it twice for a single check-in — and `asSystem()` is
      // right here for the reason it usually is not, since a heartbeat has no
      // caller at all.
      //
      // What that costs is enforcement: a system client bypasses the machine.
      // So the from-set is ASKED of the schema rather than kept beside it —
      // `transitions(row)` answers exactly the moves legal from where this row
      // is, off the row already in hand. It used to be a `Set` here with a
      // comment saying the two had to agree, which is the duplication
      // `@@transitions` exists to delete.
      const canCheckIn = (await sys.server.transitions(server))
        .some((t: { name: string }) => t.name === 'checkIn')
      const newStatus = canCheckIn ? 'online' : server.status

      // Capture the updated row: it is both this method's answer and the
      // payload the channel publishes. Answering `{ ok, server_id, status }`
      // instead — as this used to — gives a subscriber a shape with no `id`,
      // so a client merging the event into the row it is rendering cannot even
      // find the row. Same trap `setVariable` had, and the deploy job's
      // projection before it: a partial row is indistinguishable from a full
      // one until it breaks.
      const updated = await sys.server.update({
        where: { id },
        data: {
          status:          newStatus,
          outpostVersion:    data.outpost_version,
          health:          { ...data.health, checked_at: now },
          lastHeartbeatAt: now,
          // Only overwrite when the outpost actually reported — the old SQL used
          // COALESCE(?, col) for exactly this.
          ...(data.specs  ? { actualSpecs: data.specs  } : {}),
          ...(data.docker ? { dockerState: data.docker } : {}),
        },
      })

      if (newStatus !== server.status) {
        await sys.serverEvent.create({
          data: { serverId: id, kind: 'came_online', message: 'Outpost connected',
                  metadata: { outpost_version: data.outpost_version } },
        })
      }

      // The outpost as a Conduit target — the address anything outbound reaches
      // this machine at, and what `volumes.remove` refuses to act without.
      //
      // Keyed on the URL, NOT on the status transition it used to sit inside.
      // A machine that is already online when its outpost first reports a URL —
      // or that moves address without going unreachable in between — never
      // transitions, so it was never registered, and every outbound call to it
      // failed as `target_not_found` while the server screen showed it healthy.
      const target = `outpost:${id}`
      const known  = await app.conduit.resolve(target).catch(() => null)

      if (data.outpost_url && known?.address !== data.outpost_url) {
        await app.conduit.register({
          id:            target,
          kind:          'outpost',
          protocol:      'http',
          address:       data.outpost_url,
          // A REF, resolved at send time. This carried the secret itself
          // (`{ secret: … }`) until 2026-08-09, which was wrong twice: conduit's
          // hmac signer reads `ref` and nothing else, so every outbound call to
          // an outpost failed `auth_failed` naming credential `undefined`; and the
          // material was written into the registry, where `GET /conduit-targets`
          // hands it back. Nothing had ever sent to an outpost, so neither showed.
          auth:          { type: 'hmac', ref: envRef('OUTPOST_SECRET') },
          registered_at: Date.now(),
          last_seen_at:  Date.now(),
        } as TargetDescriptor)
        app.logger.info('conduit: outpost registered', { server_id: id, url: data.outpost_url })
      } else if (known) {
        // Touch last_seen_at on every other heartbeat (non-critical).
        app.conduit.register({ ...known, last_seen_at: Date.now() }).catch(() => {})
      }

      return updated
    },


    // ── logEvent — a line in one machine's history, written by a job ──
    //
    // `recipe:run` and `cleanup:run` used to write this straight through
    // `asSystem()` (`FJS-384`). They run as whoever asked for the work now, and
    // `ServerEvent` is create-at-USER — so the create goes through the CALLER's
    // client, which is both the standing and the confinement: an event against
    // a machine in another workspace is refused rather than written.
    //
    // `internalOnly`: the event trail is what an operator reads to find out
    // what actually happened, and a caller writing their own lines into it is
    // the one thing it must not allow.
    async logEvent() {
      const { kind, message, metadata } = ($.data ?? {}) as {
        kind: string; message: string; metadata?: Record<string, unknown>
      }
      await recordEvent(String($.id), kind, message, metadata ?? {})
      return { serverId: String($.id), kind }
    },

    hooks: {
      before: {
        // heartbeat is the outpost's endpoint — no session, HMAC at the
        // transport. It must be exempted HERE; a comment on the method is not
        // an exemption, and it used to 401 every check-in.
        all:       [sessionScope(app, { except: ['heartbeat'] })],
        create:    [requireWorkspaceRole(app, 'developer', 'admin', 'owner'), deriveSlug],
        patch:     [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        remove:    [requireWorkspaceRole(app, 'admin', 'owner')],
        // reboot / drain / undrain carry NO role hook. Each is one named move
        // and the authority for it is `@gate(N)` on that move in the schema —
        // drain and undrain at ADMINISTRATOR(5), reboot at the model's own
        // update level. A hook here would be the same sentence twice, and the
        // one in the seed is the one `db/access.snapshot.md` can see.
        sync:      [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        logEvent:  [internalOnly()],
        // heartbeat: HMAC auth at Conduit transport level — no session hook
      },
    },
  })
}
