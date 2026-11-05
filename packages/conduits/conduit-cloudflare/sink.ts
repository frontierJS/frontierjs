// sink.ts — Cloudflare, standing in for Cloudflare.
//
// Copied from `packages/basecamp/api/src/providers/edge/cloudflare-sink.ts`
// with the chaos switches added. A bearer token, the `/client/v4` prefix,
// every answer inside `{ success, errors, result, result_info }`, lists paged
// by `total_pages` at a cap of 2 so an ordinary read walks pages. `zone-broken`
// answers 200 with `success: false` — the envelope failure a status check
// reads as an empty zone. A batch applies whole or not at all.
//
// Chaos: `{ lost }`, `{ rateLimit: { retryAfter } }`, `{ failNext }`,
// `{ lyingPages }` makes `total_pages` one more than there are, forever.

export interface CfSinkOptions { port?: number; token?: string }

export const EMPTY_TOKEN = 'cfat_nozones'
export const BROKEN_ZONE = 'zone-broken'
const PAGE_CAP = 2

const ZONES = [
  { id: 'zone-example', name: 'example.test', status: 'active'  },
  { id: 'zone-shop',    name: 'shop.test',    status: 'active'  },
  { id: 'zone-pending', name: 'pending.test', status: 'pending' },
  { id: BROKEN_ZONE,    name: 'broken.test',  status: 'active'  },
]
type Rec = Record<string, unknown>
const RECORDS: Record<string, Rec[]> = {
  'zone-example': [
    { id: 'rec-apex', type: 'CNAME', name: 'example.test', content: 'ingress-1.fleet.test', proxied: true,  ttl: 1,    comment: 'app:domain:dom-1' },
    { id: 'rec-mx',   type: 'MX',    name: 'example.test', content: 'mx.mail.test',         proxied: false, ttl: 3600, comment: null },
    { id: 'rec-txt',  type: 'TXT',   name: 'example.test', content: '"v=spf1 -all"',        proxied: false, ttl: 300,  comment: 'added by hand' },
  ],
  'zone-shop': [
    { id: 'rec-shop-mx',  type: 'MX', name: 'shop.test',     content: 'mx.mail.test', proxied: false, ttl: 3600, comment: null },
    { id: 'rec-shop-www', type: 'A',  name: 'www.shop.test', content: '192.0.2.10',   proxied: false, ttl: 300,  comment: null },
  ],
  'zone-pending': [],
}
const SERVES = new Set(['A', 'AAAA', 'CNAME'])

function applyBatch(zone: { name: string }, current: Rec[], body: Rec, nextId: () => string): { records: Rec[]; result: Record<string, Rec[]> } | { error: [number, string] } {
  const records = current.map(r => ({ ...r }))
  const result: Record<string, Rec[]> = { deletes: [], patches: [], puts: [], posts: [] }
  const list = (k: string) => Array.isArray(body[k]) ? body[k] as Rec[] : []
  const at = (id: unknown) => records.findIndex(r => r.id === id)
  for (const d of list('deletes')) { const i = at(d.id); if (i < 0) return { error: [81044, `Record does not exist: ${d.id}`] }; result.deletes.push(records.splice(i, 1)[0]) }
  for (const p of list('patches')) { const i = at(p.id); if (i < 0) return { error: [81044, `Record does not exist: ${p.id}`] }; records[i] = { ...records[i], ...p }; result.patches.push(records[i]) }
  for (const p of list('posts')) {
    const name = String(p.name ?? '').toLowerCase(), type = String(p.type ?? '')
    if (!type || !name || p.content === undefined) return { error: [9000, 'DNS record type, name and content are required'] }
    if (name !== zone.name && !name.endsWith(`.${zone.name}`)) return { error: [9005, `${name} is not in the zone ${zone.name}`] }
    if (records.some(r => r.name === name && SERVES.has(String(r.type)) && SERVES.has(type) && (type === 'CNAME' || r.type === 'CNAME')))
      return { error: [81053, 'An A, AAAA, or CNAME record with that host already exists.'] }
    const made = { proxied: false, ttl: 1, comment: null, ...p, name, id: nextId() }
    records.push(made); result.posts.push(made)
  }
  return { records, result }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const fail = (code: number, message: string, status: number, headers: Record<string, string> = {}) => json({ success: false, errors: [{ code, message }], messages: [], result: null }, status, headers)

export function startCfSink(opts: CfSinkOptions = {}) {
  const TOKEN = opts.token ?? 'cfat_devtoken'
  const zoneRecords: Record<string, Rec[]> = structuredClone(RECORDS)
  let made = 0
  const nextId = () => `rec-${++made}`
  const seen: { method: string; path: string; status: number }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, lyingPages: false }
  const hanging: Array<() => void> = []

  const ok = (all: unknown[], url: URL) => {
    const page = Math.max(1, Number(url.searchParams.get('page') ?? 1)), per = Math.min(PAGE_CAP, Math.max(1, Number(url.searchParams.get('per_page') ?? 20)))
    const slice = all.slice((page - 1) * per, page * per)
    const totalPages = Math.max(1, Math.ceil(all.length / per)) + (armed.lyingPages ? 1 : 0)
    return json({ success: true, errors: [], messages: [], result: slice, result_info: { page, per_page: per, count: slice.length, total_count: all.length, total_pages: armed.lyingPages ? page + 1 : totalPages } })
  }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/_sink/seen')  return json({ requests: seen, records: zoneRecords })
      if (url.pathname === '/_sink/reset') { seen.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, lyingPages: false }); return json({ ok: true }) }
      if (url.pathname === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      const path = url.pathname.replace(/^\/client\/v4/, '')
      const entry = { method: req.method, path, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }

      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${TOKEN}` && auth !== `Bearer ${EMPTY_TOKEN}`) return record(fail(10000, 'Authentication error', 403))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(fail(10000, 'Rate limited', 429, { 'retry-after': String(retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(fail(10000, 'Internal error', 500)) }
      const zones = auth === `Bearer ${EMPTY_TOKEN}` ? [] : ZONES

      if (path === '/zones') return record(ok(zones, url))
      const one = path.match(/^\/zones\/([^/]+)$/)
      if (one) { const z = zones.find(z => z.id === decodeURIComponent(one[1])); return record(z ? json({ success: true, errors: [], messages: [], result: z }) : fail(7003, 'Could not route to /zones/' + one[1], 404)) }
      const recs = path.match(/^\/zones\/([^/]+)\/dns_records(\/batch)?$/)
      if (recs) {
        const id = decodeURIComponent(recs[1]), zone = zones.find(z => z.id === id)
        if (!zone) return record(fail(7003, 'Could not route to /zones/' + id, 404))
        if (id === BROKEN_ZONE) return record(fail(1000, 'Invalid zone configuration', 200))
        if (!recs[2]) return record(req.method === 'GET' ? ok(zoneRecords[id] ?? [], url) : fail(10405, 'Method not allowed', 405))
        if (req.method !== 'POST') return record(fail(10405, 'Method not allowed', 405))
        const body = await req.json().catch(() => null) as Rec | null
        if (!body) return record(fail(9207, 'Request body is invalid JSON', 400))
        const applied = applyBatch(zone, zoneRecords[id] ?? [], body, nextId)
        if ('error' in applied) return record(fail(applied.error[0], applied.error[1], 400))
        zoneRecords[id] = applied.records
        return record(json({ success: true, errors: [], messages: [], result: applied.result }))
      }
      return record(fail(7000, `No route for that URI: ${url.pathname}`, 404))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}/client/v4`, stop() { for (const r of hanging) r(); server.stop(true) } }
}

if (import.meta.main) console.log(`[cf-sink] ${startCfSink({ port: Number(process.env.CF_SINK_PORT ?? 0) }).url}`)
