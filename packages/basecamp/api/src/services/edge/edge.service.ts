// src/services/edge/edge.service.ts
// A workspace's DNS zones, read off the vendor that holds them.
//
// GET /edge dispatches on X-Service-Method, collection-level:
//   zones     every edge account this workspace holds, each with its zones
//   records   one zone's records beside this workspace's `Domain` rows
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

import { createService, NotFound, BadRequest, BadGateway, $ } from '@frontierjs/junction'
import { LEVELS }                 from '@frontierjs/litestone'
import { sessionScope, WORKSPACE_QUERY } from '../../core/hooks.ts'
import { db, ws }                 from '../../core/resource.ts'
import { edgeConnectorFor, edgeProviders } from '../../providers/edge/index.ts'
import { targetFor }              from '../../providers/compute/index.ts'
import { sendVia }                from '../../providers/compute/accounts.ts'
import type { EdgeRecord, EdgeZone } from '../../providers/edge/index.ts'
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

  return createService({
    name: 'edge',
    reservedQuery: [...WORKSPACE_QUERY, 'accountId', 'zoneId'],

    // `methods:` rather than the scan, for infra.service.ts's reason: a service
    // with no model otherwise answers every CRUD verb it was never given.
    methods: ['zones', 'records'].map(method => ({ method, gate: LEVELS.READER })),

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
    //
    // Which records are OURS is not answered here. That is the mark in
    // `comment`, and who may write it is IDEAS/cloudflare-edge.md D3.
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

      const domains = await db().domain.findMany({
        where:  { workspaceId: ws() },
        select: { id: true, hostname: true, appId: true },
      }) as { id: string; hostname: string; appId: string }[]

      const apex    = fqdn(zone.name)
      const inZone  = domains.filter(d => { const h = fqdn(d.hostname); return h === apex || h.endsWith(`.${apex}`) })
      const byHost  = new Map(inZone.map(d => [fqdn(d.hostname), d]))
      const served  = new Set(records.filter(r => SERVING.has(r.type)).map(r => fqdn(r.name)))

      return {
        account: { id: a.id, name: a.name, providerKind: a.providerKind },
        zone,
        records: records.map(r => ({
          ...r,
          domainId: SERVING.has(r.type) ? byHost.get(fqdn(r.name))?.id ?? null : null,
        })),
        missing: inZone.filter(d => !served.has(fqdn(d.hostname))),
      }
    },

    hooks: {
      before: {
        all: [sessionScope(app)],
      },
    },
  })
}
