// sink.ts — Ahrefs, standing in for Ahrefs.
//
// A separate listener on `port: 0`: the key really is read off an
// `Authorization` header conduit wrote. Bearer, JSON, paths under `/v3`. The
// bodies are the ones measured on api.ahrefs.com on 2026-11-25, not the spec's:
// a wrong key is 401 `["Error","Unauthorized"]`, no key is 403
// `["Error","Forbidden"]`, a spent allowance is 403 `{ error: "API units limit
// reached…" }`, a missing argument 400 `{ error }`. Every answer carries the
// five `x-api-*` headers; a free test target (`ahrefs.com`) reports 50 and
// charges 0. State is per instance: projects (matched by the request's own
// url, never by id order) and the Site Audit list, which holds one audited
// project and one never crawled (nulls in every field).
//
// Chaos, under `/_sink/arm`: `{ lost }` applies a write and never answers;
// `{ failNext }` a 500; `{ rateLimit: n, retryAfter? }` n answers of 429, with
// no `Retry-After` unless one is named (none was ever captured, so the default
// is none); `{ unitsLimit }` and `{ forbidden }` each one 403 of the two kinds.

export interface AhrefsSinkOptions { port?: number; key?: string }
export const SINK_KEY = 'ahrefs_dev'
const FREE_TARGETS = ['ahrefs.com', 'yep.com', 'firehose.com']

type Rec = Record<string, unknown>
export const seedProjects = (): Rec[] => [
  { project_id: '1001', project_name: 'Kobami', url: 'kobami.com/', mode: 'subdomains', protocol: 'both', access: 'shared', verified: true, folder: null, owned_by: 'support@sink.test', keyword_count: 0 },
  { project_id: '1002', project_name: 'Never audited', url: 'fresh.example/', mode: 'domain', protocol: 'both', access: 'shared', verified: true, folder: null, owned_by: 'support@sink.test', keyword_count: 0 },
]
const AUDITS = [
  { project_id: '1001', project_name: 'Kobami', target_protocol: 'both', target_url: 'kobami.com/', target_mode: 'subdomains', date: '2026-11-01T04:31:37Z', status: 'Completed', health_score: 93, urls_with_errors: 1, urls_with_warnings: 3, urls_with_notices: 7, total: 87 },
  { project_id: '1002', project_name: 'Never audited', target_protocol: 'both', target_url: 'fresh.example/', target_mode: 'domain', date: null, status: null, health_score: null, urls_with_errors: null, urls_with_warnings: null, urls_with_notices: null, total: null },
]

export function startAhrefsSink(opts: AhrefsSinkOptions = {}) {
  const KEY = opts.key ?? SINK_KEY
  const projects = seedProjects()
  let made = 1002
  const seen: { method: string; path: string; status: number; accept: string | null; hasAuth: boolean; body: unknown }[] = []
  const armed = { lost: false, failNext: false, rateLimit: 0, retryAfter: undefined as number | undefined, unitsLimit: false, forbidden: false }
  const hanging: Array<() => void> = []

  const costs = (total: number, actual: number, rows = 1, perRow = 0) => ({
    'x-api-rows': String(rows), 'x-api-units-cost-row': String(perRow), 'x-api-units-cost-total': String(total),
    'x-api-units-cost-total-actual': String(actual), 'x-api-cache': 'no_cache',
  })
  const json = (body: unknown, status = 200, headers: Record<string, string> = costs(0, 0)) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/_sink/seen')  return Response.json({ requests: seen, projects })
      if (url.pathname === '/_sink/reset') {
        seen.length = 0; projects.splice(0, projects.length, ...seedProjects()); made = 1002
        Object.assign(armed, { lost: false, failNext: false, rateLimit: 0, retryAfter: undefined, unitsLimit: false, forbidden: false })
        return Response.json({ ok: true })
      }
      if (url.pathname === '/_sink/arm')   { Object.assign(armed, await req.json()); return Response.json({ ok: true }) }

      const text = await req.text()
      let parsed: unknown = null; try { parsed = text ? JSON.parse(text) : null } catch { /* a body is only read where a route wants one */ }
      const auth = req.headers.get('authorization')
      const entry = { method: req.method, path: url.pathname + url.search, status: 0, accept: req.headers.get('accept'), hasAuth: auth !== null, body: parsed }
      seen.push(entry)
      // A write the sink applied and never answered: the caller learns it by reading.
      const record = async (r: Response, applied = false) => {
        if (armed.lost && applied) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) }
        entry.status = r.status; return r
      }

      if (auth === null) return record(json(['Error', 'Forbidden'], 403, {}))
      if (auth !== `Bearer ${KEY}`) return record(json(['Error', 'Unauthorized'], 401, {}))
      if (armed.forbidden) { armed.forbidden = false; return record(json(['Error', 'Forbidden'], 403, {})) }
      if (armed.unitsLimit) {
        armed.unitsLimit = false
        return record(json({ error: 'API units limit reached. The limit of this API key should be increased. Expected usage: 50, API units left: 0.' }, 403, {}))
      }
      if (armed.rateLimit > 0) { armed.rateLimit--; return record(json({ error: 'Too many requests' }, 429, armed.retryAfter === undefined ? {} : { 'retry-after': String(armed.retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(json({ error: 'internal' }, 500, {})) }
      if (!url.pathname.startsWith('/v3/')) return record(json({ error: 'not found' }, 404, {}))
      const route = url.pathname.slice('/v3'.length)

      if (route === '/subscription-info/limits-and-usage' && req.method === 'GET') {
        return record(json({ limits_and_usage: {
          subscription: 'Lite, billed monthly', usage_reset_date: '2026-12-25T00:00:00Z',
          units_limit_workspace: 200000, units_usage_workspace: 50, units_limit_api_key: 5000, units_usage_api_key: 50,
          api_key_expiration_date: '2026-12-19T23:59:58Z',
        } }))
      }

      if (route === '/site-explorer/domain-rating' && req.method === 'GET') {
        const target = url.searchParams.get('target'), date = url.searchParams.get('date')
        if (!target) return record(json({ error: "missing argument 'target'" }, 400, {}))
        if (!date)   return record(json({ error: "missing argument 'date'" }, 400, {}))
        // The sink has no units to bill; a target outside the free three answers as a key with none left.
        if (!FREE_TARGETS.includes(target)) return record(json({ error: 'API units limit reached. The limit of this API key should be increased. Expected usage: 50, API units left: 0.' }, 403, {}))
        return record(json({ domain_rating: { domain_rating: 91.0, ahrefs_rank: 594 } }, 200, costs(50, 0, 1, 2)))
      }

      if (route === '/site-audit/projects' && req.method === 'GET') return record(json({ healthscores: AUDITS }, 200, costs(0, 0, AUDITS.length)))

      if (route === '/management/projects') {
        if (req.method === 'GET') return record(json({ projects }, 200, costs(0, 0, projects.length)))
        if (req.method === 'POST') {
          const b = (parsed ?? {}) as Rec
          for (const k of ['project_name', 'url', 'mode', 'protocol']) if (typeof b[k] !== 'string' || !b[k]) return record(json({ error: `missing argument '${k}'` }, 400, {}))
          const row = { project_id: String(++made), project_name: b.project_name, url: `${b.url}/`, mode: b.mode, protocol: b.protocol, access: b.access ?? 'private', verified: true, folder: null, owned_by: 'support@sink.test', keyword_count: 0 }
          projects.push(row)
          return record(json({ projects: [row] }, 200, costs(0, 0)), true)
        }
        if (req.method === 'DELETE') {
          const ids = (url.searchParams.get('project_ids') ?? '').split(',').filter(Boolean)
          if (!ids.length) return record(json({ error: "missing argument 'project_ids'" }, 400, {}))
          const gone = projects.filter(p => ids.includes(String(p.project_id)))
          for (const g of gone) projects.splice(projects.indexOf(g), 1)
          return record(json({ projects: gone }, 200, costs(0, 0, gone.length)), true)
        }
      }
      return record(json({ error: 'not found' }, 404, {}))
    },
  })
  return {
    port: server.port,
    origin: `http://127.0.0.1:${server.port}`,
    url:  `http://127.0.0.1:${server.port}/v3`,
    key:  KEY,
    /** The projects as stored, which is what proves a lost add made one and not two. */
    projectsNow: () => projects.map(p => ({ ...p })),
    stop() { for (const r of hanging) r(); server.stop(true) },
  }
}

if (import.meta.main) console.log(`[ahrefs-sink] Ahrefs stand-in on ${startAhrefsSink({ port: Number(process.env.AHREFS_SINK_PORT ?? 0) }).url}`)
