// src/providers/edge/cloudflare-sink.ts — Cloudflare, standing in for Cloudflare.
//
// A dev listener speaking the real thing's shape: a bearer token, the
// `/client/v4` prefix, every answer inside `{ success, errors, result,
// result_info }`, and lists paged by `total_pages`. A SEPARATE LISTENER for the
// reason `compute/digitalocean-sink.ts` gives: the token really is read off an
// `Authorization` header conduit wrote, from a `Secret` that was decrypted.
//
// It does NOT pretend to be Cloudflare's semantics — no plan, no rate limit, no
// propagation. It answers the reads this app makes and the refusals worth
// testing: a token it does not know, a token that opens no zone, and a 200
// whose envelope says it failed. Writes arrive as one batch that applies whole
// or not at all, and refuse what Cloudflare refuses that a write can trip on: a
// record id that is not there, and a CNAME sharing a name with an A, AAAA or
// CNAME. Each listener holds its own copy of the zones, so a write in one suite
// is not a record in the next.
//
//   bun api/src/providers/edge/cloudflare-sink.ts
//   CLOUDFLARE_URL=http://localhost:8127/client/v4
//
// Port 8127 — project 2 (basecamp), backend (`docs/PORTS.md`); 7127 in the
// unit suite.

const PORT = Number(process.env.CF_SINK_PORT ?? 8127)

/** What this stand-in accepts. An account-owned token starts `cfat_`, the kind
 *  connect asks for (`FJS-D558`); so does this one. */
const TOKEN = process.env.CF_SINK_TOKEN ?? 'cfat_devtoken'

/** A token that authenticates and was scoped to no zone — valid, and useless
 *  to this app, which is what verify must say about it. */
export const EMPTY_TOKEN = 'cfat_nozones'

/** The sink pages at this whatever `per_page` asks for, so the connector's walk
 *  over `total_pages` is exercised by an ordinary read rather than only by a
 *  test that reaches for it. */
const PAGE_CAP = 2

/** A zone id whose records answer 200 with `success: false` — the envelope
 *  failure a status check alone reads as an empty zone. */
export const BROKEN_ZONE = 'zone-broken'

const ZONES = [
  { id: 'zone-example', name: 'example.test', status: 'active'  },
  { id: 'zone-shop',    name: 'shop.test',    status: 'active'  },
  { id: 'zone-pending', name: 'pending.test', status: 'pending' },
  { id: BROKEN_ZONE,    name: 'broken.test',  status: 'active'  },
]

/** Records per zone. Three kinds on purpose: one this app will own (the mark in
 *  `comment`), one somebody else's (an MX, no comment) and one with a comment
 *  that is not ours — so *which are ours* cannot be answered by *has a comment*. */
const RECORDS: Record<string, Record<string, unknown>[]> = {
  'zone-example': [
    { id: 'rec-apex', type: 'CNAME', name: 'example.test', content: 'ingress-1.fleet.test',
      proxied: true,  ttl: 1,    comment: 'basecamp:domain:dom-1' },
    { id: 'rec-mx',   type: 'MX',    name: 'example.test', content: 'mx.mail.test',
      proxied: false, ttl: 3600, comment: null },
    { id: 'rec-txt',  type: 'TXT',   name: 'example.test', content: '"v=spf1 -all"',
      proxied: false, ttl: 300,  comment: 'added by hand' },
  ],
  // Somebody else's records only — where the unit suite writes. An MX at the
  // apex beside whatever gets set there, and an A at www that no write may take.
  'zone-shop': [
    { id: 'rec-shop-mx', type: 'MX', name: 'shop.test', content: 'mx.mail.test',
      proxied: false, ttl: 3600, comment: null },
    { id: 'rec-shop-www', type: 'A', name: 'www.shop.test', content: '192.0.2.10',
      proxied: false, ttl: 300, comment: null },
  ],
  'zone-pending': [],
}

type Rec = Record<string, unknown>

/** Cloudflare's rule that a write can trip on: a name holding a CNAME holds
 *  nothing else that serves it. */
const SERVES = new Set(['A', 'AAAA', 'CNAME'])

/**
 * Apply one batch to a COPY, in Cloudflare's order — deletes, patches, puts,
 * posts — and answer the copy or the first refusal. The caller keeps the
 * original on a refusal, which is what makes a batch all or nothing.
 */
function applyBatch(zone: { name: string }, current: Rec[], body: Rec, nextId: () => string):
  { records: Rec[]; result: Record<string, Rec[]> } | { error: [number, string] } {
  const records = current.map(r => ({ ...r }))
  const result: Record<string, Rec[]> = { deletes: [], patches: [], puts: [], posts: [] }
  const list = (k: string) => Array.isArray(body[k]) ? body[k] as Rec[] : []
  const at   = (id: unknown) => records.findIndex(r => r.id === id)

  for (const d of list('deletes')) {
    const i = at(d.id)
    if (i < 0) return { error: [81044, `Record does not exist: ${d.id}`] }
    result.deletes.push(records.splice(i, 1)[0])
  }
  for (const [kind, merge] of [['patches', true], ['puts', false]] as const) {
    for (const p of list(kind)) {
      const i = at(p.id)
      if (i < 0) return { error: [81044, `Record does not exist: ${p.id}`] }
      records[i] = merge ? { ...records[i], ...p } : { ...p, id: records[i].id }
      result[kind].push(records[i])
    }
  }
  for (const p of list('posts')) {
    const name = String(p.name ?? '').toLowerCase()
    const type = String(p.type ?? '')
    if (!type || !name || p.content === undefined) return { error: [9000, 'DNS record type, name and content are required'] }
    if (name !== zone.name && !name.endsWith(`.${zone.name}`))
      return { error: [9005, `${name} is not in the zone ${zone.name}`] }
    const clash = records.some(r => r.name === name && SERVES.has(String(r.type))
      && SERVES.has(type) && (type === 'CNAME' || r.type === 'CNAME'))
    if (clash) return { error: [81053, 'An A, AAAA, or CNAME record with that host already exists.'] }
    const made = { proxied: false, ttl: 1, comment: null, ...p, name, id: nextId() }
    records.push(made)
    result.posts.push(made)
  }
  return { records, result }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** The envelope Cloudflare answers every call in. */
function ok(all: unknown[], url: URL) {
  const page  = Math.max(1, Number(url.searchParams.get('page') ?? 1))
  const per   = Math.min(PAGE_CAP, Math.max(1, Number(url.searchParams.get('per_page') ?? 20)))
  const slice = all.slice((page - 1) * per, page * per)
  return json({
    success: true, errors: [], messages: [], result: slice,
    result_info: { page, per_page: per, count: slice.length, total_count: all.length,
      total_pages: Math.max(1, Math.ceil(all.length / per)) },
  })
}

function fail(code: number, message: string, status: number) {
  return json({ success: false, errors: [{ code, message }], messages: [], result: null }, status)
}

export function startCfSink(port = PORT) {
  const zoneRecords: Record<string, Rec[]> = structuredClone(RECORDS)
  let made = 0
  const nextId = () => `rec-${++made}-${Math.random().toString(36).slice(2, 8)}`

  return Bun.serve({
    port,
    async fetch(req) {
      const url  = new URL(req.url)
      const path = url.pathname.replace(/^\/client\/v4/, '')

      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${EMPTY_TOKEN}`) {
        console.error(`[cf-sink] refused ${req.method} ${url.pathname}`)
        return fail(10000, 'Authentication error', 403)
      }
      const zones = auth === `Bearer ${EMPTY_TOKEN}` ? [] : ZONES

      if (path === '/zones') return ok(zones, url)

      const one = path.match(/^\/zones\/([^/]+)$/)
      if (one) {
        const zone = zones.find(z => z.id === decodeURIComponent(one[1]))
        if (!zone) return fail(7003, 'Could not route to /zones/' + one[1], 404)
        return json({ success: true, errors: [], messages: [], result: zone })
      }

      const recs = path.match(/^\/zones\/([^/]+)\/dns_records(\/batch)?$/)
      if (recs) {
        const id   = decodeURIComponent(recs[1])
        const zone = zones.find(z => z.id === id)
        if (!zone) return fail(7003, 'Could not route to /zones/' + id, 404)
        // 200, on purpose — the status says fine and the envelope says not.
        if (id === BROKEN_ZONE) return fail(1000, 'Invalid zone configuration', 200)

        if (!recs[2]) {
          if (req.method !== 'GET') return fail(10405, 'Method not allowed', 405)
          return ok(zoneRecords[id] ?? [], url)
        }
        if (req.method !== 'POST') return fail(10405, 'Method not allowed', 405)
        const body    = await req.json().catch(() => null) as Rec | null
        if (!body) return fail(9207, 'Request body is invalid JSON', 400)
        const applied = applyBatch(zone, zoneRecords[id] ?? [], body, nextId)
        if ('error' in applied) return fail(applied.error[0], applied.error[1], 400)
        zoneRecords[id] = applied.records
        return json({ success: true, errors: [], messages: [], result: applied.result })
      }

      return fail(7000, `No route for that URI: ${url.pathname}`, 404)
    },
  })
}

if (import.meta.main) {
  const server = startCfSink()
  console.log(`[cf-sink] Cloudflare stand-in on http://localhost:${server.port}/client/v4 — token ${TOKEN}`)
}
