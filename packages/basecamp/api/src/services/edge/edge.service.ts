// src/services/edge/edge.service.ts
// A workspace's DNS zones, read off the vendor that holds them.
//
// GET /edge dispatches on X-Service-Method, collection-level:
//   zones     every edge account this workspace holds, each with its zones
//   records   one zone's records beside this workspace's `Domain` rows — the PLAN
//   sync      push one Domain: its App's ingress record, then its CNAME — the APPLY
//   syncStep  the same push from `domain:dns`, internal; a deleted Domain's CNAME
//             is removed, and a Domain that cannot be pushed YET is skipped
//
// Nothing here is stored. A zone and a record are the vendor's to state, and
// the only copy that cannot drift is the one that is not kept — the catalog
// read in servers.service.ts makes the same argument about a price list.
//
// ─── Read at the level `Domain` is read ──────────────────────────────────
//
// A record is the other half of a `Domain` row: the hostname this app intends to
// serve, against what the zone says it serves. So the reads are graded at
// READER, which is `Domain`'s read gate, and not at the Secret's 5 — the
// credential is what an administrator guards, and none of it reaches a caller.
//
// That makes the account lookup `asSystem()`, off the request's client. A scoped client below 5 is refused
// the `Secret` read outright, and a screen at a developer's standing would then
// say *no account connected* about a workspace that has one. The confinement is
// the `where` — this workspace, `provider_key`, an edge vendor — and the
// `select`, which names no column but the four a picker needs.
//
// ─── What the vendor said stays the vendor's ─────────────────────────────
//
// A refusal from Cloudflare is a 502 carrying its message: the request was
// well-formed and the party behind this app said no, which is neither a 500
// (nothing here broke) nor a 400 (the caller asked correctly). In `zones` it is
// caught PER ACCOUNT, so one revoked token does not blank the others.

import { createService, NotFound, BadRequest, BadGateway, Conflict, $ } from '@frontierjs/junction'
import { LEVELS }                 from '@frontierjs/litestone'
import { sessionScope, internalOnly, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws }                 from '../../core/resource.ts'
import { servingAddresses }       from '../../core/runtime.ts'
import { edgeConnectorFor, edgeProviders, appMark, domainMark } from '../../providers/edge/index.ts'
import { targetFor }              from '../../providers/compute/index.ts'
import { sendVia }                from '../../providers/compute/accounts.ts'
import type { EdgeConnector, EdgeRecord, EdgeZone } from '../../providers/edge/index.ts'
import type { AccountSend }      from '../../providers/compute/index.ts'
import type { BasecampApp }       from '../../basecamp.types.ts'
import type { ProviderKind }      from '../../../../db/schema.d.ts'

export interface EdgeAccount {
  id:           string
  name:         string
  providerKind: ProviderKind
  isVerified:   boolean
}

/** Record types that SERVE a hostname. An MX or a TXT at the same name answers
 *  a different question, and counting one would hide a hostname with no route. */
const SERVING = new Set(['A', 'AAAA', 'CNAME'])

const fqdn = (name: string) => name.trim().toLowerCase().replace(/\.$/, '')

/** An App's ingress record, named from its id so a rename rewrites nothing —
 *  and a customer who typed the CNAME by hand never has to again (`FJS-D561`). */
export const ingressName = (appId: string, zone: string) => `${appId}.${fqdn(zone)}`

/** A zone, and the account that can write it. */
interface ZoneAt { account: EdgeAccount; connector: EdgeConnector; send: AccountSend; zone: EdgeZone }

/**
 * This workspace's edge accounts — the `provider_key` Secrets at a vendor this
 * app reads zones at. The one lookup the edge service and the portal's `edge`
 * entry share, so *is edge configured* and *which zones are there* cannot
 * disagree about which rows count.
 */
export async function edgeAccounts(): Promise<EdgeAccount[]> {
  const kinds = edgeProviders().map(p => p.kind)
  // The REQUEST's client elevated, not the app's: it keeps the caller's
  // tenant, where the app client's bypass would read every tenant.
  const rows  = await db().asSystem().secret.findMany({
    where:   { workspaceId: ws(), kind: 'provider_key', providerKind: { in: kinds } },
    select:  { id: true, name: true, providerKind: true, isVerified: true },
    orderBy: { name: 'asc' },
  })
  return rows as EdgeAccount[]
}

/**
 * Ask every account whether its token still opens a zone.
 *
 * `healthy` when all do, `degraded` when any does not, `unreachable` when the
 * vendor could not be asked at all — `verify` throws only for that, and answers
 * false for a token it refused.
 */
export async function edgeHealth(app: BasecampApp, accounts: EdgeAccount[]): Promise<'healthy' | 'degraded' | 'unreachable'> {
  let refused = false
  for (const a of accounts) {
    const connector = edgeConnectorFor(a.providerKind)
    if (!connector) continue
    try {
      if (!(await connector.verify(sendVia(app, targetFor(connector.kind, a.id))))) refused = true
    } catch {
      return 'unreachable'
    }
  }
  return refused ? 'degraded' : 'healthy'
}

const why = (err: unknown) => err instanceof Error ? err.message : String(err)

/** A refusal meaning *not yet* rather than *wrong*: no ingress zone, an App
 *  running nowhere, a hostname in no connected zone, a redirect. `sync` answers
 *  it as the 409 it is; `syncStep` records it as skipped, because a workspace
 *  that never connected an edge account writes Domains too, and a job failing
 *  on every one of them is an alarm about nothing. A record somebody else made
 *  is a plain `Conflict` — that one a person has to act on. */
class NotYet extends Conflict {}

interface DomainRow { id: string; appId: string; hostname: string; redirectTo: string | null; proxied: boolean }

export function createEdgeService(app: BasecampApp) {
  async function account(id: unknown): Promise<EdgeAccount> {
    if (!id) throw new BadRequest('accountId is required — which edge account to ask')
    const found = (await edgeAccounts()).find(a => a.id === String(id))
    if (!found) throw new NotFound(`Edge account '${id}' not found`)
    return found
  }

  const sendFor = (a: EdgeAccount) => {
    const connector = edgeConnectorFor(a.providerKind)!
    return { connector, send: sendVia(app, targetFor(connector.kind, a.id)) }
  }

  /** This workspace's ingress zone, or null when none is set. The pair is read
   *  `asSystem()` confined to the workspace, for `edgeAccounts`' reason: a
   *  developer reads the drift, and the Workspace row is not what they guard. */
  async function ingressZone(accounts: EdgeAccount[]): Promise<ZoneAt | null> {
    const row = await db().asSystem().workspace.findFirst({
      where: { id: ws() }, select: { ingressAccountId: true, ingressZoneId: true },
    }) as { ingressAccountId: string | null; ingressZoneId: string | null } | null
    if (!row?.ingressAccountId || !row.ingressZoneId) return null
    const account = accounts.find(a => a.id === row.ingressAccountId)
    if (!account)
      throw new Conflict(`The ingress zone names edge account '${row.ingressAccountId}', which this workspace no longer holds — set it again`)
    const { connector, send } = sendFor(account)
    return { account, connector, send, zone: await connector.zone(send, row.ingressZoneId) }
  }

  /** The connected zone a hostname lives in — the LONGEST zone name it ends
   *  with, so `a.shop.example.test` belongs to `shop.example.test` where both
   *  are connected. Null when no account opens one. */
  async function zoneOf(accounts: EdgeAccount[], hostname: string): Promise<ZoneAt | null> {
    const host = fqdn(hostname)
    let best: ZoneAt | null = null
    for (const account of accounts) {
      const { connector, send } = sendFor(account)
      for (const zone of await connector.zones(send)) {
        const apex = fqdn(zone.name)
        if ((host === apex || host.endsWith(`.${apex}`)) && apex.length > fqdn(best?.zone.name ?? '').length)
          best = { account, connector, send, zone }
      }
    }
    return best
  }

  // ── push — one Domain, applied ──────────────────────────────────────
  //
  // Its App's ingress record first — an A per address the App runs at — then
  // the Domain's CNAME to it, carrying `Domain.proxied` (`FJS-D563`). In that
  // order so a CNAME never points at a name that is not there yet. Answers
  // what it wrote.
  //
  // Every refusal is a 409 saying what to do, and is decided before anything
  // is written. None of them publishes a CNAME that resolves nowhere: not one
  // with no ingress zone, not one for an App running on no machine, and not one
  // beside a record somebody else made (`FJS-D560` — the connector refuses the
  // CNAME's own set, and this refuses the A or AAAA beside it, which Cloudflare
  // would otherwise reject with a message about neither).
  async function push(domain: DomainRow) {
    if (domain.redirectTo)
      throw new NotYet(`${domain.hostname} redirects, and no machine routes a redirect yet (FJS-1610) — nothing to point it at`)

    const host     = fqdn(domain.hostname)
    const accounts = await edgeAccounts()
    let ingress: ZoneAt | null, home: ZoneAt | null, addresses: string[], present: EdgeRecord[]
    try {
      ingress = await ingressZone(accounts)
      if (!ingress)
        throw new NotYet('This workspace has no ingress zone — set one (an edge account and a zone it opens) before a Domain can be pushed')
      addresses = await servingAddresses(app.db, domain.appId)
      if (!addresses.length)
        throw new NotYet(`${domain.hostname}'s app runs on no online server yet — deploy it, or the record would point nowhere`)
      home = await zoneOf(accounts, host)
      if (!home) throw new NotYet(`No connected zone holds ${domain.hostname} — connect the account that has it`)
      present = await home.connector.records(home.send, home.zone.id)
    } catch (err) {
      if (err instanceof Conflict) throw err
      throw new BadGateway(why(err))
    }

    const foreign = present.filter(r => SERVING.has(r.type) && fqdn(r.name) === host && !r.mark)
    if (foreign.length)
      throw new Conflict(`${domain.hostname} already holds ${foreign.map(r => `${r.type} ${r.content}`).join(', ')}, `
        + 'which basecamp did not write — remove it at the vendor, or adopt it once adopt exists')

    const name = ingressName(domain.appId, ingress.zone.name)
    try {
      const ingressRecords = await ingress.connector.setRecords(ingress.send, ingress.zone.id, appMark(domain.appId),
        addresses.map(content => ({ type: 'A', name, content })))
      const [record] = await home.connector.setRecords(home.send, home.zone.id, domainMark(domain.id),
        [{ type: 'CNAME', name: host, content: name, proxied: domain.proxied }])
      return { domainId: domain.id, hostname: host, record, ingress: { name, addresses, records: ingressRecords } }
    } catch (err) {
      throw new BadGateway(why(err))
    }
  }

  /** A deleted Domain's CNAME, removed — the one carrying its mark, and no
   *  other. The App's ingress record stays: it is the App's, and another of
   *  its Domains may point at it. */
  async function unpush(domain: DomainRow) {
    const host = fqdn(domain.hostname)
    const mark = domainMark(domain.id)
    try {
      const home = await zoneOf(await edgeAccounts(), host)
      if (!home) throw new NotYet(`No connected zone holds ${domain.hostname} — nothing of basecamp's to remove`)
      const ours = (await home.connector.records(home.send, home.zone.id))
        .some(r => fqdn(r.name) === host && r.mark?.domainId === domain.id)
      const removed = ours
        ? await home.connector.deleteRecords(home.send, home.zone.id, [{ type: 'CNAME', name: host, mark }])
        : []
      return { domainId: domain.id, hostname: host, removed }
    } catch (err) {
      if (err instanceof Conflict) throw err
      throw new BadGateway(why(err))
    }
  }

  return createService({
    name: 'edge',
    reservedQuery: [...WORKSPACE_QUERY, 'accountId', 'zoneId'],

    // `methods:` rather than the scan, for infra.service.ts's reason: a service
    // with no model otherwise answers every CRUD verb it was never given.
    // `sync` at `Domain`'s write level: it is the Domain written somewhere else.
    methods: [
      ...['zones', 'records'].map(method => ({ method, gate: LEVELS.READER })),
      { method: 'sync', gate: LEVELS.ADMINISTRATOR },
      { method: 'syncStep', gate: LEVELS.READER },
    ],

    // ── zones ──────────────────────────────────────────────────────────
    //
    // An account with no zones and an account whose vendor refused are two
    // different screens, so each carries `zones` OR `error`, never an empty
    // list standing in for a failure.
    async zones() {
      const accounts = await edgeAccounts()
      const out = await Promise.all(accounts.map(async a => {
        const { connector, send } = sendFor(a)
        try {
          return { ...a, label: connector.label, zones: await connector.zones(send) as EdgeZone[], error: null }
        } catch (err) {
          return { ...a, label: connector.label, zones: null, error: why(err) }
        }
      }))
      return { accounts: out }
    },

    // ── records ────────────────────────────────────────────────────────
    //
    // The zone's records, and the disagreement with this workspace's `Domain`
    // rows that is the screen's reason to exist:
    //
    //   domainId   on a serving record whose name is a Domain's hostname
    //   missing    a Domain inside this zone with no serving record at all —
    //              a hostname this app means to answer on that resolves nowhere
    //   conflicts  a Domain whose name holds a serving record this app did not
    //              mark — `sync` refuses it (`FJS-D560`), so it is named here
    //   orphans    a record this app marked for a Domain or App that is gone
    //   stale      an App's ingress record whose addresses are not where it
    //              runs (`FJS-D561`), as `have` against `want`
    //
    // Which records are OURS is the mark, which the connector reads.
    async records() {
      const data   = ($.data ?? {}) as Record<string, unknown>
      const a      = await account(data.accountId ?? $.reserved.accountId)
      const zoneId = data.zoneId ?? $.reserved.zoneId
      if (!zoneId) throw new BadRequest('zoneId is required — which zone to read')

      const { connector, send } = sendFor(a)
      let zone: EdgeZone, records: EdgeRecord[]
      try {
        [zone, records] = await Promise.all([
          connector.zone(send, String(zoneId)),
          connector.records(send, String(zoneId)),
        ])
      } catch (err) {
        throw new BadGateway(why(err))
      }

      const [domains, apps] = await Promise.all([
        db().domain.findMany({
          where:  { workspaceId: ws() },
          select: { id: true, hostname: true, appId: true },
        }) as Promise<{ id: string; hostname: string; appId: string }[]>,
        db().app.findMany({ where: { workspaceId: ws() }, select: { id: true } }) as Promise<{ id: string }[]>,
      ])

      const apex    = fqdn(zone.name)
      const inZone  = domains.filter(d => { const h = fqdn(d.hostname); return h === apex || h.endsWith(`.${apex}`) })
      const byHost  = new Map(inZone.map(d => [fqdn(d.hostname), d]))
      const serving = records.filter(r => SERVING.has(r.type))
      const served  = new Set(serving.map(r => fqdn(r.name)))
      const foreign = new Set(serving.filter(r => !r.mark).map(r => fqdn(r.name)))
      const liveDomain = new Set(domains.map(d => d.id))
      const liveApp    = new Set(apps.map(x => x.id))

      // An ingress record's addresses against where its App runs — one read
      // per App marked in this zone, which is the ingress zone or none.
      const ingress = new Map<string, EdgeRecord[]>()
      for (const r of records)
        if (r.mark?.appId && liveApp.has(r.mark.appId) && r.type === 'A')
          ingress.set(r.mark.appId, [...(ingress.get(r.mark.appId) ?? []), r])
      const stale = []
      for (const [appId, recs] of ingress) {
        const have = recs.map(r => r.content).sort()
        const want = await servingAddresses(app.db, appId)
        if (have.join() !== want.join()) stale.push({ appId, name: recs[0].name, have, want })
      }

      return {
        account: { id: a.id, name: a.name, providerKind: a.providerKind },
        zone,
        records: records.map(r => ({
          ...r,
          domainId: SERVING.has(r.type) ? byHost.get(fqdn(r.name))?.id ?? null : null,
        })),
        missing:   inZone.filter(d => !served.has(fqdn(d.hostname))),
        conflicts: inZone.filter(d => foreign.has(fqdn(d.hostname))),
        orphans:   records.filter(r =>
          (r.mark?.domainId && !liveDomain.has(r.mark.domainId)) || (r.mark?.appId && !liveApp.has(r.mark.appId))),
        stale,
      }
    },

    // ── sync ───────────────────────────────────────────────────────────
    //
    // One Domain, pushed by a person — `push` above is what is written, and
    // each refusal it makes is the 409 it answers here.
    async sync() {
      const data = ($.data ?? {}) as Record<string, unknown>
      const id   = $.id ?? data.domainId
      if (!id) throw new BadRequest('domainId is required — which Domain to push')

      const domain = await db().domain.findFirst({ where: { id: String(id), workspaceId: ws() } }) as DomainRow | null
      if (!domain) throw new NotFound(`Domain '${id}' not found`)
      return push(domain)
    },

    // ── syncStep — the `domain:dns` job's own push ───────────────────
    //
    // Internal, at `Domain`'s read level: the job runs as whoever wrote the
    // Domain or released the App, and a developer's release moving the app is
    // what makes its ingress record wrong. The confinement is the read below —
    // a Domain in another workspace answers nothing.
    //
    // A DELETED Domain is read too, because its CNAME is still in the zone
    // pointing at an app that may since have gone. Only the record carrying its
    // own mark goes: a hostname released and claimed again by a new Domain
    // holds the newcomer's CNAME by the time this runs.
    async syncStep() {
      const id     = String($.id)
      const domain = await db().domain.findFirst({ where: { id, workspaceId: ws() }, withDeleted: true }) as
        (DomainRow & { deletedAt: string | null }) | null
      if (!domain) throw new NotFound(`Domain '${id}' not found`)
      try {
        return domain.deletedAt ? await unpush(domain) : await push(domain)
      } catch (err) {
        if (err instanceof NotYet) return { domainId: domain.id, hostname: fqdn(domain.hostname), skipped: err.message }
        throw err
      }
    },

    hooks: {
      before: {
        all: [sessionScope(app)],
        syncStep: [internalOnly()],
      },
    },
  })
}
