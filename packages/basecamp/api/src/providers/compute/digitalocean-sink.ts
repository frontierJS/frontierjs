// src/providers/compute/digitalocean-sink.ts — DigitalOcean, standing in for DigitalOcean.
//
// A dev listener speaking the real thing's shape: a bearer token, `/v2/` paths,
// each list under its own envelope key, prices as floats of dollars, and a
// droplet whose `status` is one of DO's four words.
//
// A SEPARATE LISTENER rather than an in-process fake, for the reason
// `example`'s Stripe sink states: a fake proves the payload was built and
// nothing else — no credential resolves, no timeout or 5xx is reachable, and
// `error.kind` is untestable. Here the token really is read off an
// `Authorization` header that conduit really wrote, from a `Secret` that was
// really decrypted.
//
// It does NOT pretend to be DigitalOcean's semantics. There is no billing, no
// rate limit and no droplet lifecycle. It answers the four reads this app makes
// and the one refusal worth testing, which is a token it does not recognize.
//
//   bun api/src/providers/compute/digitalocean-sink.ts
//
// Port 8122 — project 2 (basecamp), backend, the slot after the mail sink at
// 8121 (`packages/cli/core/ports.js`).

const PORT = Number(process.env.DO_SINK_PORT ?? 8122)

/** What this stand-in accepts. A real token starts `dop_v1_`; so does this, so
 *  a screen that validates the prefix is exercised rather than bypassed. */
const TOKEN = process.env.DO_SINK_TOKEN ?? 'dop_v1_devtoken'

/** How long a created droplet takes to come up, or 0 for never. Zero is the
 *  default so nothing in-process depends on a timer. */
const BOOT_MS = Number(process.env.DO_SINK_BOOT_MS ?? 0)

// ─── The catalog it serves ───────────────────────────────────────────────
// Small and real-shaped. Prices are floats of dollars because that is what DO
// sends, and the connector turning them into minor units is the thing under
// test — a sink answering integers would make that conversion untestable.

const REGIONS = [
  { slug: 'nyc3', name: 'New York 3',   available: true  },
  { slug: 'fra1', name: 'Frankfurt 1',  available: true  },
  { slug: 'sgp1', name: 'Singapore 1',  available: true  },
  { slug: 'ams2', name: 'Amsterdam 2',  available: false },
]

const SIZES = [
  { slug: 's-1vcpu-1gb', description: 'Basic',   vcpus: 1, memory: 1024,  disk: 25,
    price_monthly: 6,     regions: ['nyc3', 'fra1', 'sgp1'] },
  { slug: 's-2vcpu-4gb', description: 'Basic',   vcpus: 2, memory: 4096,  disk: 80,
    price_monthly: 24,    regions: ['nyc3', 'fra1', 'sgp1'] },
  // A price with a fractional cent in it, so the rounding is exercised by an
  // ordinary read rather than only by a test that reaches for it.
  { slug: 'c-4',         description: 'CPU-Opt', vcpus: 4, memory: 8192,  disk: 50,
    price_monthly: 84.005, regions: ['nyc3'] },
]

const IMAGES = [
  { slug: 'ubuntu-24-04-x64', distribution: 'Ubuntu', name: '24.04 (LTS) x64' },
  { slug: 'debian-12-x64',    distribution: 'Debian', name: '12 x64' },
]

/** Droplets this stand-in knows about. One is seeded so `machine()` has
 *  something to read; the rest are made by `POST /v2/droplets`. */
const DROPLETS = new Map<string, Record<string, unknown>>([
  ['901', {
    id: 901, name: 'general-01', status: 'active', tags: [],
    region:   { slug: 'nyc3' },
    networks: { v4: [
      { ip_address: '10.0.0.9',   type: 'private' },
      { ip_address: '203.0.113.9', type: 'public'  },
    ] },
  }],
])

/** What each created droplet was asked for, so a test can assert the SPEC that
 *  crossed the wire rather than only that something was created. The user_data
 *  is in here, which is the whole install. */
export const CREATED: Record<string, unknown>[] = []

let nextId = 1000

/** Reset between tests. A stand-in that accumulates state across a suite makes
 *  *how many machines did this create* unanswerable, which is the one question
 *  a provisioning test exists to ask. */
export function resetSink(): void {
  CREATED.length = 0
  nextId = 1000
  for (const id of [...DROPLETS.keys()]) if (id !== '901') DROPLETS.delete(id)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * `POST /v2/droplets` — a create, answered the way DO answers one.
 *
 * Two things are deliberate. The new droplet's status is `new` and NOT
 * `active`: a real create returns before the machine is up, so a caller that
 * treated the create response as *the machine is ready* would work here and
 * fail everywhere. And the size and region are CHECKED against the catalog, so
 * a create naming something that does not exist is refused with DO's own 422
 * rather than quietly succeeding — which is what makes a picker offering a size
 * the region lacks a testable mistake.
 */
async function createDroplet(req: Request): Promise<Response> {
  const spec = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!spec) return json({ id: 'unprocessable_entity', message: 'no body' }, 422)

  const size   = SIZES.find(s => s.slug === spec.size)
  const region = REGIONS.find(r => r.slug === spec.region)

  if (!size)   return json({ id: 'unprocessable_entity', message: `unknown size ${spec.size}` }, 422)
  if (!region) return json({ id: 'unprocessable_entity', message: `unknown region ${spec.region}` }, 422)
  if (!region.available)
    return json({ id: 'unprocessable_entity', message: `${region.slug} is not available` }, 422)
  if (!size.regions.includes(region.slug))
    return json({ id: 'unprocessable_entity',
                  message: `size ${size.slug} is not offered in ${region.slug}` }, 422)

  const id  = String(nextId++)
  const row = {
    id:       Number(id),
    name:     spec.name,
    status:   'new',
    tags:     Array.isArray(spec.tags) ? spec.tags : [],
    region:   { slug: region.slug },
    // A machine that is still building has no address yet. A caller waiting for
    // one is the behavior a real provision has to have.
    networks: { v4: [] },
  }
  DROPLETS.set(id, row)
  CREATED.push(spec)

  // A real droplet comes up on its own a minute or so later. In-process tests
  // must not depend on a clock, so this is OFF unless asked for: `sinkBoot` is
  // the deterministic door and stays the one the unit tests use. A drive that
  // needs the machine to actually arrive sets `DO_SINK_BOOT_MS` and then waits
  // for the same thing a real one waits for.
  if (BOOT_MS > 0) setTimeout(() => sinkBoot(id, `203.0.113.${100 + (Number(id) % 100)}`), BOOT_MS)

  return json({ droplet: row }, 202)
}

/** Bring a droplet up, as the vendor would a few seconds later. Only a
 *  stand-in has this: it is how a test reaches the state a real cloud takes a
 *  minute to arrive at. */
export function sinkBoot(providerServerId: string, ip = '203.0.113.50'): void {
  const row = DROPLETS.get(providerServerId)
  if (!row) return
  row.status   = 'active'
  row.networks = { v4: [{ ip_address: ip, type: 'public' }] }
}

export function startDoSink(port = PORT) {
  return Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)

      // The token is read off the header conduit wrote. A wrong one is DO's own
      // 401 shape, so `error.kind` on the caller's side is the real thing.
      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${TOKEN}`) {
        // Named, not silent. A stand-in that refuses without saying what it was
        // handed turns every credential mistake into the vendor's own opaque
        // 401, which is the failure this listener exists to make legible.
        console.error(`[do-sink] refused ${req.method} ${url.pathname} — authorization: ${JSON.stringify(auth)}`)
        return json({ id: 'unauthorized', message: 'Unable to authenticate you.' }, 401)
      }

      if (url.pathname === '/v2/account')
        return json({ account: { uuid: 'acct-dev', email: 'dev@localhost', status: 'active' } })

      if (url.pathname === '/v2/regions') return json({ regions: REGIONS })
      if (url.pathname === '/v2/sizes')   return json({ sizes:   SIZES   })
      if (url.pathname === '/v2/images')  return json({ images:  IMAGES  })

      // A list filtered by tag — the reconciliation read. Checked BEFORE the
      // single-droplet route, since both live under /v2/droplets.
      if (url.pathname === '/v2/droplets') {
        if (req.method === 'POST') return createDroplet(req)

        const tag = url.searchParams.get('tag_name')
        const all = [...DROPLETS.values()]
        return json({ droplets: tag
          ? all.filter(d => (d.tags as string[] | undefined)?.includes(tag))
          : all })
      }

      const droplet = url.pathname.match(/^\/v2\/droplets\/([^/]+)$/)
      if (droplet) {
        const id  = decodeURIComponent(droplet[1])
        const row = DROPLETS.get(id)

        if (req.method === 'DELETE') {
          if (!row) return json({ id: 'not_found', message: 'not found' }, 404)
          DROPLETS.delete(id)
          // DO answers 204 with no body. Worth mimicking: a connector that
          // assumed a JSON body here would work against a fake and fail here.
          return new Response(null, { status: 204 })
        }

        return row
          ? json({ droplet: row })
          : json({ id: 'not_found', message: 'The resource you requested could not be found.' }, 404)
      }

      return json({ id: 'not_found', message: `no route for ${url.pathname}` }, 404)
    },
  })
}

if (import.meta.main) {
  const server = startDoSink()
  console.log(`[do-sink] DigitalOcean stand-in on http://localhost:${server.port} — token ${TOKEN}`)
}
