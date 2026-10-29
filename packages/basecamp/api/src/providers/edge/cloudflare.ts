// src/providers/edge/cloudflare.ts
// Cloudflare's dialect. `platform/cloudflare.ts` speaks its Workers half and
// reads every answer through `unwrap` and `walk` here, so the envelope has one
// reader.
//
// Everything vendor-specific is here: the `/client/v4` base, the envelope every
// answer arrives in, that a list is paged by `result_info.total_pages`, and
// that a record's `ttl` of 1 means *automatic*. A caller sees `EdgeZone` and
// `EdgeRecord` and never the envelope.
//
// ─── A 200 is not a success ──────────────────────────────────────────────
//
// Cloudflare answers `{ success, errors, result, result_info }`, and `success`
// can be false on a 200. Conduit grades the status, so an envelope that says it
// failed arrives here as data, and reading `result` off it anyway gives an
// empty list — a zone with no records, which is a plausible answer and a wrong
// one. Every read goes through `unwrap`, which refuses it with Cloudflare's own
// message.
//
// ─── A write is one batch ────────────────────────────────────────────────
//
// `POST /zones/<id>/dns_records/batch` runs deletes → patches → posts in one
// transaction and applies nothing if one fails. Per-record calls would leave a
// set half-written on the third of four, with a retry that then finds a state
// neither the old answer nor the new one. The mark is the record's `comment`,
// `basecamp:domain:<id>` (`FJS-D560`): on every plan, where tags are Pro.

import { env }                    from '../../core/env.ts'
import { targetFor, FLEET }       from '../compute/index.ts'
import type { TargetDescriptor }  from '@frontierjs/conduit'
import type { AccountSend }       from '../compute/index.ts'
import type { EdgeConnector, EdgeZone, EdgeRecord, EdgeRecordInput, RecordMark } from './index.ts'

/** Where Cloudflare is. Overridden by `CLOUDFLARE_URL` for the dev sink, which
 *  serves the same `/client/v4` prefix so the paths below are the real ones. */
const CF_API = 'https://api.cloudflare.com/client/v4'

/** Zones page at 50 at most. Records take a large page — external-dns asks for
 *  5,000 — so most zones are one request and the walk is the rare path. */
const ZONES_PER_PAGE   = 50
const RECORDS_PER_PAGE = 5000

/** A walk that never ends is a vendor answering `total_pages` wrong, and it
 *  would spend the account's 1,200-requests-per-5-minutes on one screen. */
const MAX_PAGES = 100

type Row = Record<string, unknown>

const str  = (v: unknown): string  => typeof v === 'string' ? v : ''
const num  = (v: unknown): number  => typeof v === 'number' && Number.isFinite(v) ? v : 0

/** The `result` of one answer, or a throw naming why there is none. */
export function unwrap(res: Awaited<ReturnType<AccountSend>>): { result: unknown; totalPages: number } {
  const body  = (res.data ?? {}) as Row
  const first = Array.isArray(body.errors) ? (body.errors as Row[])[0] : undefined

  // A 4xx still carries the envelope, and its message is the only place that
  // says WHY — a refused write answers 400, and `client_error (HTTP 400)` on
  // screen tells an operator nothing about the CNAME already at that name.
  if (res.error)
    throw new Error(`Cloudflare: ${res.error.kind}${res.status ? ` (HTTP ${res.status})` : ''}`
      + `${str(first?.message) ? ` — ${str(first?.message)}` : res.error.message ? ` — ${res.error.message}` : ''}`)

  if (body.success !== true)
    throw new Error(`Cloudflare refused the request: ${str(first?.message) || 'success was not true'}`)
  return { result: body.result, totalPages: num((body.result_info as Row | undefined)?.total_pages) || 1 }
}

/** Every page of one list. `path` carries its own query, so the page is appended. */
export async function walk(send: AccountSend, path: string): Promise<Row[]> {
  const out: Row[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { result, totalPages } = unwrap(await send({ method: 'GET', path: `${path}&page=${page}` }))
    if (Array.isArray(result)) out.push(...(result as Row[]))
    if (page >= totalPages) return out
  }
  throw new Error(`Cloudflare: ${path} still had pages after ${MAX_PAGES}`)
}

function toZone(z: Row): EdgeZone {
  return { id: str(z.id), name: str(z.name), status: str(z.status), account: str((z.account as Row | undefined)?.id) || null }
}

/** The mark as a comment. The fleet alone is `basecamp`; a Domain's is
 *  `basecamp:domain:<id>` and an App's ingress record `basecamp:app:<id>`. */
function spell(mark: RecordMark): string {
  if (mark.domainId) return `${mark.fleet}:domain:${mark.domainId}`
  if (mark.appId)    return `${mark.fleet}:app:${mark.appId}`
  return mark.fleet
}

/** The mark a comment carries, or null. `basecamp-ish` and `added by hand` are
 *  not ours: the fleet word must be the whole comment or end at a colon. */
function read(comment: string): RecordMark | null {
  if (comment === FLEET) return { fleet: FLEET }
  const m = comment.match(new RegExp(`^${FLEET}:(domain|app):(.+)$`))
  if (!m) return null
  return m[1] === 'domain' ? { fleet: FLEET, domainId: m[2] } : { fleet: FLEET, appId: m[2] }
}

function toRecord(r: Row): EdgeRecord {
  const comment = str(r.comment) || null
  return {
    id:      str(r.id),
    type:    str(r.type),
    name:    str(r.name),
    content: str(r.content),
    proxied: r.proxied === true,
    ttl:     num(r.ttl),
    comment,
    mark:    comment ? read(comment) : null,
  }
}

/** Cloudflare answers a name as a lower-case FQDN with no trailing dot, and
 *  compares a CNAME's target the same way; anything else is compared as sent. */
const host = (name: string) => name.trim().toLowerCase().replace(/\.$/, '')
const setKey = (type: string, name: string) => `${type.toUpperCase()} ${host(name)}`
const sameContent = (type: string, a: string, b: string) =>
  type.toUpperCase() === 'CNAME' ? host(a) === host(b) : a === b

/** Only these may be proxied; Cloudflare refuses the field on the rest. */
const PROXIABLE = new Set(['A', 'AAAA', 'CNAME'])

function toBody(r: EdgeRecordInput, mark: RecordMark): Row {
  const type = r.type.toUpperCase()
  return {
    type, name: host(r.name), content: r.content, ttl: r.ttl ?? 1, comment: spell(mark),
    ...(PROXIABLE.has(type) ? { proxied: r.proxied === true } : {}),
  }
}

/**
 * The records of the sets named, refused if one of them holds a record this
 * app did not mark (`FJS-D560`). Checked for EVERY set before anything is sent:
 * a refusal on the second set after the first was written is the half-write the
 * batch exists to prevent.
 */
async function ownedSets(send: AccountSend, zoneId: string, keys: Set<string>): Promise<Map<string, EdgeRecord[]>> {
  const sets = new Map<string, EdgeRecord[]>([...keys].map(k => [k, []]))
  for (const r of await cloudflare.records(send, zoneId)) sets.get(setKey(r.type, r.name))?.push(r)

  for (const [key, recs] of sets) {
    const foreign = recs.find(r => !r.mark)
    if (foreign)
      throw new Error(`Cloudflare: ${key} holds a record basecamp did not write (${foreign.id}, `
        + `${foreign.comment ? `comment "${foreign.comment}"` : 'no comment'}) — refusing to change it`)
  }
  return sets
}

/** One batch, or nothing when there is nothing to change. */
async function batch(send: AccountSend, zoneId: string, ops: { deletes: Row[]; patches: Row[]; posts: Row[] }) {
  const empty = { deletes: [], patches: [], posts: [] } as Record<'deletes' | 'patches' | 'posts', EdgeRecord[]>
  if (!ops.deletes.length && !ops.patches.length && !ops.posts.length) return empty
  const { result } = unwrap(await send({
    method: 'POST',
    path:   `/zones/${encodeURIComponent(zoneId)}/dns_records/batch`,
    body:   ops,
  }))
  const out = (result ?? {}) as Row
  const list = (k: string) => (Array.isArray(out[k]) ? out[k] as Row[] : []).map(toRecord)
  return { deletes: list('deletes'), patches: list('patches'), posts: list('posts') }
}

export const cloudflare: EdgeConnector = {
  kind:  'cloudflare',
  label: 'Cloudflare',

  // A getter, for digitalocean.ts's reason: a value is captured at import and a
  // test pointing this at a stand-in afterwards would reach the real vendor.
  get address() { return env.CLOUDFLARE_URL || CF_API },

  descriptor({ accountId, ref, address }): TargetDescriptor {
    return {
      id:            targetFor('cloudflare', accountId),
      kind:          'provider',
      protocol:      'http',
      address:       address || cloudflare.address,
      // An API token is a bearer. The legacy global key (`X-Auth-Key` plus an
      // email) is not accepted: it opens every zone the person can see, where a
      // token is scoped to the zones it was minted for.
      auth:          { type: 'bearer', ref },
      registered_at: Date.now(),
      last_seen_at:  null,
    } as TargetDescriptor
  },

  async verify(send): Promise<boolean> {
    // A zone list rather than `/user/tokens/verify`, which verifies a USER
    // token; an account-owned one (`cfat_`, the kind connect asks for,
    // `FJS-D558`) is verified under `/accounts/<id>/`, and the account id is
    // not known yet. A token that opens no zone is valid and useless here.
    const res = await send({ method: 'GET', path: '/zones?per_page=5' })

    // A 4xx is Cloudflare saying no to THIS token. Anything else is not
    // knowing, and must not mark a working credential broken.
    if (res.error) {
      if (res.status && res.status < 500) return false
      throw new Error(`Cloudflare: ${res.error.kind}`)
    }
    const body = (res.data ?? {}) as Row
    return body.success === true && Array.isArray(body.result) && body.result.length > 0
  },

  async zones(send): Promise<EdgeZone[]> {
    return (await walk(send, `/zones?per_page=${ZONES_PER_PAGE}`)).map(toZone).filter(z => z.id)
  },

  async zone(send, zoneId): Promise<EdgeZone> {
    const { result } = unwrap(await send({ method: 'GET', path: `/zones/${encodeURIComponent(zoneId)}` }))
    return toZone((result ?? {}) as Row)
  },

  async records(send, zoneId): Promise<EdgeRecord[]> {
    const path = `/zones/${encodeURIComponent(zoneId)}/dns_records?per_page=${RECORDS_PER_PAGE}`
    return (await walk(send, path)).map(toRecord).filter(r => r.id)
  },

  async appendRecords(send, zoneId, mark, records): Promise<EdgeRecord[]> {
    return (await batch(send, zoneId, { deletes: [], patches: [], posts: records.map(r => toBody(r, mark)) })).posts
  },

  async setRecords(send, zoneId, mark, records): Promise<EdgeRecord[]> {
    const wanted = new Map<string, EdgeRecordInput[]>()
    for (const r of records) {
      const key = setKey(r.type, r.name)
      wanted.set(key, [...(wanted.get(key) ?? []), r])
    }
    const sets = await ownedSets(send, zoneId, new Set(wanted.keys()))

    // Per set: a record already holding a wanted value is KEPT, and patched
    // only where its ttl, proxied or mark differ — so an unchanged set is no
    // request at all, and a changed one never drops a value it keeps.
    const ops = { deletes: [] as Row[], patches: [] as Row[], posts: [] as Row[] }
    const kept: EdgeRecord[] = []
    for (const [key, want] of wanted) {
      const have = [...sets.get(key)!]
      for (const w of want) {
        const body = toBody(w, mark)
        const i = have.findIndex(h => sameContent(h.type, h.content, w.content))
        if (i < 0) { ops.posts.push(body); continue }
        const [h] = have.splice(i, 1)
        const stale = h.ttl !== body.ttl || h.comment !== body.comment
          || ('proxied' in body && h.proxied !== body.proxied)
        if (!stale) { kept.push(h); continue }
        const { type: _t, name: _n, content: _c, ...changed } = body
        ops.patches.push({ id: h.id, ...changed })
      }
      for (const h of have) ops.deletes.push({ id: h.id })
    }
    const done = await batch(send, zoneId, ops)
    return [...kept, ...done.patches, ...done.posts]
  },

  async deleteRecords(send, zoneId, refs): Promise<EdgeRecord[]> {
    const sets = await ownedSets(send, zoneId, new Set(refs.map(r => setKey(r.type, r.name))))
    const gone = new Map<string, EdgeRecord>()
    for (const ref of refs)
      for (const r of sets.get(setKey(ref.type, ref.name))!)
        if ((ref.content === undefined || sameContent(r.type, r.content, ref.content))
          && (!ref.mark || (r.mark !== null && spell(r.mark) === spell(ref.mark)))) gone.set(r.id, r)
    await batch(send, zoneId, { deletes: [...gone.keys()].map(id => ({ id })), patches: [], posts: [] })
    return [...gone.values()]
  },

  // A Configuration Rule in the zone's `http_config_settings` entrypoint (FJS-D1422), its
  // description the mark. The zone's SSL setting is never written: it covers
  // every host in the zone, and one whose origin has no valid certificate
  // answers 526 the moment it turns strict. A later rule overrides an earlier
  // one for the same setting, so ours is kept last.
  async strictOrigin(send, zoneId, name, mark) {
    const zone  = `/zones/${encodeURIComponent(zoneId)}`
    const entry = `${zone}/rulesets/phases/${CONFIG_PHASE}/entrypoint`
    const want  = {
      expression: `http.host eq "${host(name)}"`, description: spell(mark),
      action: 'set_config', action_parameters: { ssl: 'strict' }, enabled: true,
    }
    const rulesOf = (r: unknown) => Array.isArray((r as Row)?.rules) ? (r as Row).rules as Row[] : []
    const ours    = (rules: Row[]) => rules.filter(r => r.expression === want.expression && r.description === want.description).pop()

    const got = await send({ method: 'GET', path: entry })
    if (got.status === 404) {
      const { result } = configRules(await send({ method: 'PUT', path: entry, body: { rules: [want] } }))
      return { rule: str(ours(rulesOf(result))?.id), changed: true }
    }
    const { result: set } = configRules(got)
    const rules = rulesOf(set)
    const have  = ours(rules)
    const last  = rules[rules.length - 1]
    const right = have && have.enabled !== false && (have.action_parameters as Row | undefined)?.ssl === 'strict'
    if (right && have === last) return { rule: str(have.id), changed: false }

    const rulesPath = `${zone}/rulesets/${encodeURIComponent(str((set as Row).id))}/rules`
    const { result } = have
      ? configRules(await send({ method: 'PATCH', path: `${rulesPath}/${encodeURIComponent(str(have.id))}`,
          body: { ...want, ...(have === last ? {} : { position: { after: str(last.id) } }) } }))
      : configRules(await send({ method: 'POST', path: rulesPath, body: want }))
    return { rule: str(ours(rulesOf(result))?.id), changed: true }
  },
}

const CONFIG_PHASE = 'http_config_settings'

/** `unwrap`, with the permission named: a token minted for DNS alone answers
 *  403 here, and *Authentication error* does not say which grant is missing. */
function configRules(res: Awaited<ReturnType<AccountSend>>) {
  if (res.status === 403)
    throw new Error('Cloudflare: this token cannot write Configuration Rules — give it Zone › Config Rules › Edit on that zone')
  return unwrap(res)
}
