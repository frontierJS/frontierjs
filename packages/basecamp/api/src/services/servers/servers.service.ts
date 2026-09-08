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

import { createService, NotFound, BadRequest, normalizeOrderBy, seriesKey, isStale, $ } from '@frontierjs/junction'
import type { SortParam } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, internalOnly, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws, actor, findScoped, getScoped, assertSlugFree, deriveSlug, narrowPatch, changesNothing, slugify } from '../../core/resource.ts'
import { envRef }                from '../../core/credentials.ts'
import { recordHealth, SERVER_SERIES, SERVER_READINGS } from '../../core/server-metrics.ts'
import { connectorFor, targetFor, computeProviders, machineTags, FLEET_TAG } from '../../providers/compute/index.ts'
import { sendVia }               from '../../providers/compute/accounts.ts'
import { mintEnrollToken, cloudInit } from '../../providers/compute/enrollment.ts'
import { env }                   from '../../core/env.ts'
import type { BasecampApp }      from '../../basecamp.types.ts'
import type { TargetDescriptor } from '@frontierjs/conduit'
import type { ProviderKind }     from '../../../../db/schema.d.ts'

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

    // Declared because `heartbeat` has to be, and a `methods:` list is the
    // whole surface or it is a narrowing — so every verb this service answers
    // is named here. `gate: 0` on the heartbeat is the outpost: it holds no
    // session and authenticates by HMAC at the transport, so the read-gate
    // floor a custom method otherwise takes would refuse the one caller it is
    // for (`FJS-826`). The signature is what guards it, and it is checked
    // before this service is reached.
    methods: [
      // `update` and `restore` are the BASE's, written nowhere in this file — a
      // `methods:` list is the whole surface, so leaving them out silently
      // stopped answering them. `surface.snapshot.md` is what caught it.
      'find', 'get', 'create', 'update', 'patch', 'remove', 'restore',
      'events', 'feed', 'sync', 'logEvent', 'metrics',
      'reboot', 'drain', 'undrain',
      // Both read a vendor rather than a row. They take the model's own read
      // gate, because what they disclose is a price list and the NAMES of this
      // workspace's accounts — never a token, which is `@encrypted` and absent
      // from the row `providers` reads.
      'catalog', 'providers',
      // `provision` is a person spending money; `provisionStep` is the job it
      // dispatched, and is internalOnly.
      'provision', 'provisionStep',
      // `destroy` is a person, with a typed confirmation; `destroyStep` is the
      // job. `reconcile` reads a cloud and writes nothing.
      'destroy', 'destroyStep', 'reconcile',
      { method: 'heartbeat', gate: 0 },
    ],

    // ── find ──────────────────────────────────────────────────────────
    async find() {
      const status = $.query.status as string | undefined
      const role   = $.query.role   as string | undefined
      const search = $.query.search as string | undefined

      const where: Record<string, unknown> = {}
      if (status) where.status = status
      if (role)   where.role   = role
      if (search) where.name   = { contains: search }

      // `$orderBy` is honored rather than ignored: this list is sorted from the
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
    // meaningless without its server, and denormalizing the workspace onto it
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

      const connector = connectorFor(server.providerKind)

      // Three ways there is nothing to ask, and they are different sentences.
      // A machine somebody else made has no vendor; a vendor with no connector
      // is a key this app cannot spend; an account that was never recorded is
      // the row half-filled. Each is recorded on the machine's own trail,
      // because *Sync* answering nothing at all is what sent an operator to the
      // logs (`FJS-743`'s shape).
      if (!connector) {
        if (server.providerKind && server.providerKind !== 'custom')
          await recordEvent(id, 'sync_unsupported',
            `Basecamp has no connector for ${server.providerKind}`, {})
      } else if (!server.providerId) {
        await recordEvent(id, 'sync_no_account',
          'This machine names no provider account, so there is no token to ask with', {})
      } else {
        const targetId = targetFor(connector.kind, server.providerId as string)
        const send     = sendVia(app, targetId)

        let reportedMachine: Awaited<ReturnType<typeof connector.machine>> = null
        let failed: string | null = null

        try {
          reportedMachine = await connector.machine(send, String(server.providerServerId ?? ''))
        } catch (err) {
          failed = String(err)
        }

        if (failed) {
          app.logger.error('conduit: provider sync failed', { target: targetId, server_id: id, error: failed })
          await recordEvent(id, 'sync_failed', `Could not read this machine from ${connector.label}`,
            { target: targetId })
        } else {
          // A vendor that no longer has the machine is an ANSWER and is the one
          // report that arrives as an absence — `deleting` is what it means
          // here, so it goes through the same table every other word does.
          const reported = reportedMachine ? reportedMachine.status : 'deleting'
          const move     = reported === 'unknown' ? undefined : PROVIDER_MOVES[reported]

          if (reported === 'unknown')
            await recordEvent(id, 'sync_unrecognized',
              `${connector.label} reported a state this app does not recognize`, {})

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

          // The vendor's own answer about where the machine IS. Recorded on the
          // row because an address that moved is the commonest reason a
          // previously reachable machine stops answering, and the operator
          // reading this screen has no other way to find out.
          if (reportedMachine?.ipAddress && reportedMachine.ipAddress !== server.ipAddress)
            await db().server.update({
              where: { id },
              data:  { ipAddress: reportedMachine.ipAddress, version: server.version },
            })
        }
      }

      return getScoped('server', 'Server')
    },

    // ── provision — POST /servers  X-Service-Method: provision ───────
    //
    // Ask a cloud for a machine that does not exist yet.
    //
    // The ROW IS WRITTEN FIRST, at `provisioning`, and the vendor is called by
    // a job. That order is the whole design: a create that called the cloud
    // first and crashed before writing would leave a machine nobody here can
    // name, and the row is what the enrollment token, the tag and every later
    // step hang off.
    //
    // `@gate(5)` on the `provision` move is the authority — no role hook here,
    // for the reason `drain` and `undrain` have none: the schema says it in the
    // place `db/access.snapshot.md` prints.
    async provision() {
      const data = ($.data ?? {}) as Record<string, unknown>
      const { name, role, accountId, region, size, image } = data as Record<string, string>

      for (const [key, value] of Object.entries({ name, accountId, region, size, image }))
        if (!value) throw new BadRequest(`${key} is required to provision a machine`)

      const account = await db().secret.findFirst({ where: { id: accountId } })
      if (!account) throw new NotFound(`Provider account '${accountId}' not found`)

      const connector = connectorFor(account.providerKind as ProviderKind | null)
      if (!connector)
        throw new BadRequest(`'${account.name}' is not an account at a cloud Basecamp can speak to`)

      // The catalog is read HERE, before anything is written, for two reasons
      // that are one call. A size the vendor does not offer is refused with a
      // sentence this app wrote, at the moment somebody asked, rather than
      // inside a job where the failure is a row stuck at `provisioning` and a
      // vendor's own wording in a log.
      //
      // And the PRICE is the vendor's. `/cloud-spend/` reports what a fleet
      // costs, so the number behind it may not be one a caller sent: a client
      // that posted `priceMinor` would be reporting its own arithmetic back to
      // the person paying the bill. One extra call per provision, on a path
      // that is already asking a cloud to build a computer.
      const catalog = await connector.catalog(sendVia(app, targetFor(connector.kind, account.id)))
      const chosen  = catalog.sizes.find(s => s.slug === size)
      if (!chosen)
        throw new BadRequest(
          `'${size}' is not a size ${connector.label} offers this account`)
      if (chosen.regions.length && !chosen.regions.includes(String(region)))
        throw new BadRequest(
          `${connector.label} does not offer '${size}' in ${region}`)

      // The token exists for as long as it takes cloud-init to run. Its HASH is
      // what the row keeps; the token itself goes into the machine's user_data
      // and is never stored (`providers/compute/enrollment.ts`).
      const enroll = mintEnrollToken()

      // The ROW is the caller's write: their gate, their row policies, their
      // name in the audit trail. The enrollment columns are not in it — they
      // are `@guarded`, which is a system-context column on write as well as
      // read, and the Data boundary refuses a scoped client that names one.
      const server = await db().server.create({ data: {
        name,
        slug:            slugify(String(name)),
        role:            role || 'general',
        status:          'pending',
        providerKind:    account.providerKind,
        providerId:      account.id,
        region,
        registerMethod:  'provisioned',
        // What was ASKED for, recorded before anything is spent. A machine that
        // never came up is otherwise a row with a name and no answer to *what
        // was this going to cost*.
        //
        // `vcpu` and `ramGb` are the two `view fleetByProvider` sums, and
        // `priceMinor`/`currency` are what makes `/cloud-spend/` a number
        // rather than a skeleton. Copied at the moment of purchase and never
        // re-read: a vendor raising a price next quarter must not silently
        // restate what this machine cost when it was bought, which is the same
        // rule `example` holds for an order line.
        plan:            {
          size, image, region,
          vcpu:       chosen.vcpu,
          ramGb:      Math.round(chosen.memoryMb / 1024),
          diskGb:     chosen.diskGb,
          priceMinor: chosen.priceMinor,
          currency:   chosen.currency,
        },
      }})

      // The credential artifact, written AS THE APPLICATION. A second statement
      // rather than a wider first one: what is being written here is not the
      // caller's data at all, and the refusal above is the schema saying so.
      await db().asSystem().server.update({
        where: { id: server.id },
        data:  { enrollTokenHash: enroll.hash, enrollExpiresAt: enroll.expiresAt },
      })

      // The move, not an update naming the column: the from-list, the authority
      // and the compare-and-swap are one declaration.
      await db().server.transition(server.id, 'provision')
      await recordEvent(server.id, 'provision_requested',
        `Provisioning a ${size} in ${region} at ${connector.label}`,
        { requested_by: actor(), size, region, image })

      // The token crosses to the job in the DISPATCH rather than being re-read,
      // because the row holds only its hash and nothing can recover it.
      await app.jobs.dispatch('server:provision',
        { serverId: server.id, workspaceId: ws(), enrollToken: enroll.token },
        // The job's PRIMARY KEY. A second dispatch for this machine is a no-op
        // for all time — which is what makes a double-click cost one machine.
        { id: `server:provision:${server.id}` })

      return getScoped('server', 'Server', server.id as string)
    },

    // ── provisionStep — the job's own writes ─────────────────────────
    //
    // `internalOnly`: every one of these moves a machine or spends money, and
    // the job is the only caller. It is one method rather than four because
    // they share the read, the connector resolution and the event trail, and
    // four methods would be four copies of all three.
    async provisionStep() {
      const id     = $.id as string
      const step   = (($.data ?? {}) as Record<string, string>).step
      const server = await getScoped('server', 'Server', id)

      const connector = connectorFor(server.providerKind as ProviderKind | null)
      if (!connector) throw new BadRequest('This machine names no cloud Basecamp can speak to')
      const send = sendVia(app, targetFor(connector.kind, String(server.providerId)))

      if (step === 'start') return server

      if (step === 'create') {
        const plan  = (server.plan ?? {}) as Record<string, string>
        const token = (($.data ?? {}) as Record<string, string>).enrollToken

        const made = await connector.create(send, {
          name:     String(server.slug),
          region:   String(plan.region ?? server.region),
          size:     String(plan.size),
          image:    String(plan.image),
          tags:     machineTags(server.id as string),
          userData: cloudInit({
            serverId:    server.id as string,
            basecampUrl: env.API_URL,
            token,
            outpostPort: 8180,
          }),
        })

        // Recorded IMMEDIATELY. Everything between the vendor answering and
        // this write is the window an orphan is born in, so it is one statement
        // long and nothing else happens inside it.
        const updated = await db().server.update({
          where: { id },
          data:  { providerServerId: made.providerServerId },
        })
        await recordEvent(id, 'provision_created',
          `${connector.label} is building the machine`, { provider_server_id: made.providerServerId })
        return updated
      }

      if (step === 'poll') {
        const seen = await connector.machine(send, String(server.providerServerId ?? ''))

        // Running AND addressable. A machine the vendor calls running with no
        // address yet cannot be reached and cannot have enrolled, so moving on
        // it would report an install that has not started.
        if (seen?.status === 'running' && seen.ipAddress) {
          const legal = (await db().server.transitions(server))
            .some((t: { name: string }) => t.name === 'reportProvisioned')
          if (legal) {
            await db().server.update({ where: { id }, data: { ipAddress: seen.ipAddress } })
            await db().server.transition(id, 'reportProvisioned', { system: true })
            await recordEvent(id, 'provision_ready',
              `The machine is up at ${seen.ipAddress} and is installing its outpost`,
              { ip_address: seen.ipAddress })
          }
        }
        return getScoped('server', 'Server', id)
      }

      if (step === 'timeout') {
        await recordEvent(id, 'provision_timeout',
          'The machine did not come up inside the deadline — it may still exist at the provider',
          { provider_server_id: server.providerServerId })
        return server
      }

      throw new BadRequest(`unknown provisioning step '${step}'`)
    },

    // ── destroy — POST /servers  X-Service-Method: destroy ───────────
    //
    // Unmake a machine this app made. `IDEAS/overview.md` says the reason in
    // one line: provisioning is easy and DE-provisioning is where integrated
    // platforms die, so it ships beside the create rather than after it.
    //
    // The row moves to `destroying` and the vendor's own answer is what lands
    // `destroyed` — a machine this app believes is gone is one the cloud has
    // confirmed is gone, never one a button claimed.
    //
    // **A typed confirmation** (`docs/VISION.md` constraint 5): the caller
    // sends the machine's name back. Not a checkbox — the friction is the
    // feature, and the thing typed is the thing destroyed, so a stale screen
    // cannot confirm the wrong row.
    async destroy() {
      const id      = $.id as string
      const server  = await getScoped('server', 'Server', id)
      const confirm = (($.data ?? {}) as Record<string, string>).confirm

      if (confirm !== server.name)
        throw new BadRequest(
          `Type the machine's name to destroy it — '${server.name}'. `
          + 'This asks the provider to delete it and cannot be undone.')

      const connector = connectorFor(server.providerKind as ProviderKind | null)
      if (!connector)
        throw new BadRequest('This machine was imported, not provisioned — remove it instead')

      await db().server.transition(id, 'destroy')
      await recordEvent(id, 'destroy_requested',
        `Asked ${connector.label} to destroy this machine`, { requested_by: actor() })

      await app.jobs.dispatch('server:destroy', { serverId: id, workspaceId: ws() },
        { id: `server:destroy:${id}` })

      return getScoped('server', 'Server', id)
    },

    // ── destroyStep — the destroy job's own write ────────────────────
    async destroyStep() {
      const id     = $.id as string
      const server = await getScoped('server', 'Server', id)

      const connector = connectorFor(server.providerKind as ProviderKind | null)
      if (!connector) throw new BadRequest('This machine names no cloud Basecamp can speak to')

      // Nothing to ask the vendor about. A machine that never got an id is one
      // the create never finished, and it is destroyed by saying so.
      if (!server.providerServerId) {
        await db().server.transition(id, 'reportDestroyed', { system: true })
        await recordEvent(id, 'destroy_finished',
          'No machine was ever created at the provider', {})
        return getScoped('server', 'Server', id)
      }

      const send = sendVia(app, targetFor(connector.kind, String(server.providerId)))
      await connector.destroy(send, String(server.providerServerId))

      await db().server.transition(id, 'reportDestroyed', { system: true })
      await recordEvent(id, 'destroy_finished',
        `${connector.label} has destroyed this machine`,
        { provider_server_id: server.providerServerId })

      return getScoped('server', 'Server', id)
    },

    // ── reconcile — GET /servers  X-Service-Method: reconcile ────────
    //
    // What does this cloud have that this app does not?
    //
    // The one question a lookup cannot ask. An orphan — created at the vendor,
    // never recorded here, billing forever — has no id on this side to look up
    // with, which is why every machine this app makes carries
    // `basecamp:server:<id>` and why this is a LIST over that tag.
    //
    // **It reports and never deletes.** A machine it cannot account for might
    // be a create that is still in flight, a row somebody removed while the
    // vendor still had the machine, or a genuine leak — and the difference is a
    // person's to make. A reconciliation that destroyed what it did not
    // recognize would eventually destroy something real.
    async reconcile() {
      const accountId = ($.data as Record<string, unknown> | null)?.accountId ?? $.query.accountId
      if (!accountId) throw new BadRequest('accountId is required — which provider account to sweep')

      const account = await db().secret.findFirst({ where: { id: String(accountId) } })
      if (!account) throw new NotFound(`Provider account '${accountId}' not found`)

      const connector = connectorFor(account.providerKind as ProviderKind | null)
      if (!connector)
        throw new BadRequest(`'${account.name}' is not an account at a cloud Basecamp can speak to`)

      const send = sendVia(app, targetFor(connector.kind, account.id as string))

      // Every machine this app believes it has at this account, alive. A
      // destroyed row is deliberately not here: its machine SHOULD be gone, so
      // one still standing is exactly what this is looking for.
      const rows = await db().server.findMany({
        where: { providerId: account.id, status: { not: 'destroyed' } },
      })
      const known = new Map(
        (rows as Record<string, unknown>[])
          .filter(r => r.providerServerId)
          .map(r => [String(r.providerServerId), r]),
      )

      // The tag PREFIX, which is what makes one sweep cover every machine
      // rather than needing the id it is trying to discover.
      const tagged = await connector.tagged(send, FLEET_TAG)

      const orphans = tagged.filter(m => !known.has(m.providerServerId))
      const missing = [...known.entries()]
        .filter(([pid]) => !tagged.some(m => m.providerServerId === pid))
        .map(([pid, row]) => ({ id: row.id, name: row.name, providerServerId: pid }))

      return {
        account:   { id: account.id, name: account.name, providerKind: account.providerKind },
        // At the vendor, tagged as ours, and unknown here. Money being spent on
        // nothing.
        orphans,
        // Known here and NOT at the vendor. Somebody destroyed it in the
        // provider's own console, and this app still shows it.
        missing,
        checked:   tagged.length,
      }
    },

    // ── catalog — GET /servers  X-Service-Method: catalog ─────────────
    //
    // What one ACCOUNT can be asked for: regions, sizes and images, read off the
    // vendor every time.
    //
    // Not cached and not a table in this repo. The mock wrote DigitalOcean's
    // price list out as three JSX constants and they were wrong before anybody
    // read them — a catalog is the vendor's to state, and the only copy that
    // cannot drift is the one that is not kept (`docs/PROVISIONING.md` § D3).
    //
    // The account is named by the caller and CONFINED by the read above it:
    // `getScoped` on the secret runs at the caller's own standing, so an account
    // in another workspace answers 404 before a vendor is touched.
    async catalog() {
      const accountId = ($.data as Record<string, unknown> | null)?.accountId
                     ?? $.query.accountId
      if (!accountId) throw new BadRequest('accountId is required — which provider account to ask')

      const account = await db().secret.findFirst({ where: { id: String(accountId) } })
      if (!account) throw new NotFound(`Provider account '${accountId}' not found`)

      const connector = connectorFor(account.providerKind as ProviderKind | null)
      if (!connector)
        throw new BadRequest(`'${account.name}' is not an account at a cloud Basecamp can speak to`)

      const target = targetFor(connector.kind, account.id as string)
      return { provider: connector.kind, ...(await connector.catalog(sendVia(app, target))) }
    },

    // ── providers — GET /servers  X-Service-Method: providers ────────
    //
    // Which clouds this app can speak to, and which accounts this workspace
    // holds for them. One call, because a wizard's first step needs both and
    // asking twice makes the empty case flicker.
    async providers() {
      const accounts = await db().secret.findMany({
        where:   { kind: 'provider_key' },
        orderBy: { name: 'asc' },
      })
      return {
        providers: computeProviders(),
        // `data` is @encrypted and absent from the row, so nothing here can
        // leak a token: what a picker needs is an id, a name and a vendor.
        accounts: (accounts as Record<string, unknown>[]).map(a => ({
          id: a.id, name: a.name, providerKind: a.providerKind, isVerified: a.isVerified,
        })),
      }
    },

    // ── heartbeat — POST /servers/:id  X-Service-Method: heartbeat ────
    // Called by the Basecamp outpost, which holds no session — it authenticates
    // ── metrics ───────────────────────────────────────────────────────
    //
    // This machine's readings over time — what `Server.health` cannot answer,
    // because it is one column overwritten on every check-in (`FJS-956`).
    //
    // ─── The access decision, and the tidier option was refused ──────────
    //
    // `MetricSeries` and `MetricPoint` are `@@gate("8")` and `@@tenant(none)`:
    // a reading is about a PROCESS and belongs to no workspace, which is right
    // for `process.memoryMb` and is exactly what a per-server series is not.
    //
    // The tempting fix is to open the package's read slot and let each app
    // declare a row policy over the label. **Refused**: an app that installs
    // junction and writes no policy then serves every reading it has to anyone,
    // fail-open, and nothing says so. A gate that can only fail open is not a
    // gate.
    //
    // So the CONFINEMENT is the parent read. `getScoped('server')` runs at the
    // caller's own standing — the gate, the row policies and the workspace
    // tenancy all apply to it — and a server in another workspace answers 404
    // before a series is touched. Only then is the series read through
    // `asSystem()`, which is the shape `jobs/context.ts` already names: a
    // system read whose confinement is the read above it, not a hook.
    async metrics() {
      const server = await getScoped('server', 'Server')
      $.dispatch = false

      const arg  = { ...(($.query as Record<string, unknown>) ?? {}),
                     ...(($.data  as Record<string, unknown>) ?? {}) }
      const to   = num(arg.to)   ?? Date.now()
      const from = num(arg.from) ?? to - 24 * 3_600_000
      if (from >= to) throw new BadRequest('from must be before to')

      const sys = $.db.asSystem() as any
      const out: Record<string, unknown> = {}

      for (const name of SERVER_SERIES) {
        // The key is junction's, never spelled here: a second spelling is a
        // second series, and each of them then holds half the readings.
        const series = await sys.metricSeries.findFirst({
          where: { labelsKey: seriesKey(name, { serverId: server.id }) },
        })
        // `null` and not `[]`. A machine that has never reported disk and one
        // whose disk is flat draw the same empty chart, and only the first is
        // something a person should be told about.
        if (!series) { out[name] = null; continue }

        const points = await sys.metricPoint.findMany({
          where: { seriesId: series.id, at: { gte: from, lte: to } },
          orderBy: { at: 'asc' }, limit: 2_000,
        })
        out[name] = { unit: series.unit, stale: isStale(series.lastSeenAt), points }
      }

      // `readings` is the DECLARATION and `series` is what the store holds, and
      // they are answered together because a card needs the first whether or
      // not the second exists: a machine that has never reported disk still has
      // a disk bar to draw off `Server.health`. Sending it also means the card
      // holds no list of its own — it had one, and it was the third hand copy
      // of a vocabulary two of whose copies were wrong (`FJS-1027`).
      return { serverId: server.id, from, to, readings: SERVER_READINGS, series: out }
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

      // KEEP THE READINGS. `Server.health` is a SNAPSHOT — one column, one row,
      // overwritten every check-in — so until now the answer to *what was this
      // machine doing on Tuesday* was gone rather than stale, and three widget
      // kinds said so on their own cards (`FJS-956`).
      //
      // Through `app.metrics.record()` and not by writing the tables: a series
      // is addressed by `labelsKey`, and a caller inventing that key mints a
      // SECOND series under the same name, after which each of them holds half
      // the readings and the graph has a step in it that nothing explains.
      //
      // Not awaited into the response's critical path? It is — a heartbeat is
      // already a write, three more rows on the same connection cost less than
      // the branch that would make them optional, and a failure here should be
      // as visible as any other part of a check-in.
      await recordHealth(app, server.id, data.health, now)

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
        // `catalog` SPENDS the workspace's vendor token — a rate limit is per
        // token, so a viewer refreshing a picker is somebody else's failed
        // deploy. `providers` is not here: it reads rows this app owns and
        // discloses account names, which is the model's own read gate.
        catalog:   [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        logEvent:  [internalOnly()],
        // Every step moves a machine or spends money, and the job is the only
        // caller. `provision` itself carries no role hook: `@gate(5)` on the
        // move is the authority, in the place the access snapshot prints it.
        provisionStep: [internalOnly()],
        destroyStep:   [internalOnly()],
        // `reconcile` spends the workspace's token, like `catalog`. `destroy`
        // carries no role hook: `@gate(5)` on the move is the authority.
        reconcile:     [requireWorkspaceRole(app, 'developer', 'admin', 'owner')],
        // heartbeat: HMAC auth at Conduit transport level — no session hook
      },
    },
  })
}

/** The wire carries strings. A bound that silently became `NaN` would be
 *  answered as "no points" — an empty chart rather than a bad request — so an
 *  unparseable one is undefined and takes the default. */
function num(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}
