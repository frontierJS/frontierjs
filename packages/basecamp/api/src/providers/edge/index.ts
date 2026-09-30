// src/providers/edge/index.ts
// Reading a vendor's DNS ZONES — the boundary, and who speaks it.
//
// The compute pattern, for the reason `FJS-D558` gives: a Cloudflare token is a
// workspace ACCOUNT, a `Secret` of kind `provider_key`, registered as the
// conduit target `provider:<kind>:<accountId>` by `compute/accounts.ts`. So the
// target string, the send half and the registration are compute's and are
// imported rather than written again; what lives here is the half a target
// cannot carry — which path a vendor wants for a zone, and what its answer means.
//
// Writes take libdns's shape (`FJS-D562`) and carry a MARK (`FJS-D560`): the
// caller says what the mark means, the connector how its vendor spells it —
// `MachineMark`'s argument, for the same reason. A write goes through `sendVia`
// and so meets its guard: a process pointed at the real vendor by mistake
// changes live DNS, which is the same accident as a machine made by mistake.

import type { TargetDescriptor }  from '@frontierjs/conduit'
import type { ProviderKind }      from '../../../../db/schema.d.ts'
import type { AccountSend }       from '../compute/index.ts'
import { FLEET }                  from '../compute/index.ts'
import { cloudflare }             from './cloudflare.ts'

/** One zone, as a list of them needs it. `status` is the vendor's word and is
 *  passed through — a zone is `active` or it is waiting on something the
 *  operator does at their registrar, and nothing here decides on it yet. */
export interface EdgeZone {
  id:     string
  name:   string
  status: string
}

/**
 * One record, as the vendor holds it — its id and nothing of ours.
 *
 * `comment` is carried because it is where this app will write its mark
 * (`basecamp:domain:<id>`, cloudflare-edge D3): *which records are ours* is a
 * read of this field, so a connector that dropped it would make every record
 * look foreign.
 */
export interface EdgeRecord {
  id:      string
  type:    string
  name:    string
  content: string
  proxied: boolean
  ttl:     number
  comment: string | null
  /** The mark this app wrote, read back — null on a record it did not write,
   *  which is the record a set or a delete refuses to touch. */
  mark:    RecordMark | null
}

/**
 * How this app marks a record it wrote. A structure, for `MachineMark`'s
 * reason: Cloudflare spells it in a record's `comment`, and a vendor with no
 * comment field spells it as a TXT registry, so the spelling is each
 * connector's and a caller never writes one.
 */
export interface RecordMark {
  /** Every record this app wrote — what makes a record OURS. */
  fleet:     string
  /** Which `Domain` asked for it. Absent on a record marked by the fleet alone. */
  domainId?: string
}

/** The mark a `Domain`'s records carry. */
export function domainMark(domainId: string): RecordMark {
  return { fleet: FLEET, domainId }
}

/** A record to write. `name` is the full hostname; `ttl` 1 is the vendor's
 *  *automatic*, and `proxied` is read only for the types that can carry it. */
export interface EdgeRecordInput {
  type:     string
  name:     string
  content:  string
  ttl?:     number
  proxied?: boolean
}

/** A record to delete: its set, and one value in it when the set has several. */
export interface EdgeRecordRef {
  type:     string
  name:     string
  content?: string
}

/** One edge vendor's dialect. `kind`, `label`, `descriptor` and `verify` are the
 *  account half every connector shares (`AccountConnector` in
 *  `compute/accounts.ts`); `zones` and `records` are the edge's own. */
export interface EdgeConnector {
  kind:    ProviderKind
  label:   string
  address: string
  descriptor(opts: { accountId: string; ref: string; address?: string }): TargetDescriptor
  /** Does this token open at least one zone? */
  verify(send: AccountSend): Promise<boolean>
  zones(send: AccountSend): Promise<EdgeZone[]>
  zone(send: AccountSend, zoneId: string): Promise<EdgeZone>
  records(send: AccountSend, zoneId: string): Promise<EdgeRecord[]>

  /* The writes, libdns's three (`FJS-D562`). Each is ONE request that applies
   * whole or not at all, so a retry repeats a write rather than finishing one.
   * `setRecords` and `deleteRecords` refuse, before anything is sent, a
   * (name, type) set holding a record this app did not mark (`FJS-D560`). */

  /** Add these records, marked. Changes no record already there. */
  appendRecords(send: AccountSend, zoneId: string, mark: RecordMark, records: EdgeRecordInput[]): Promise<EdgeRecord[]>
  /** Make each (name, type) set named here hold exactly these records, and
   *  touch no other set. Answers the sets as they now stand. */
  setRecords(send: AccountSend, zoneId: string, mark: RecordMark, records: EdgeRecordInput[]): Promise<EdgeRecord[]>
  /** Remove the records these refs match. Answers what was removed. */
  deleteRecords(send: AccountSend, zoneId: string, refs: EdgeRecordRef[]): Promise<EdgeRecord[]>
}

const CONNECTORS: Partial<Record<ProviderKind, EdgeConnector>> = {
  cloudflare,
}

/** The vendors this app reads zones at — what `ProviderKind` values an edge
 *  account may carry, for a `where` that has to name them as a set. */
export function edgeProviders(): { kind: ProviderKind; label: string }[] {
  return Object.values(CONNECTORS)
    .filter((c): c is EdgeConnector => Boolean(c))
    .map(c => ({ kind: c.kind, label: c.label }))
}

/** The edge connector for a vendor, or null where this app reads no zones there. */
export function edgeConnectorFor(kind: ProviderKind | null | undefined): EdgeConnector | null {
  if (!kind) return null
  return CONNECTORS[kind] ?? null
}
