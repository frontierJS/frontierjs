// sink.ts — DigitalOcean, standing in for DigitalOcean. Copied from basecamp's
// `compute/digitalocean-sink.ts` with chaos added: `{ lost }`, `{ rateLimit:
// { retryAfter } }` (DO also sends `RateLimit-Reset`), `{ failNext }`,
// `{ createNoId }` — a 202 with no droplet in it, the worst answer a create
// can give. Prices are floats of dollars because that is what DO sends; a
// size with `84.005` exercises the rounding on an ordinary read.
//
// The handle is for a test in the same process: `created` is each spec that
// crossed the wire, `boot` brings a droplet up, `reset` empties it back to the
// seed. A drive that needs a machine to arrive on its own sets `bootMs`; it is
// 0 by default so nothing in-process depends on a timer.

export interface DoSinkOptions { port?: number; token?: string; /** a created droplet comes up after this long; 0 is never */ bootMs?: number }

const REGIONS = [
  { slug: 'nyc3', name: 'New York 3', available: true }, { slug: 'fra1', name: 'Frankfurt 1', available: true },
  { slug: 'sgp1', name: 'Singapore 1', available: true }, { slug: 'ams2', name: 'Amsterdam 2', available: false },
]
const SIZES = [
  { slug: 's-1vcpu-1gb', description: 'Basic', vcpus: 1, memory: 1024, disk: 25, price_monthly: 6, regions: ['nyc3', 'fra1', 'sgp1'] },
  { slug: 's-2vcpu-4gb', description: 'Basic', vcpus: 2, memory: 4096, disk: 80, price_monthly: 24, regions: ['nyc3', 'fra1', 'sgp1'] },
  { slug: 'c-4', description: 'CPU-Opt', vcpus: 4, memory: 8192, disk: 50, price_monthly: 84.005, regions: ['nyc3'] },
]
const IMAGES = [{ slug: 'ubuntu-24-04-x64', distribution: 'Ubuntu', name: '24.04 (LTS) x64' }, { slug: 'debian-12-x64', distribution: 'Debian', name: '12 x64' }]
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

export function startDoSink(opts: DoSinkOptions = {}) {
  const TOKEN = opts.token ?? 'dop_v1_devtoken', BOOT_MS = opts.bootMs ?? 0
  const SEED = () => ({ id: 901, name: 'general-01', status: 'active', tags: ['fleet'], region: { slug: 'nyc3' }, networks: { v4: [{ ip_address: '10.0.0.9', type: 'private' }, { ip_address: '203.0.113.9', type: 'public' }] } })
  const DROPLETS = new Map<string, Record<string, unknown>>([['901', SEED()]])
  const created: Record<string, unknown>[] = []
  const seen: { method: string; path: string; status: number }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter: number }, createNoId: false }
  const hanging: Array<() => void> = []
  let nextId = 1000
  const boot = (id: string, ip = '203.0.113.50') => { const d = DROPLETS.get(id); if (d) { d.status = 'active'; d.networks = { v4: [{ ip_address: ip, type: 'public' }] } } return !!d }
  // A stand-in that accumulates across a suite makes *how many machines did this create* unanswerable.
  const reset = () => { seen.length = 0; created.length = 0; nextId = 1000; DROPLETS.clear(); DROPLETS.set('901', SEED()); Object.assign(armed, { lost: false, failNext: false, rateLimit: null, createNoId: false }) }

  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url), path = url.pathname
      if (path === '/_sink/seen')  return json({ requests: seen, created, droplets: [...DROPLETS.values()] })
      if (path === '/_sink/reset') { reset(); return json({ ok: true }) }
      if (path === '/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true }) }
      /** Bring a droplet up, as the vendor would a minute later. */
      if (path === '/_sink/boot' && req.method === 'POST') { const { id, ip } = await req.json() as { id: string; ip?: string }; return json({ ok: boot(id, ip) }) }

      const entry = { method: req.method, path, status: 0 }; seen.push(entry)
      const record = async (r: Response) => { if (armed.lost) { armed.lost = false; await new Promise<void>(res => hanging.push(res)) } entry.status = r.status; return r }
      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${TOKEN}`) {
        // Named, so a credential mistake is legible here rather than only as the vendor's opaque 401.
        console.error(`[do-sink] refused ${req.method} ${path} — authorization: ${JSON.stringify(auth)}`)
        return record(json({ id: 'unauthorized', message: 'Unable to authenticate you.' }, 401))
      }
      if (armed.rateLimit) { const { retryAfter } = armed.rateLimit; armed.rateLimit = null; return record(json({ id: 'too_many_requests', message: 'API Rate limit exceeded.' }, 429, { 'retry-after': String(retryAfter), 'ratelimit-reset': String(Math.floor(Date.now() / 1000) + retryAfter) })) }
      if (armed.failNext) { armed.failNext = false; return record(json({ id: 'server_error', message: 'Server was unable to give you a response.' }, 500)) }

      if (path === '/v2/account') return record(json({ account: { uuid: 'acct-dev', email: 'dev@localhost', status: 'active' } }))
      if (path === '/v2/regions') return record(json({ regions: REGIONS }))
      if (path === '/v2/sizes')   return record(json({ sizes: SIZES }))
      if (path === '/v2/images')  return record(json({ images: IMAGES }))
      if (path === '/v2/droplets') {
        if (req.method === 'POST') {
          const spec = await req.json().catch(() => null) as Record<string, unknown> | null
          if (!spec) return record(json({ id: 'unprocessable_entity', message: 'no body' }, 422))
          const size = SIZES.find(s => s.slug === spec.size), region = REGIONS.find(r => r.slug === spec.region)
          if (!size)   return record(json({ id: 'unprocessable_entity', message: `unknown size ${spec.size}` }, 422))
          if (!region) return record(json({ id: 'unprocessable_entity', message: `unknown region ${spec.region}` }, 422))
          if (!region.available || !size.regions.includes(region.slug)) return record(json({ id: 'unprocessable_entity', message: `size ${size.slug} is not offered in ${region.slug}` }, 422))
          const id = String(nextId++)
          // Created with status `new` and no address: a real create returns before the machine is up.
          DROPLETS.set(id, { id: Number(id), name: spec.name, status: 'new', tags: Array.isArray(spec.tags) ? spec.tags : [], region: { slug: region.slug }, networks: { v4: [] } })
          created.push(spec)
          if (BOOT_MS > 0) setTimeout(() => boot(id, `203.0.113.${100 + (Number(id) % 100)}`), BOOT_MS)
          if (armed.createNoId) { armed.createNoId = false; return record(json({ droplet: null, links: {} }, 202)) }
          return record(json({ droplet: DROPLETS.get(id) }, 202))
        }
        const tag = url.searchParams.get('tag_name'), all = [...DROPLETS.values()]
        return record(json({ droplets: tag ? all.filter(d => (d.tags as string[]).includes(tag)) : all }))
      }
      const one = path.match(/^\/v2\/droplets\/([^/]+)$/)
      if (one) {
        const id = decodeURIComponent(one[1]), row = DROPLETS.get(id)
        if (req.method === 'DELETE') { if (!row) return record(json({ id: 'not_found', message: 'not found' }, 404)); DROPLETS.delete(id); return record(new Response(null, { status: 204 })) }
        return record(row ? json({ droplet: row }) : json({ id: 'not_found', message: 'The resource you requested could not be found.' }, 404))
      }
      return record(json({ id: 'not_found', message: `no route for ${path}` }, 404))
    },
  })
  return { port: server.port, url: `http://127.0.0.1:${server.port}`, created, boot, reset, stop() { for (const r of hanging) r(); server.stop(true) } }
}
if (import.meta.main) {
  const env = process.env
  console.log(`[do-sink] ${startDoSink({ port: Number(env.DO_SINK_PORT ?? 0), token: env.DO_SINK_TOKEN, bootMs: Number(env.DO_SINK_BOOT_MS ?? 0) }).url}`)
}
