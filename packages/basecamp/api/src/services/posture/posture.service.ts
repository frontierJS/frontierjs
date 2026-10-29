// src/services/posture/posture.service.ts
// A fleet machine's security posture: what its Outpost read, graded.
//
// Mounted at /posture. Custom methods dispatch on X-Service-Method:
//   report — the outpost's, no session, signed; one report per call
//   check  — *check now*: asks the machine's outpost through conduit, then the same ingest
//   latest — one machine's newest report, graded for staleness on read
//   fleet  — every machine in the workspace, worst first, and the vulnerable
//            dependency count; what /security/ draws
//   host   — the box this Basecamp runs on, hub only; what /hub/security/ draws.
//            It is the server the hub App is placed on (`FJS-D1603`), graded with the `hub.*`
//            controls beside its own (FJS-D1241)
//
// The Outpost reports facts and `domain/host/posture.ts` grades them (IDEAS/server-posture.md
// § Outpost reads, Basecamp grades). **A failing control never refuses a
// deploy**: it is a ServerEvent, a metric and a notification, because refusing
// releases over an sshd setting turns a hygiene finding into an outage.
//
// `ServerPosture` has no `workspaceId`; its scope is the join through Server,
// which litestone walks, so a read through `db()` is confined like Volume's.

import { createService, NotFound, BadRequest, $ } from '@frontierjs/junction'
import { LEVELS } from '@frontierjs/litestone'
import { requireSystemAdmin, sessionScope, workspaceChannel } from '../../core/hooks.ts'
import { db, ws }   from '../../core/resource.ts'
import { declaredFor, gradePosture, gradeReplication, postureChanges, postureRank, POSTURE_INTERVAL_MS } from '../../domain/host/posture.ts'
import type { Control, PostureReadings } from '../../domain/host/posture.ts'
import { notifyPeople, workspaceMembers } from '../../domain/notification/notify.ts'
import { statusOf } from '../../core/dependencies.ts'
import { keyScope } from '../../domain/api-key/scopes.ts'
import { gradeHubNow } from '../../domain/host/host-machine.ts'
import { hostReplicaDestination } from '../../jobs/replicate-sync.job.ts'

// ─── The outpost's wire contract ───────────────────────────────────────────
// `inspector.posture()` in packages/outpost, snake_case and relayed as-is.

interface ReportData {
  server_id?: string
  at?:        string
  readings?:  PostureReadings
}

const sys = (): any => $.db.asSystem()

/**
 * Grade one report and keep it.
 *
 * The expected set is read from the rows at the moment the report lands —
 * the apps placed on the machine NOW, the key it was given NOW — so a
 * placement made since the last report is not a stranger on the next.
 */
async function ingest(server: any, data: ReportData) {
  const apps = await sys().app.findMany({
    where:  { appServers: { some: { serverId: server.id } } },
    select: { type: true, port: true, exposesPort: true },
  })
  const key = server.sshKeyId
    ? await sys().secret.findFirst({ where: { id: server.sshKeyId } })
    : null
  const declared = declaredFor({ sshPort: server.sshPort, apps, sshKeyData: key?.data ?? null })

  const now      = Date.now()
  const at       = typeof data.at === 'string' && Number.isFinite(Date.parse(data.at)) ? data.at : new Date(now).toISOString()
  const readings = data.readings && typeof data.readings === 'object' ? data.readings : null
  const controls = gradePosture(readings, declared, { at, now })
  const failing  = controls.filter(c => c.ok === false).length
  const unknown  = controls.filter(c => c.ok === 'unknown').length

  const prior = await sys().serverPosture.findFirst({
    where: { serverId: server.id }, orderBy: { at: 'desc' },
  })
  const row = await sys().serverPosture.create({ data: {
    serverId: server.id, at, readings: readings ?? {}, controls, failing, unknown,
  } })

  // The history that answers *when did this stop holding*. Unknown on either
  // side is not a move: a box whose sshd -T failed once did not get fixed.
  const { failed, restored } = postureChanges((prior?.controls as Control[] | undefined) ?? null, controls)
  for (const c of failed)
    await sys().serverEvent.create({ data: { serverId: server.id, kind: 'posture_failed',
      message: `${c.id}: ${c.message}`, metadata: { control: c.id, severity: c.severity, posture_id: row.id } } })
  for (const c of restored)
    await sys().serverEvent.create({ data: { serverId: server.id, kind: 'posture_restored',
      message: `${c.id}: ${c.message}`, metadata: { control: c.id, posture_id: row.id } } })

  // Into the metric store so an AlertRule covers a threshold unchanged.
  const metrics = ($.app as { metrics?: { record: Function } }).metrics
  if (metrics) await metrics.record('server.posture.failing', failing, {
    type: 'gauge', unit: 'count', labels: { serverId: server.id }, at: Date.parse(at),
  })

  if (failed.length)
    await notifyPeople($.app, 'PostureFailed', await workspaceMembers($.app, server.workspaceId), {
      serverId:   server.id,
      serverName: server.name,
      failed:     failed.map(c => `${c.id}: ${c.message}`),
    }, server.workspaceId)

  // A signal naming the machine, not a row to merge: the server page re-reads
  // `latest` on it.
  $.dispatch = { serverId: server.id }
  return { id: row.id, at, failing, unknown, failed: failed.map(c => c.id), restored: restored.map(c => c.id) }
}

/**
 * A stored report as a screen reads it. Staleness is graded HERE, on read:
 * a report stops being true by sitting in the table, and a box whose Outpost
 * died would otherwise keep its last clean answer forever.
 */
export async function postureView(server: any, row: any, { readings = false } = {}) {
  const host    = !!await hostReplicaDestination(sys(), server)
  const replica = gradeReplication(server.replication, await replicatingOn(server.id), Date.now(), host)
  if (!row) return {
    serverId: server.id, serverName: server.name, status: server.status,
    reported: false, stale: false, at: null, controls: [replica], failing: replica.ok === false ? 1 : 0,
    unknown: replica.ok === 'unknown' ? 1 : 0, rank: 5_000 + postureRank([replica]),
  }
  const stale    = Date.now() - Date.parse(row.at) > 2 * POSTURE_INTERVAL_MS
  const controls = [...(row.controls as Control[]).map(c => stale
    ? { ...c, ok: 'unknown' as const, message: `Stale — last said: ${c.message}` }
    : c), replica]
  return {
    serverId: server.id, serverName: server.name, status: server.status,
    reported: true, stale, at: row.at, controls,
    failing:  controls.filter(c => c.ok === false).length,
    unknown:  controls.filter(c => c.ok === 'unknown').length,
    rank:     postureRank(controls) + (stale ? 5_000 : 0),
    ...(readings ? { readings: row.readings } : {}),
  }
}

/** The apps placed on a machine that name a replica — what `backup.replica-lag` expects to hear of. */
async function replicatingOn(serverId: string): Promise<{ id: string; slug: string }[]> {
  const placed = await sys().appServer.findMany({ where: { serverId }, select: { appId: true } }) as { appId: string }[]
  if (!placed.length) return []
  return sys().app.findMany({
    where:  { id: { in: [...new Set(placed.map(p => p.appId))] }, replicaDestinationId: { not: null } },
    select: { id: true, slug: true }, orderBy: { slug: 'asc' },
  })
}

async function scopedServer(id: string) {
  const server = await db().server.findFirst({ where: { id } })
  if (!server) throw new NotFound(`Server '${id}' not found`)
  return server
}

export default createService({
  name:    'posture',
  scope:   keyScope('posture'),
  model:   'ServerPosture',
  channel: workspaceChannel,

  // No CRUD: a report is what a machine said, and editing one edits the record
  // rather than the box. `report` is the outpost's — no session, HMAC at the
  // transport, so it states gate 0 (`FJS-826`).
  // `check` is thirty process spawns on the machine, so not a viewer's button.
  // `host` reads through asSystem() behind requireSystemAdmin, since a system
  // admin need not be a member of the workspace the host row is in.
  methods: ['latest', 'fleet', 'host', { method: 'check', gate: LEVELS.USER }, { method: 'report', gate: 0 }],

  // ── report — POST /posture  X-Service-Method: report ──────────────
  async report() {
    const data     = $.data as ReportData
    const serverId = data?.server_id
    if (!serverId) throw new BadRequest('A posture report names its server_id')

    // asSystem(): an outpost holds no session. `outpostScope` has already
    // matched the signature to this server_id.
    const server = await sys().server.findUnique({ where: { id: serverId } })
    if (!server) throw new NotFound(`Server '${serverId}' not found`)
    $.locals.workspaceId = server.workspaceId

    return ingest(server, data)
  },

  // ── check — POST /posture/:serverId  X-Service-Method: check ──────
  async check() {
    const server = await scopedServer($.id as string)
    if (!('conduit' in $.app)) throw new BadRequest('Outbound delivery is not configured on this server — no conduit plugin')
    const target = `outpost:${server.id}`
    if (!await $.app.conduit.resolve(target))
      throw new BadRequest(`No outpost is registered for '${server.name}'. An outpost registers itself on its first heartbeat.`)

    const res = await $.app.conduit.send({ target, method: 'POST', path: '/posture', body: {} })
    if (res.error) throw new BadRequest(`The outpost on '${server.name}' did not answer (${res.error.kind})`)

    await ingest(server, res.data as ReportData)
    return await postureView(server, await sys().serverPosture.findFirst({ where: { serverId: server.id }, orderBy: { at: 'desc' } }), { readings: true })
  },

  // ── latest — POST /posture/:serverId  X-Service-Method: latest ────
  async latest() {
    $.dispatch = false   // read-shaped
    const server = await scopedServer($.id as string)
    const row    = await db().serverPosture.findFirst({ where: { serverId: server.id }, orderBy: { at: 'desc' } })
    return await postureView(server, row, { readings: true })
  },

  // ── fleet — POST /posture  X-Service-Method: fleet ────────────────
  async fleet() {
    $.dispatch = false   // read-shaped
    const servers = await db().server.findMany({ where: { workspaceId: ws() }, limit: 500 })
    const rows = []
    for (const server of servers)
      rows.push(await postureView(server, await db().serverPosture.findFirst({
        where: { serverId: server.id }, orderBy: { at: 'desc' },
      })))
    rows.sort((a, b) => b.rank - a.rank || a.serverName.localeCompare(b.serverName))

    // The code half of *am I exposed*: a dependency whose installed version an
    // advisory names, across every project in the workspace.
    const deps = await db().dependency.findMany({ include: { uses: true } })
    const vulnerable = deps.filter((d: any) => statusOf({
      installed:  [...new Set(d.uses.map((u: any) => u.installed).filter(Boolean))] as string[],
      latest:     d.latest, deprecated: d.deprecated,
      advisories: d.advisories ?? {}, checkedAt: d.checkedAt,
    }).status === 'vulnerable').length

    return { servers: rows, dependencies: { vulnerable } }
  },

  // ── host — POST /posture  X-Service-Method: host ──────────────────
  // The box this Basecamp runs on, what /hub/security/ draws: the
  // hub's host row's own grade, staleness on read as `view` does, and the
  // `hub.*` controls graded from the same report. With no host row there is
  // nothing reading the box, and `enrolled: false` says so.
  async host() {
    $.dispatch = false   // read-shaped
    const now    = Date.now()
    const { server, row, hub } = await gradeHubNow(sys(), $.app.push, now)
    const machine  = server ? await postureView(server, row) : null
    const controls = [...hub, ...(machine?.controls ?? [])]
    return {
      enrolled: !!server,
      serverId: server?.id ?? null, serverName: server?.name ?? null,
      reported: !!row, stale: machine?.stale ?? false, at: row?.at ?? null, controls,
      failing:  controls.filter(c => c.ok === false).length,
      unknown:  controls.filter(c => c.ok === 'unknown').length,
      readings: row?.readings ?? null,
    }
  },

  hooks: {
    before: {
      all:   [sessionScope({ except: ['report', 'host'] })],
      host:  [requireSystemAdmin()],
    },
  },
})
