// @frontierjs/conduit-cloudflare — Cloudflare DNS over conduit.
//
// Extracted from `packages/basecamp/api/src/providers/edge/cloudflare.ts`. Two
// things stayed in basecamp: the MARK (`basecamp:domain:<id>` in `comment`),
// which the app spells, and the refusal to touch an unmarked set (FJS-D560),
// which `setRecords` takes as an `owns` predicate rather than knowing. Purge
// cache is not here — nothing calls it yet.
//
// A write is ONE batch (`/dns_records/batch`): deletes → patches → posts in a
// transaction that applies nothing if one fails. Cloudflare honors no
// idempotency key on it, so this connector never forwards one and a lost
// response is `indeterminate` — the caller re-reads the zone.

import type { ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { envelope, translate, type CfFailure } from './errors.ts'
import type { CfEnvelope, CfZone, CfRecord, CfRecordInput, CfBatchOps, CfBatchResult } from './types.ts'

export * from './types.ts'
export * from './errors.ts'

export const CLOUDFLARE_ADDRESS = 'https://api.cloudflare.com/client/v4'
export const ZONES_PER_PAGE   = 50
export const RECORDS_PER_PAGE = 5000
/** A walk that never ends is a vendor answering `total_pages` wrong, and it
 *  would spend the account's 1,200-per-5-minutes on one screen. */
export const MAX_PAGES = 100

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string): Send {
  return req => conduit.send({ target, ...req })
}

/** One target per ACCOUNT (`provider:cloudflare:<accountId>`): a token is a
 *  workspace's, and a target keyed on the vendor alone serves everybody the
 *  last registrant's zones (FJS-1020). An API token is a bearer; the legacy
 *  global key is not accepted. */
export function cloudflareTarget(opts: { accountId: string; ref: string; address?: string }): TargetDescriptor {
  return {
    id:            `provider:cloudflare:${opts.accountId}`,
    kind:          'provider',
    protocol:      'http',
    address:       (opts.address ?? CLOUDFLARE_ADDRESS).replace(/\/$/, ''),
    auth:          { type: 'bearer', ref: opts.ref },
    registered_at: Date.now(),
    last_seen_at:  null,
  }
}

export class CloudflareError extends Error { constructor(public failure: CfFailure) { super(`Cloudflare: ${failure.kind}${failure.code ? ` (${failure.code})` : ''} — ${failure.message}`) } }

type Row = Record<string, unknown>
const str = (v: unknown) => typeof v === 'string' ? v : ''
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0

async function call<T>(send: Send, req: Omit<ConduitRequest, 'target'>): Promise<{ result: T; totalPages: number }> {
  const r = await send<CfEnvelope<T>>({ ...req, validate: envelope })
  if (r.error) throw new CloudflareError(translate(r.error, r.meta.status))
  return { result: r.data.result, totalPages: num(r.data.result_info?.total_pages) || 1 }
}

async function walk(send: Send, path: string): Promise<Row[]> {
  const out: Row[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { result, totalPages } = await call<Row[]>(send, { method: 'GET', path: `${path}&page=${page}` })
    if (Array.isArray(result)) out.push(...result)
    if (page >= totalPages) return out
  }
  throw new CloudflareError({ kind: 'refused', message: `${path} still had pages after ${MAX_PAGES}`, retryable: false })
}

const toZone = (z: Row): CfZone => ({ id: str(z.id), name: str(z.name), status: str(z.status) })
const toRecord = (r: Row): CfRecord => ({ id: str(r.id), type: str(r.type), name: str(r.name), content: str(r.content), proxied: r.proxied === true, ttl: num(r.ttl), comment: str(r.comment) || null })

/** Cloudflare answers a name lower-case, no trailing dot, and compares a CNAME target the same way. */
export const host = (name: string) => name.trim().toLowerCase().replace(/\.$/, '')
export const setKey = (type: string, name: string) => `${type.toUpperCase()} ${host(name)}`
const sameContent = (type: string, a: string, b: string) => type.toUpperCase() === 'CNAME' ? host(a) === host(b) : a === b
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME'])

export function toBody(r: CfRecordInput): Row {
  const type = r.type.toUpperCase()
  return { type, name: host(r.name), content: r.content, ttl: r.ttl ?? 1, comment: r.comment ?? null, ...(PROXIABLE.has(type) ? { proxied: r.proxied === true } : {}) }
}

/** Does this token open anything? A 4xx is Cloudflare saying no to THIS token;
 *  anything else is not knowing, and must not mark a working credential broken. */
export async function verify(send: Send): Promise<boolean> {
  const r = await send<CfEnvelope<Row[]>>({ method: 'GET', path: '/zones?per_page=5', validate: envelope })
  if (r.error) { if (r.meta.status && r.meta.status < 500) return false; throw new CloudflareError(translate(r.error, r.meta.status)) }
  return Array.isArray(r.data.result) && r.data.result.length > 0
}

export const zones   = async (send: Send): Promise<CfZone[]> => (await walk(send, `/zones?per_page=${ZONES_PER_PAGE}`)).map(toZone).filter(z => z.id)
export const zone    = async (send: Send, zoneId: string): Promise<CfZone> => toZone((await call<Row>(send, { method: 'GET', path: `/zones/${encodeURIComponent(zoneId)}` })).result ?? {})
export const records = async (send: Send, zoneId: string): Promise<CfRecord[]> =>
  (await walk(send, `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=${RECORDS_PER_PAGE}`)).map(toRecord).filter(r => r.id)

/** One batch, or nothing when there is nothing to change. Never keyed. */
export async function batch(send: Send, zoneId: string, ops: CfBatchOps): Promise<CfBatchResult> {
  const empty = { deletes: [], patches: [], posts: [] }
  if (!ops.deletes?.length && !ops.patches?.length && !ops.posts?.length) return empty
  const { result } = await call<Row>(send, { method: 'POST', path: `/zones/${encodeURIComponent(zoneId)}/dns_records/batch`,
    body: { deletes: ops.deletes ?? [], patches: ops.patches ?? [], posts: (ops.posts ?? []).map(toBody) } })
  const list = (k: string) => (Array.isArray(result?.[k]) ? result[k] as Row[] : []).map(toRecord)
  return { deletes: list('deletes'), patches: list('patches'), posts: list('posts') }
}

/**
 * Make the named (type, name) sets hold exactly `wanted`, refusing BEFORE
 * anything is sent if any set holds a record `owns` does not claim — the
 * app's mark is what `owns` reads. A record already holding a wanted value
 * is kept and patched only where ttl, proxied or comment differ.
 */
export async function setRecords(send: Send, zoneId: string, wanted: CfRecordInput[], owns: (r: CfRecord) => boolean): Promise<CfRecord[]> {
  const byKey = new Map<string, CfRecordInput[]>()
  for (const r of wanted) { const k = setKey(r.type, r.name); byKey.set(k, [...(byKey.get(k) ?? []), r]) }
  const sets = new Map<string, CfRecord[]>([...byKey.keys()].map(k => [k, []]))
  for (const r of await records(send, zoneId)) sets.get(setKey(r.type, r.name))?.push(r)
  for (const [key, recs] of sets) {
    const foreign = recs.find(r => !owns(r))
    if (foreign) throw new CloudflareError({ kind: 'refused', message: `${key} holds a record this app did not write (${foreign.id}${foreign.comment ? `, comment "${foreign.comment}"` : ''}) — refusing to change it`, retryable: false })
  }
  const ops: Required<CfBatchOps> = { deletes: [], patches: [], posts: [] }
  const kept: CfRecord[] = []
  for (const [key, want] of byKey) {
    const have = [...sets.get(key)!]
    for (const w of want) {
      const body = toBody(w)
      const i = have.findIndex(h => sameContent(h.type, h.content, w.content))
      if (i < 0) { ops.posts.push(w); continue }
      const [h] = have.splice(i, 1)
      const stale = h.ttl !== body.ttl || h.comment !== body.comment || ('proxied' in body && h.proxied !== body.proxied)
      if (!stale) { kept.push(h); continue }
      const { type: _t, name: _n, content: _c, ...changed } = body
      ops.patches.push({ id: h.id, ...(changed as Partial<CfRecordInput>) })
    }
    for (const h of have) ops.deletes.push({ id: h.id })
  }
  const done = await batch(send, zoneId, ops)
  return [...kept, ...done.patches, ...done.posts]
}
