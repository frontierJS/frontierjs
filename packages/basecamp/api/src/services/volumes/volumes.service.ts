// src/services/volumes/volumes.service.ts
// Persistent Docker volumes across the fleet.
//
// Mounted at /volumes. Custom methods dispatch on X-Service-Method:
//   report — the outpost's, no session, per server, replaces that server's set
//   usage  — fleet totals, read-shaped, addresses the COLLECTION
//   prune  — delete every unused volume, really, through the outpost
//
// **A volume is OBSERVED, not declared** — the first model in this app that is.
// Everything else here is something a person created and Basecamp then acts on;
// a volume exists because Docker made it and an outpost found it. So there is no
// `create` — and declaring none is not how you get none. `model:` brings
// Junction's Litestone base with it, which SUPPLIES every CRUD verb the service
// does not declare, so `POST /volumes` answered 201 and wrote a row no disk
// corresponded to. `methods:` below is the allow-list that makes the absence
// real.
//
// **Deleting a row is not deleting a volume.** The disk stays exactly as full,
// and the fleet is one row less honest. `remove` and `prune` therefore ASK the
// outpost — through `app.conduit`, the outbound boundary, at the `outpost:<id>`
// target `servers.heartbeat` registers — and only forget the row once the outpost
// says it is gone. Nothing is registered for a server whose outpost has never
// checked in, and that is a refusal in words rather than a silent local delete.
// Same posture `channels.test` takes: an action that reported success without
// leaving the process would be worse than no action, because the row
// disappearing is then read as evidence.
//
// **No `workspaceId` on the model**, for the reason `ServerEvent` has none: a
// volume is meaningless without its server, and denormalising the tenancy fact
// onto it makes two owners of one answer. So the scope is a join — the server
// ids in this workspace, then the volumes on them. The shared helpers in
// core/resource.ts cannot be used here for exactly that reason; `serversOf()`
// below is the one place this join is written.
//
// Sizes are BYTES. The outpost reports bytes, the screen decides whether that
// reads better as MB or GB, and a rounded number stored is a number nothing can
// un-round — `0.01 GB` in the mock is 10.7 MB.

import { createService, NotFound, BadRequest, Conflict, $ } from '@frontierjs/junction'
import { sessionScope, requireWorkspaceRole, workspaceChannel, getPagination, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws, actor }  from '../../core/resource.ts'
import type { BasecampApp }     from '../../basecamp.types.ts'
import type { ServiceContext }  from '@frontierjs/junction'

// ─── The outpost's wire contract ───────────────────────────────────────────
// snake_case, like the heartbeat payload and unlike every other call into this
// app: the schema's camelCase applies to MODEL fields, and these are not model
// fields — they are what `docker volume inspect` calls things, relayed. A
// mis-spelled key here does not error, it reports a volume with no mount point.

interface ReportedVolume {
  name:        string
  driver?:     string
  mountpoint?: string
  size_bytes?: number
  in_use?:     boolean
  containers?: string[]
  created_at?: string
}

interface ReportData {
  server_id?: string
  volumes?:   ReportedVolume[]
}

export function createVolumesService(app: BasecampApp) {

  /** The system client, typed once — the accessors have no generated types yet
   *  (`litestone types` is pending), so every read is otherwise `unknown`. */
  const sys = (): any => (app.data as any).asSystem()

  /**
   * The caller's fleet, as id → name.
   *
   * The tenancy boundary for this whole service. Every read and every write
   * below starts here, because `Volume` carries no workspace of its own: a
   * query that skipped this would answer another workspace's disks to anyone
   * holding an id.
   */
  async function serversOf(): Promise<Map<string, string>> {
    const rows = await db().server.findMany({
      where:  { workspaceId: ws() },
      select: { id: true, name: true },
      limit:  500,
    })
    return new Map(rows.map((s: { id: string; name: string }) => [s.id, s.name]))
  }

  /** One volume inside the caller's fleet, or 404. */
  async function getScopedVolume(fleet: Map<string, string>) {
    const id  = $.id as string
    const row = await db().volume.findFirst({ where: { id } })
    if (!row || !fleet.has(row.serverId as string)) throw new NotFound(`Volume '${id}' not found`)
    return row
  }

  /**
   * The outpost for a server, or a refusal naming what is missing.
   *
   * A target is registered on heartbeat (`servers.service.ts`), so "no outpost"
   * means the machine has never checked in with a URL — which is a real state
   * an operator needs told, not an error to swallow. Deleting the row anyway
   * would leave the disk full and the fleet's picture wrong in the one
   * direction nothing can detect.
   */
  async function outpostFor(serverId: string, serverName: string): Promise<string> {
    if (!app.conduit)
      throw new BadRequest('Outbound delivery is not configured on this server — no conduit plugin')

    const target = `outpost:${serverId}`
    if (!await app.conduit.resolve(target))
      throw new BadRequest(
        `No outpost is registered for '${serverName}' — the volume was left alone. ` +
        'An outpost registers itself on its first heartbeat.'
      )
    return target
  }

  /** Record what happened on the server's own event trail, so a disk that
   *  disappeared is answerable from the fleet feed rather than only the audit
   *  trail. Both are read by /activity/. */
  async function recordEvent(
    serverId: string, kind: string, message: string,
    metadata: Record<string, unknown> = {},
  ) {
    await db().serverEvent.create({ data: { serverId, kind, message, metadata } })
  }

  return createService({
    name:  'volumes',
    model: 'Volume',
    // Announced by the service DEFINITION, not by an after hook: `callService`
    // is junction's one announcement point and it excludes `find`/`get` by name,
    // where an `after: { all: [...] }` hook broadcast every read to every browser
    // in the workspace (FJS-031). Declaring both is refused at construction.
    channel: workspaceChannel(app),
    reservedQuery: WORKSPACE_QUERY,   // ?workspace_id= is not a filter — see core/hooks.ts

    // The whole surface, declared. Omitting a method does not remove it: with
    // `model:` set, Junction's Litestone base answers every CRUD verb for
    // anything the service leaves out — validated, so a well-formed payload is
    // written. `POST /volumes` answered 201 and wrote a row no disk
    // corresponded to until this line existed. `create`, `update` and `patch`
    // are all absent on purpose: a volume is what an outpost last reported, and
    // editing the record edits the picture rather than the machine.
    methods: ['find', 'get', 'remove', 'usage', 'report', 'prune'],

    // ── find ──────────────────────────────────────────────────────────
    async find(ctx: ServiceContext) {
      const { limit, offset } = getPagination({ limit: 50, max: 200 })
      const serverId = $.query.serverId as string | undefined
      const search   = $.query.search   as string | undefined
      // The wire carries strings and the column is a boolean; comparing them
      // raw matches nothing and reports an empty list rather than an error.
      const inUse    = $.query.inUse as string | boolean | undefined

      const fleet = await serversOf()
      if (!fleet.size) return { total: 0, limit, offset, data: [] }

      if (serverId && !fleet.has(serverId)) throw new NotFound(`Server '${serverId}' not found`)

      const { rows, total } = await db().volume.findManyAndCount({
        where: {
          serverId: { in: serverId ? [serverId] : [...fleet.keys()] },
          ...(inUse !== undefined ? { inUse: inUse === true || inUse === 'true' } : {}),
          ...(search ? { name: { contains: search } } : {}),
        },
        orderBy: { name: 'asc' },
        limit, offset,
      })

      // The server's NAME, resolved here rather than by the browser — the same
      // call `servers.feed` makes. A list of `4f3a-…` is a list nobody reads,
      // and the alternative is an `include` shipping a whole server per row.
      return {
        total, limit, offset,
        data: rows.map((v: Record<string, unknown>) => ({
          ...v, serverName: fleet.get(v.serverId as string) ?? null,
        })),
      }
    },

    // ── get ───────────────────────────────────────────────────────────
    async get(ctx: ServiceContext) {
      const fleet  = await serversOf()
      const volume = await getScopedVolume(fleet)
      return { ...volume, serverName: fleet.get(volume.serverId as string) ?? null }
    },


    // ── usage — POST /volumes  X-Service-Method: usage ────────────────
    // Fleet totals: how much storage there is and how much of it is reclaimable.
    //
    // Its own method rather than a key on `find`, because a list envelope holds
    // `{total, limit, offset, data}` and nothing else — a summary returned
    // beside them is refused by wrapResult. And it must be the
    // whole fleet rather than the page: a header stating "12 GB across the
    // fleet" from the first 50 rows is wrong exactly when it matters.
    async usage(ctx: ServiceContext) {
      $.dispatch = false   // read-shaped
      const fleet = await serversOf()
      if (!fleet.size) return { volumes: 0, inUse: 0, unused: 0, totalBytes: 0, reclaimableBytes: 0, servers: [] }

      const rows = await db().volume.findMany({
        where:  { serverId: { in: [...fleet.keys()] } },
        select: { serverId: true, sizeBytes: true, inUse: true },
        limit:  5_000,
      })

      let inUse = 0, totalBytes = 0, reclaimableBytes = 0
      const perServer = new Map<string, number>()
      for (const v of rows as { serverId: string; sizeBytes: number; inUse: boolean }[]) {
        totalBytes += v.sizeBytes
        if (v.inUse) inUse++
        else reclaimableBytes += v.sizeBytes
        perServer.set(v.serverId, (perServer.get(v.serverId) ?? 0) + 1)
      }

      return {
        volumes: rows.length,
        inUse,
        unused:  rows.length - inUse,
        totalBytes,
        reclaimableBytes,
        // Only servers that actually have volumes — a filter offering thirty
        // machines where four have disks is a filter that mostly empties the
        // screen.
        servers: [...perServer].map(([id, count]) => ({ id, name: fleet.get(id) ?? id, count })),
      }
    },

    // ── report — POST /volumes  X-Service-Method: report ──────────────
    // The outpost's endpoint, and the only way a row gets here.
    //
    // It addresses the COLLECTION: there is no subject volume, and the server
    // is named in the body because the outpost knows which machine it is and not
    // which rows Basecamp holds. A collection-level action was unreachable from
    // either client until `FJS-122`.
    //
    // It REPLACES that server's set. A report is the whole truth about one
    // machine at one moment, so a volume missing from it is a volume that no
    // longer exists — forgetting it here is recording a fact, not deleting a
    // disk.
    async report() {
      const data     = $.data as ReportData
      const serverId = data?.server_id
      if (!serverId)         throw new BadRequest('server_id is required')
      if (!Array.isArray(data.volumes)) throw new BadRequest('volumes must be an array')

      // asSystem(): an outpost holds no session and there is no user to scope to.
      // The same call `servers.heartbeat` makes, for the same reason.
      const server = await sys().server.findUnique({ where: { id: serverId } })
      if (!server) throw new NotFound(`Server '${serverId}' not found`)

      // The event belongs to the MACHINE's workspace, not the caller's — and
      // sessionScope skips this method, so nothing else has stamped one. Without
      // it the after-hook publishes to `workspace:undefined` and the open
      // volumes screen never hears that the fleet's disks changed.
      $.locals.workspaceId = server.workspaceId

      const now      = new Date().toISOString()
      const existing = await sys().volume.findMany({ where: { serverId }, limit: 1_000 })
      const byName   = new Map(existing.map((v: Record<string, unknown>) => [v.name as string, v]))

      let added = 0, updated = 0
      for (const reported of data.volumes) {
        if (!reported?.name) continue
        const row = {
          driver:     reported.driver     ?? 'local',
          mountPoint: reported.mountpoint ?? null,
          sizeBytes:  Math.max(0, Math.round(reported.size_bytes ?? 0)),
          inUse:      reported.in_use === true,
          containers: Array.isArray(reported.containers) ? reported.containers : [],
          // Docker's own creation time, and the only one that answers "how long
          // has this been lying around" — `discoveredAt` is when Basecamp first
          // saw it, which for an old disk on a new install is today.
          createdOnServer: reported.created_at ?? null,
          lastSeenAt:      now,
        }
        const found = byName.get(reported.name)
        if (found) {
          await sys().volume.update({ where: { id: (found as { id: string }).id }, data: row })
          updated++
        } else {
          await sys().volume.create({ data: { serverId, name: reported.name, discoveredAt: now, ...row } })
          added++
        }
      }

      const reportedNames = new Set(data.volumes.map(v => v?.name).filter(Boolean))
      const stale = existing
        .filter((v: Record<string, unknown>) => !reportedNames.has(v.name as string))
        .map((v: Record<string, unknown>) => v.id as string)

      // Hard delete: `Volume` declares no @@softDelete, because a row nothing
      // corresponds to is not history — it is a wrong answer to "what is on
      // this disk". The audit trail keeps the fact it was here.
      if (stale.length) await sys().volume.deleteMany({ where: { id: { in: stale } } })

      return { serverId, reported: data.volumes.length, added, updated, forgotten: stale.length }
    },

    // ── remove ────────────────────────────────────────────────────────
    async remove(ctx: ServiceContext) {
      const fleet  = await serversOf()
      const volume = await getScopedVolume(fleet)
      const name   = volume.name as string
      const server = fleet.get(volume.serverId as string) as string

      // The one refusal that stops somebody deleting a database. Named
      // containers, not a count: "stop the container first" is only actionable
      // if it says which one.
      if (volume.inUse) {
        const containers = (volume.containers as string[] | null) ?? []
        throw new Conflict(
          `'${name}' is mounted by ${containers.length ? containers.join(', ') : 'a running container'}` +
          ' — stop the container first'
        )
      }

      const target = await outpostFor(volume.serverId as string, server)
      const res    = await app.conduit!.send({
        target,
        method: 'DELETE',
        path:   `/volumes/${encodeURIComponent(name)}`,
      })

      // The row survives a failed delete. A volume Basecamp has forgotten and
      // the server still has is invisible until the next report puts it back —
      // and in between, an operator has been told the disk was freed.
      if (res.error)
        throw new BadRequest(`The outpost on '${server}' could not remove '${name}' (${res.error.kind}): ${res.error.message}`)

      await db().volume.delete({ where: { id: volume.id } })
      await recordEvent(volume.serverId as string, 'volume_removed',
        `Volume '${name}' removed`, { requested_by: actor(), size_bytes: volume.sizeBytes })

      return volume
    },

    // ── prune — POST /volumes  X-Service-Method: prune ────────────────
    // Every unused volume in the workspace, or on one server. Collection-level
    // for the same reason `report` is: there is no subject row.
    //
    // One request per server carrying the names, rather than one per volume:
    // pruning is what `docker volume prune` does in a single call, and forty
    // round trips to the same outpost is forty chances to half-finish.
    async prune(ctx: ServiceContext) {
      const fleet    = await serversOf()
      const serverId = ($.data as { serverId?: string } | null)?.serverId
      if (serverId && !fleet.has(serverId)) throw new NotFound(`Server '${serverId}' not found`)

      const unused = await db().volume.findMany({
        where: { serverId: { in: serverId ? [serverId] : [...fleet.keys()] }, inUse: false },
        limit: 1_000,
      })
      if (!unused.length) throw new BadRequest('Nothing to prune — every volume is in use')

      const byServer = new Map<string, Record<string, unknown>[]>()
      for (const v of unused as Record<string, unknown>[]) {
        const key = v.serverId as string
        byServer.set(key, [...(byServer.get(key) ?? []), v])
      }

      let freedBytes = 0
      const forgotten: string[] = []
      const unreachable: string[] = []

      for (const [id, volumes] of byServer) {
        const server = fleet.get(id) as string
        let target: string
        try {
          target = await outpostFor(id, server)
        } catch {
          // One unreachable outpost does not cancel the rest of the fleet — but
          // it is named in the answer, because a prune that silently covered
          // four servers out of five reads as a prune of all five.
          unreachable.push(server)
          continue
        }

        const res = await app.conduit!.send({
          target, method: 'POST', path: '/volumes/prune',
          body: { names: volumes.map(v => v.name) },
        })
        if (res.error) { unreachable.push(`${server} (${res.error.kind})`); continue }

        // Exactly what the outpost says it removed, never the list we asked it
        // to. An outpost that could only delete three of five has a fourth still
        // on disk, and forgetting it here is how a volume becomes invisible.
        const removed = new Set(((res.data as { removed?: string[] } | null)?.removed ?? []))
        const gone    = volumes.filter(v => removed.has(v.name as string))

        if (gone.length) {
          await db().volume.deleteMany({ where: { id: { in: gone.map(v => v.id as string) } } })
          freedBytes += gone.reduce((a, v) => a + ((v.sizeBytes as number) ?? 0), 0)
          forgotten.push(...gone.map(v => v.name as string))
          await recordEvent(id, 'volumes_pruned',
            `${gone.length} unused volume(s) pruned`, { requested_by: actor(), names: gone.map(v => v.name) })
        }
      }

      // Nothing reclaimed and something unreachable is a FAILURE. Answering
      // `{ forgotten: [] }` with a 200 is the shape an operator reads as "there
      // was nothing to do", which is the opposite of what happened.
      if (!forgotten.length && unreachable.length)
        throw new BadRequest(`Nothing was pruned — no outpost answered on ${unreachable.join(', ')}`)

      return { requested: unused.length, forgotten, freedBytes, unreachable }
    },

    hooks: {
      before: {
        // `report` is the outpost's endpoint — no session, no workspace header.
        // It must be exempted HERE; a comment on the method is not an
        // exemption, and that mistake 401'd every server check-in once.
        all:    [sessionScope(app, { except: ['report'] })],
        // Both write paths destroy data on a machine. Same bar as removing a
        // server, and higher than the developer bar the read side sits at.
        remove: [requireWorkspaceRole(app, 'admin', 'owner')],
        prune:  [requireWorkspaceRole(app, 'admin', 'owner')],
      },
    },
  })
}
