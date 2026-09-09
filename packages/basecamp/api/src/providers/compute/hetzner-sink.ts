// src/providers/compute/hetzner-sink.ts — Hetzner Cloud, standing in for Hetzner.
//
// A SECOND listener rather than a second dialect inside the first one. Two
// vendors answered by one process would share a router, a store and an error
// shape, and the whole reason a second cloud is built at all is to find out
// what the first one's shape had quietly become (`docs/PROVISIONING.md` § P4).
// A stand-in that agreed with the connector by construction would answer that
// question with itself.
//
// Everything here is Hetzner's shape and not DigitalOcean's: `/v1/` paths,
// locations rather than regions, prices as decimal STRINGS with a net and a
// gross, memory in gigabytes as a float, labels as a map with a selector
// grammar, a create that answers 201 with an action beside the server, and a
// delete that answers 200 with an action where DO answers 204 with nothing.
//
//   bun api/src/providers/compute/hetzner-sink.ts
//
// Port 8124 — project 2 (basecamp), backend, the slot after the DigitalOcean
// stand-in's dev port and its unit-test twin (`packages/cli/core/ports.js`).

const PORT = Number(process.env.HZ_SINK_PORT ?? 8124)

/** What this stand-in accepts. Hetzner's own tokens are 64 opaque characters
 *  with no prefix, which is itself a difference from DigitalOcean's `dop_v1_`
 *  — a screen validating one vendor's prefix would refuse the other's key. */
const TOKEN = process.env.HZ_SINK_TOKEN ?? 'hz'.padEnd(64, '0')

/** How long a created machine takes to come up, or 0 for never. Zero is the
 *  default so nothing in-process depends on a timer. */
const BOOT_MS = Number(process.env.HZ_SINK_BOOT_MS ?? 0)

// ─── The catalog it serves ───────────────────────────────────────────────

const LOCATIONS = [
  { id: 1, name: 'nbg1', description: 'Nuremberg DC Park 1', country: 'DE', city: 'Nuremberg' },
  { id: 2, name: 'fsn1', description: 'Falkenstein DC Park 1', country: 'DE', city: 'Falkenstein' },
  { id: 3, name: 'hel1', description: 'Helsinki DC Park 1', country: 'FI', city: 'Helsinki' },
]

/**
 * Server types, priced PER LOCATION and priced as strings.
 *
 * The prices differ between locations on purpose: `cpx11` costs more in
 * Helsinki than in Nuremberg, so a connector that took the first price in the
 * array — or the cheapest, or the last — is a wrong number on the cost line
 * rather than an equal one, and the assertion can see it.
 *
 * `cax11` is offered in ONE location, which is what makes *a size the region
 * does not have* testable without arranging anything.
 *
 * `memory` is a float of gigabytes, `1.9` included, because that is what
 * Hetzner sends and rounding it is the connector's job.
 */
const price = (net: number) => ({
  net:   net.toFixed(10),
  // 19% German VAT, which is what Hetzner computes gross with for an account
  // that has not given a VAT id. The connector reads GROSS, so a stand-in
  // whose two numbers were equal could not tell which one it read.
  gross: (net * 1.19).toFixed(10),
})

const SERVER_TYPES = [
  { id: 22, name: 'cpx11', description: 'CPX 11', cores: 2, memory: 2, disk: 40,
    deprecated: false,
    prices: [
      { location: 'nbg1', price_hourly: price(0.0071), price_monthly: price(4.35) },
      { location: 'fsn1', price_hourly: price(0.0071), price_monthly: price(4.35) },
      { location: 'hel1', price_hourly: price(0.0079), price_monthly: price(4.85) },
    ] },
  { id: 23, name: 'cpx21', description: 'CPX 21', cores: 3, memory: 4, disk: 80,
    deprecated: false,
    prices: [
      { location: 'nbg1', price_hourly: price(0.0127), price_monthly: price(7.55) },
      { location: 'fsn1', price_hourly: price(0.0127), price_monthly: price(7.55) },
    ] },
  { id: 45, name: 'cax11', description: 'CAX 11 (Arm)', cores: 2, memory: 1.9, disk: 40,
    deprecated: false,
    prices: [
      { location: 'fsn1', price_hourly: price(0.0060), price_monthly: price(3.79) },
    ] },
]

const IMAGES = [
  { id: 114690387, type: 'system', status: 'available',
    name: 'ubuntu-24.04', description: 'Ubuntu 24.04', os_flavor: 'ubuntu' },
  { id: 114690388, type: 'system', status: 'available',
    name: 'debian-12',   description: 'Debian 12',   os_flavor: 'debian' },
  // Deprecated and therefore not offered. A picker showing it is a create the
  // vendor refuses, which is the mistake `status=available` exists to prevent.
  { id: 5924233,   type: 'system', status: 'deprecated',
    name: 'debian-10',   description: 'Debian 10',   os_flavor: 'debian' },
]

/** Machines this stand-in knows about. One is seeded so `machine()` has
 *  something to read; the rest are made by `POST /v1/servers`. */
const SERVERS = new Map<string, Record<string, unknown>>([
  ['7701', {
    id: 7701, name: 'legacy-01', status: 'running', labels: {},
    public_net: { ipv4: { id: 1, ip: '198.51.100.7', blocked: false } },
    datacenter: { name: 'nbg1-dc3', location: { name: 'nbg1', description: 'Nuremberg DC Park 1' } },
  }],
])

/** What each created machine was asked for, so a test can assert the SPEC that
 *  crossed the wire and not only that something was created. */
export const HZ_CREATED: Record<string, unknown>[] = []

let nextId = 8000

export function resetHzSink(): void {
  HZ_CREATED.length = 0
  nextId = 8000
  for (const id of [...SERVERS.keys()]) if (id !== '7701') SERVERS.delete(id)
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Hetzner's error envelope, which is not DigitalOcean's. */
const fail = (code: string, message: string, status: number) =>
  json({ error: { code, message } }, status)

/**
 * `POST /v1/servers`.
 *
 * Answers **201** with the server, an action, and `root_password: null` —
 * three ways this differs from DO's 202 with a bare droplet. The status is
 * `initializing`, because a real create returns long before the machine is up.
 *
 * The type and location are checked against the catalog and, separately,
 * against each other: a type that exists and is not sold in the requested
 * location is Hetzner's own `invalid_input`, which is what makes a picker
 * offering `cax11` in Nuremberg a testable mistake rather than a slow one.
 */
async function createServer(req: Request): Promise<Response> {
  const spec = await req.json().catch(() => null) as Record<string, unknown> | null
  if (!spec) return fail('invalid_input', 'no body', 400)

  const type     = SERVER_TYPES.find(t => t.name === spec.server_type)
  const location = LOCATIONS.find(l => l.name === spec.location)
  const image    = IMAGES.find(i => i.name === spec.image)

  if (!type)     return fail('invalid_input', `server_type ${spec.server_type} not found`, 400)
  if (!location) return fail('invalid_input', `location ${spec.location} not found`, 400)
  if (!image)    return fail('invalid_input', `image ${spec.image} not found`, 400)
  if (image.status !== 'available')
    return fail('invalid_input', `image ${image.name} is ${image.status}`, 400)
  if (!type.prices.some(p => p.location === location.name))
    return fail('invalid_input',
      `server type ${type.name} is not available in ${location.name}`, 400)

  // A label key Hetzner would refuse. Checked here because it is the ONE
  // constraint a connector can get wrong and still look correct: a machine
  // marked with a key the vendor rejects never gets created, and a machine
  // marked with a key it accepts but a selector cannot name is an orphan.
  const labels = (spec.labels ?? {}) as Record<string, unknown>
  for (const key of Object.keys(labels))
    if (!/^[a-zA-Z0-9]([-_.a-zA-Z0-9]{0,61}[a-zA-Z0-9])?$/.test(key))
      return fail('invalid_input', `label key ${JSON.stringify(key)} is invalid`, 400)

  const id  = String(nextId++)
  const row = {
    id:         Number(id),
    name:       spec.name,
    status:     'initializing',
    labels,
    // Still building, so there is no address yet. A caller waiting for one is
    // the behavior a real provision has to have.
    public_net: { ipv4: null },
    datacenter: { name: `${location.name}-dc1`,
                  location: { name: location.name, description: location.description } },
  }
  SERVERS.set(id, row)
  HZ_CREATED.push(spec)

  if (BOOT_MS > 0) setTimeout(() => hzBoot(id, `198.51.100.${100 + (Number(id) % 100)}`), BOOT_MS)

  return json({
    server: row,
    action: { id: 1, command: 'create_server', status: 'running', progress: 0 },
    // Hetzner hands one back for a machine created with no SSH key. It is null
    // here because `start_after_create` was asked for, and nothing in this app
    // ever reads it.
    root_password: null,
  }, 201)
}

/** Bring a machine up, as the vendor would a minute later. */
export function hzBoot(providerServerId: string, ip = '198.51.100.50'): void {
  const row = SERVERS.get(providerServerId)
  if (!row) return
  row.status     = 'running'
  row.public_net = { ipv4: { id: 2, ip, blocked: false } }
}

/**
 * Hetzner's label selector, as far as this app uses it.
 *
 * `key` is existence and `key==value` is equality. The full grammar has `!=`,
 * `in (…)`, `notin (…)` and comma-separated conjunctions; none of them is
 * written by this app, and a stand-in implementing a grammar its caller does
 * not speak is a test of the stand-in.
 */
function selects(labels: Record<string, unknown>, selector: string): boolean {
  const [key, value] = selector.split('==')
  if (value === undefined) return key in labels
  return String(labels[key] ?? '') === value
}

export function startHzSink(port = PORT) {
  return Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url)

      const auth = req.headers.get('authorization') ?? ''
      if (auth !== `Bearer ${TOKEN}`) {
        console.error(`[hz-sink] refused ${req.method} ${url.pathname} — authorization: ${JSON.stringify(auth)}`)
        return fail('unauthorized', 'unable to authenticate', 401)
      }

      if (url.pathname === '/v1/locations') return json({ locations: LOCATIONS })

      if (url.pathname === '/v1/server_types') return json({ server_types: SERVER_TYPES })

      if (url.pathname === '/v1/images') {
        const type   = url.searchParams.get('type')
        const status = url.searchParams.get('status')
        return json({ images: IMAGES
          .filter(i => !type   || i.type   === type)
          .filter(i => !status || i.status === status) })
      }

      if (url.pathname === '/v1/servers') {
        if (req.method === 'POST') return createServer(req)

        const selector = url.searchParams.get('label_selector')
        const all      = [...SERVERS.values()]
        return json({ servers: selector
          ? all.filter(s => selects((s.labels ?? {}) as Record<string, unknown>, selector))
          : all })
      }

      const one = url.pathname.match(/^\/v1\/servers\/([^/]+)$/)
      if (one) {
        const id  = decodeURIComponent(one[1])
        const row = SERVERS.get(id)

        if (req.method === 'DELETE') {
          if (!row) return fail('not_found', 'server not found', 404)
          SERVERS.delete(id)
          // 200 with an action, where DigitalOcean answers 204 with no body at
          // all. A connector that read a body here unconditionally would work
          // against one vendor and throw against the other.
          return json({ action: { id: 2, command: 'delete_server', status: 'running' } })
        }

        return row ? json({ server: row }) : fail('not_found', 'server not found', 404)
      }

      return fail('not_found', `no route for ${url.pathname}`, 404)
    },
  })
}

if (import.meta.main) {
  const server = startHzSink()
  console.log(`[hz-sink] Hetzner Cloud stand-in on http://localhost:${server.port} — token ${TOKEN}`)
}
