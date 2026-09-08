// src/providers/compute/sink.ts — DigitalOcean, standing in for DigitalOcean.
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
//   bun api/src/providers/compute/sink.ts
//
// Port 8122 — project 2 (basecamp), backend, the slot after the mail sink at
// 8121 (`packages/cli/core/ports.js`).

const PORT = Number(process.env.DO_SINK_PORT ?? 8122)

/** What this stand-in accepts. A real token starts `dop_v1_`; so does this, so
 *  a screen that validates the prefix is exercised rather than bypassed. */
const TOKEN = process.env.DO_SINK_TOKEN ?? 'dop_v1_devtoken'

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

/** Droplets this stand-in knows about. Seeded with one so `machine()` has
 *  something to read; nothing here creates any, because creating machines is
 *  phase 2 and a sink that answered a create nobody wrote would be a claim. */
const DROPLETS = new Map<string, Record<string, unknown>>([
  ['901', {
    id: 901, name: 'general-01', status: 'active',
    region:   { slug: 'nyc3' },
    networks: { v4: [
      { ip_address: '10.0.0.9',   type: 'private' },
      { ip_address: '203.0.113.9', type: 'public'  },
    ] },
  }],
])

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function startDoSink(port = PORT) {
  return Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)

      // The token is read off the header conduit wrote. A wrong one is DO's own
      // 401 shape, so `error.kind` on the caller's side is the real thing.
      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${TOKEN}`)
        return json({ id: 'unauthorized', message: 'Unable to authenticate you.' }, 401)

      if (url.pathname === '/v2/account')
        return json({ account: { uuid: 'acct-dev', email: 'dev@localhost', status: 'active' } })

      if (url.pathname === '/v2/regions') return json({ regions: REGIONS })
      if (url.pathname === '/v2/sizes')   return json({ sizes:   SIZES   })
      if (url.pathname === '/v2/images')  return json({ images:  IMAGES  })

      const droplet = url.pathname.match(/^\/v2\/droplets\/([^/]+)$/)
      if (droplet) {
        const row = DROPLETS.get(decodeURIComponent(droplet[1]))
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
