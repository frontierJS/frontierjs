// sink.ts — Plausible, standing in for Plausible. Bearer, JSON, `/api/v2/query`
// over a fixed table of 25 rows for `site_id` `shop.test`; `{ error }` on a
// refusal; a 429 that carries `Retry-After` for a burst and none for the
// hourly budget. Chaos: `{ lost }`, `{ rateLimit: { retryAfter } }`,
// `{ quota: n }` (n answers of 429 with no header — an hourly budget does not clear between retries), `{ failNext }`.

export interface PlausibleSinkOptions { port?: number; key?: string }
const json = (b: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json', ...headers } })
const ROWS = Array.from({ length: 25 }, (_, i) => ({ metrics: [100 - i, 120 - i], dimensions: [`/page-${String(i).padStart(2, '0')}`] }))

export function startPlausibleSink(opts: PlausibleSinkOptions = {}) {
  const KEY = opts.key ?? 'pl_dev'
  const seen: { body: string; status: number }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, quota: 0 }
  const hanging: Array<() => void> = []
  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/_sink/seen')  return json({ requests: seen })
      if (url.pathname === '/_sink/reset') { seen.length = 0; Object.assign(armed, { lost: false, failNext: false, rateLimit: null, quota: 0 }); return json({ ok: true }) }
      if (url.pathname === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      const text = await req.text()
      const entry = { body: text, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }
      if (req.headers.get('authorization') !== `Bearer ${KEY}`) return record(json({ error: 'Missing or invalid API key' }, 401))
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(json({ error: 'Too many requests' }, 429, { 'retry-after': String(retryAfter) })) }
      if (armed.quota > 0) { armed.quota--; return record(json({ error: 'Too many requests. Your API key is limited to 600 requests per hour.' }, 429)) }
      if (armed.failNext) { armed.failNext = false; return record(json({ error: 'internal' }, 500)) }
      if (url.pathname !== '/api/v2/query' || req.method !== 'POST') return record(json({ error: 'not found' }, 404))
      const q = JSON.parse(text) as { site_id?: string; metrics?: string[]; date_range?: unknown; pagination?: { limit?: number; offset?: number } }
      if (!q.site_id || !q.metrics?.length || !q.date_range) return record(json({ error: '#/metrics: should be a non-empty array' }, 400))
      if (q.site_id !== 'shop.test') return record(json({ error: 'Site does not exist or user does not have access' }, 404))
      const limit = Math.min(q.pagination?.limit ?? 10_000, 10_000), offset = q.pagination?.offset ?? 0
      return record(json({ results: ROWS.slice(offset, offset + limit), meta: { total_rows: ROWS.length }, query: q }))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, key: KEY, stop() { for (const r of hanging) r(); server.stop(true) } }
}
if (import.meta.main) console.log(`[plausible-sink] ${startPlausibleSink({ port: Number(process.env.PLAUSIBLE_SINK_PORT ?? 0) }).url}`)
