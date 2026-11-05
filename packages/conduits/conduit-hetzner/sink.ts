// sink.ts — Hetzner Cloud, standing in for Hetzner. Copied from basecamp's
// `compute/hetzner-sink.ts` with chaos added. Everything here is Hetzner's
// shape and not DO's: `/v1/`, locations, decimal-string prices with net and
// gross per location, memory in gigabytes as a float, labels with a key
// grammar, a 201 with an action beside the server, a delete answering 200
// with an action where DO answers 204 with nothing. Chaos: `{ lost }`,
// `{ rateLimit }`, `{ failNext }`, `{ createNoId }`, `{ capacity }` (a 423
// `resource_unavailable` on the next create).
//
// The handle is for a test in the same process: `created` is each spec that
// crossed the wire, `boot` brings a server up, `reset` empties it back to the
// seed. A drive that needs a machine to arrive on its own sets `bootMs`; it is
// 0 by default so nothing in-process depends on a timer.

export interface HzSinkOptions { port?: number; token?: string; /** a created server comes up after this long; 0 is never */ bootMs?: number }

const LOCATIONS = [{ id: 1, name: 'nbg1', description: 'Nuremberg DC Park 1' }, { id: 2, name: 'fsn1', description: 'Falkenstein DC Park 1' }, { id: 3, name: 'hel1', description: 'Helsinki DC Park 1' }]
const price = (net: number) => ({ net: net.toFixed(10), gross: (net * 1.19).toFixed(10) })
const SERVER_TYPES = [
  { id: 22, name: 'cpx11', description: 'CPX 11', cores: 2, memory: 2, disk: 40, prices: [{ location: 'nbg1', price_monthly: price(4.35) }, { location: 'fsn1', price_monthly: price(4.35) }, { location: 'hel1', price_monthly: price(4.85) }] },
  { id: 23, name: 'cpx21', description: 'CPX 21', cores: 3, memory: 4, disk: 80, prices: [{ location: 'nbg1', price_monthly: price(7.55) }, { location: 'fsn1', price_monthly: price(7.55) }] },
  { id: 45, name: 'cax11', description: 'CAX 11 (Arm)', cores: 2, memory: 1.9, disk: 40, prices: [{ location: 'fsn1', price_monthly: price(3.79) }] },
  { id: 99, name: 'ghost', description: 'Unpriced', cores: 1, memory: 1, disk: 10, prices: [] },
]
const IMAGES = [
  { id: 1, type: 'system', status: 'available', name: 'ubuntu-24.04', description: 'Ubuntu 24.04' },
  { id: 2, type: 'system', status: 'available', name: 'debian-12', description: 'Debian 12' },
  { id: 3, type: 'system', status: 'deprecated', name: 'debian-10', description: 'Debian 10' },
]
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
const fail = (code: string, message: string, status: number, headers: Record<string, string> = {}) => json({ error: { code, message } }, status, headers)
const selects = (labels: Record<string, unknown>, selector: string) => { const [k, v] = selector.split('=='); return v === undefined ? k in labels : String(labels[k] ?? '') === v }

export function startHzSink(opts: HzSinkOptions = {}) {
  const TOKEN = opts.token ?? 'hz'.padEnd(64, '0'), BOOT_MS = opts.bootMs ?? 0
  const SEED = () => ({ id: 7701, name: 'legacy-01', status: 'running', labels: { fleet: '' }, public_net: { ipv4: { ip: '198.51.100.7' } }, datacenter: { name: 'nbg1-dc3', location: { name: 'nbg1' } } })
  const SERVERS = new Map<string, Record<string, unknown>>([['7701', SEED()]])
  const created: Record<string, unknown>[] = []
  const seen: { method: string; path: string; status: number }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, createNoId: false, capacity: false }
  const hanging: Array<() => void> = []
  let nextId = 8000
  const boot = (id: string, ip = '198.51.100.50') => { const s = SERVERS.get(id); if (s) { s.status = 'running'; s.public_net = { ipv4: { ip } } } return !!s }
  // A stand-in that accumulates across a suite makes *how many machines did this create* unanswerable.
  const reset = () => { seen.length = 0; created.length = 0; nextId = 8000; SERVERS.clear(); SERVERS.set('7701', SEED()); Object.assign(armed, { lost: false, failNext: false, rateLimit: null, createNoId: false, capacity: false }) }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, created, servers: [...SERVERS.values()] })
      if (path === '/_sink/reset') { reset(); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      if (path === '/_sink/boot' && req.method === 'POST') { const { id, ip } = await req.json() as { id: string; ip?: string }; return json({ ok: boot(id, ip) }) }

      const entry = { method: req.method, path, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }
      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${TOKEN}`) {
        // Named, so a credential mistake is legible here rather than only as the vendor's opaque 401.
        console.error(`[hz-sink] refused ${req.method} ${path} — authorization: ${JSON.stringify(auth)}`)
        return record(fail('unauthorized', 'unable to authenticate', 401))
      }
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(fail('rate_limit_exceeded', 'rate limit exceeded', 429, { 'retry-after': String(retryAfter), 'ratelimit-reset': String(Math.floor(Date.now() / 1000) + retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(fail('unknown_error', 'internal', 500)) }

      if (path === '/v1/locations')    return record(json({ locations: LOCATIONS }))
      if (path === '/v1/server_types') return record(json({ server_types: SERVER_TYPES }))
      if (path === '/v1/images') { const type = url.searchParams.get('type'), status = url.searchParams.get('status'); return record(json({ images: IMAGES.filter(i => (!type || i.type === type) && (!status || i.status === status)) })) }
      if (path === '/v1/servers') {
        if (req.method === 'POST') {
          const spec = await req.json().catch(() => null) as Record<string, unknown> | null
          if (!spec) return record(fail('invalid_input', 'no body', 400))
          const type = SERVER_TYPES.find(t => t.name === spec.server_type), location = LOCATIONS.find(l => l.name === spec.location), image = IMAGES.find(i => i.name === spec.image)
          if (!type || !location || !image) return record(fail('invalid_input', 'server_type, location or image not found', 400))
          if (image.status !== 'available') return record(fail('invalid_input', `image ${image.name} is ${image.status}`, 400))
          if (!type.prices.some(p => p.location === location.name)) return record(fail('invalid_input', `server type ${type.name} is not available in ${location.name}`, 400))
          for (const key of Object.keys((spec.labels ?? {}) as Record<string, unknown>)) if (!/^[a-zA-Z0-9]([-_.a-zA-Z0-9]{0,61}[a-zA-Z0-9])?$/.test(key)) return record(fail('invalid_input', `label key ${JSON.stringify(key)} is invalid`, 400))
          if (armed.capacity) { armed.capacity = false; return record(fail('resource_unavailable', `no ${type.name} available in ${location.name} right now`, 423)) }
          const id = String(nextId++)
          SERVERS.set(id, { id: Number(id), name: spec.name, status: 'initializing', labels: spec.labels ?? {}, public_net: { ipv4: null }, datacenter: { name: `${location.name}-dc1`, location: { name: location.name } } })
          created.push(spec)
          if (BOOT_MS > 0) setTimeout(() => boot(id, `198.51.100.${100 + (Number(id) % 100)}`), BOOT_MS)
          if (armed.createNoId) { armed.createNoId = false; return record(json({ server: null, action: { id: 1, command: 'create_server', status: 'running' }, root_password: null }, 201)) }
          return record(json({ server: SERVERS.get(id), action: { id: 1, command: 'create_server', status: 'running', progress: 0 }, root_password: null }, 201))
        }
        const selector = url.searchParams.get('label_selector'), all = [...SERVERS.values()]
        return record(json({ servers: selector ? all.filter(s => selects((s.labels ?? {}) as Record<string, unknown>, selector)) : all }))
      }
      const one = path.match(/^\/v1\/servers\/([^/]+)$/)
      if (one) {
        const id = decodeURIComponent(one[1]), row = SERVERS.get(id)
        if (req.method === 'DELETE') { if (!row) return record(fail('not_found', 'server not found', 404)); SERVERS.delete(id); return record(json({ action: { id: 2, command: 'delete_server', status: 'running' } })) }
        return record(row ? json({ server: row }) : fail('not_found', 'server not found', 404))
      }
      return record(fail('not_found', `no route for ${path}`, 404))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, created, boot, reset, stop() { for (const r of hanging) r(); server.stop(true) } }
}
if (import.meta.main) {
  const env = process.env
  console.log(`[hz-sink] ${startHzSink({ port: Number(env.HZ_SINK_PORT ?? 0), token: env.HZ_SINK_TOKEN, bootMs: Number(env.HZ_SINK_BOOT_MS ?? 0) }).url}`)
}
