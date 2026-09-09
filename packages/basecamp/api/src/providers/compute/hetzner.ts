// src/providers/compute/hetzner.ts
// Hetzner Cloud's dialect, and the only file in this app that knows it.
//
// The second cloud, and it is here to answer a question one connector cannot:
// is `ComputeConnector` a boundary, or is it DigitalOcean's shape wearing a
// general name (`docs/PROVISIONING.md` § P4, `FJS-D153`)? It disagreed in four
// ways that reached the interface and are recorded there rather than here:
//
//   · a price is per LOCATION, so `ComputeSize.prices` is a map;
//   · a machine is marked with LABELS — a map, with a key grammar a colon is
//     not in — so a caller states a `MachineMark` and a connector spells it;
//   · memory is GIGABYTES AS A FLOAT where DO's is an integer of megabytes;
//   · there are nine state words where DO has four, one of them literally
//     `unknown`.
//
// And two that did not: the credential is a bearer token, and the body is
// JSON. Neither is a coincidence worth relying on — `encoding` exists on a
// conduit target because Stripe needed it.
//
// ─── Money ───────────────────────────────────────────────────────────────
//
// A price arrives as a STRING — `"5.8300000000"` — and it arrives twice, `net`
// and `gross`. `gross` is what this account is billed: Hetzner computes it with
// the account's own VAT rate, and the catalog read is authenticated as that
// account, so it is the number the person choosing a size will see on an
// invoice. `net` would be the vendor's list price and somebody else's tax.
//
// The currency is EUR and is the first thing here that is not USD, which is
// what `minorUnits(currency)` was always for.

import { minorUnits, roundMinor } from '@frontierjs/toolbelt/units'
import { env }                    from '../../core/env.ts'
import type { TargetDescriptor }  from '@frontierjs/conduit'
import { FLEET }                  from './index.ts'
import type {
  ComputeConnector, ComputeSend, ComputeCatalog, ComputeMachine, MachineState,
  ComputeRegion, ComputeSize, ComputeImage, MachineSpec, MachineMark,
} from './index.ts'

/** Where Hetzner Cloud is, when `HETZNER_URL` does not point somewhere else. */
const HZ_API = 'https://api.hetzner.cloud'

/** Hetzner's documented maximum, and a quarter of DigitalOcean's. A page size
 *  copied from the other connector would be accepted and then silently clamped,
 *  which is a list that looks complete and is not. */
const PER_PAGE = 50

const CURRENCY = 'EUR'

// ─── Reading Hetzner's answers ───────────────────────────────────────────

type Row = Record<string, unknown>

const rows = (body: unknown, key: string): Row[] => {
  const list = (body as Row | null)?.[key]
  return Array.isArray(list) ? list as Row[] : []
}

const str = (v: unknown): string => typeof v === 'string' ? v : ''
const num = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) ? v : 0

/** A price, which Hetzner sends as a decimal string. `Number('')` is 0 and a
 *  size costing nothing would be offered as free, so an unparseable value is
 *  null and the size loses that location rather than gaining a wrong price. */
function toMinor(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return roundMinor(n * 10 ** minorUnits(CURRENCY))
}

/**
 * A location is a region here.
 *
 * `available` is always true, and that is a statement rather than a stub:
 * Hetzner publishes no per-location availability flag, because what can
 * actually be created where is per SERVER TYPE — a type absent from a
 * location's prices is one that location does not sell. That is the
 * availability this app reads, and it reads it off `ComputeSize.prices`.
 */
function toRegion(l: Row): ComputeRegion {
  return {
    slug:      str(l.name),
    label:     str(l.description) || str(l.name),
    available: true,
  }
}

/**
 * A server type is a size, and its price list is its availability list.
 *
 * `memory` is gigabytes as a float — `1.9` is a real value Hetzner sends — so
 * the megabytes this boundary carries are computed rather than read.
 */
function toSize(t: Row): ComputeSize {
  const prices: Record<string, number> = {}
  for (const p of Array.isArray(t.prices) ? t.prices as Row[] : []) {
    const location = str(p.location)
    const minor    = toMinor((p.price_monthly as Row | undefined)?.gross)
    if (location && minor !== null) prices[location] = minor
  }

  return {
    slug:     str(t.name),
    label:    str(t.description) || str(t.name),
    vcpu:     num(t.cores),
    memoryMb: Math.round(num(t.memory) * 1024),
    diskGb:   num(t.disk),
    currency: CURRENCY,
    prices,
  }
}

function toImage(i: Row): ComputeImage {
  return { slug: str(i.name), label: str(i.description) || str(i.name) }
}

/**
 * Hetzner's nine words, in this app's vocabulary.
 *
 * `migrating` is a machine being moved between hosts. It is mapped to
 * `rebuilding` and deliberately not to `running`: it is reachable and it must
 * not have work placed on it, which is the distinction the state exists for.
 * `unknown` is Hetzner's own word as well as this boundary's, so it is listed
 * rather than left to the default — a state that arrives BY NAME and one that
 * fell through the table are the same answer and should reach it the same way.
 */
const STATES: Record<string, MachineState> = {
  initializing: 'starting',
  starting:     'starting',
  running:      'running',
  stopping:     'stopping',
  off:          'off',
  deleting:     'deleting',
  rebuilding:   'rebuilding',
  migrating:    'rebuilding',
  unknown:      'unknown',
}

// ─── Hetzner's spelling of a mark ────────────────────────────────────────
//
// Labels: a map, not a list, and the keys are constrained. A key is a DNS
// label — letters, digits, `-`, `_`, `.` — so `basecamp:server:<id>` is not a
// key Hetzner will accept, and the mark is written as one key holding the id
// instead of a colon-joined string holding both.

/** The key the fleet mark is written under. Its mere PRESENCE is the mark, so
 *  its value is empty — a selector naming a bare key matches on existence. */
const fleetKey = (mark: MachineMark) => mark.fleet

/** The key the machine's identity is written under, holding the `Server` id. */
const serverKey = (mark: MachineMark) => `${mark.fleet}.server`

/** What a create applies. */
const markLabels = (mark: MachineMark): Record<string, string> =>
  mark.serverId
    ? { [fleetKey(mark)]: '', [serverKey(mark)]: mark.serverId }
    : { [fleetKey(mark)]: '' }

/**
 * The selector this mark asks by.
 *
 * `key` alone is existence and `key==value` is equality — Hetzner's own
 * grammar, and the reason the fleet mark needs no value at all.
 */
const markSelector = (mark: MachineMark): string =>
  mark.serverId ? `${serverKey(mark)}==${mark.serverId}` : fleetKey(mark)

/** The `Server` a machine says it is, read back off its labels. */
function markedServer(server: Row): string | null {
  const labels = (server.labels ?? {}) as Record<string, unknown>
  return str(labels[`${FLEET}.server`]) || null
}

/** The public v4 address, or null. Hetzner nests one object where DO sends a
 *  list to be filtered by type, and a machine still building has neither. */
function publicIp(server: Row): string | null {
  const v4 = (server.public_net as Row | undefined)?.ipv4 as Row | undefined
  return v4 ? str(v4.ip) || null : null
}

/** Which location a machine is in. Nested one deeper than DO's: a datacenter
 *  is in a location, and the location is what a catalog names. */
function locationOf(server: Row): string | null {
  const dc = server.datacenter as Row | undefined
  return str((dc?.location as Row | undefined)?.name) || null
}

function toMachine(server: Row, fallbackId = ''): ComputeMachine {
  return {
    providerServerId: String(server.id ?? fallbackId),
    status:           STATES[str(server.status)] ?? 'unknown',
    ipAddress:        publicIp(server),
    region:           locationOf(server),
    serverId:         markedServer(server),
  }
}

/** Hetzner's error envelope: `{ error: { code, message } }`, where DO sends
 *  `{ id, message }`. Only the message is wanted, and only for a sentence a
 *  person reads — the CODE is deliberately not branched on, because the one
 *  decision that turns on which failure it was is 404, and that is a status. */
const said = (res: { error?: { kind: string; message?: string }; status?: number }) =>
  `Hetzner: ${res.error?.kind ?? 'error'}`
  + (res.status ? ` (HTTP ${res.status})` : '')
  + (res.error?.message ? ` — ${res.error.message}` : '')

// ─── The connector ───────────────────────────────────────────────────────

export const hetzner: ComputeConnector = {
  kind:  'hetzner',
  label: 'Hetzner Cloud',

  // A getter for DigitalOcean's reason: a module-level read is captured at
  // import, and a test pointing this at a stand-in afterwards would be talking
  // to the real Hetzner.
  get address() { return env.HETZNER_URL || HZ_API },

  descriptor({ accountId, ref, address }): TargetDescriptor {
    return {
      id:            `provider:hetzner:${accountId}`,
      kind:          'provider',
      protocol:      'http',
      address:       address || hetzner.address,
      auth:          { type: 'bearer', ref },
      registered_at: Date.now(),
      last_seen_at:  null,
    } as TargetDescriptor
  },

  async catalog(send): Promise<ComputeCatalog> {
    const [locations, types, images] = await Promise.all([
      send({ method: 'GET', path: `/v1/locations?per_page=${PER_PAGE}` }),
      send({ method: 'GET', path: `/v1/server_types?per_page=${PER_PAGE}` }),
      // `type=system` is Hetzner's word for a distribution image, and
      // `status=available` keeps a deprecated one out of a picker rather than
      // out of a create — a create naming it is refused by the vendor.
      send({ method: 'GET', path: `/v1/images?type=system&status=available&per_page=${PER_PAGE}` }),
    ])

    const failed = [locations, types, images].find(r => r.error)
    if (failed) throw new Error(said(failed))

    return {
      regions: rows(locations.data, 'locations'   ).map(toRegion).filter(r => r.slug),
      // A type with no price anywhere is one nothing can be quoted for, and a
      // picker offering it is a cost line with a hole in it.
      sizes:   rows(types.data,     'server_types').map(toSize)
                 .filter(s => s.slug && Object.keys(s.prices).length),
      images:  rows(images.data,    'images'      ).map(toImage).filter(i => i.slug),
    }
  },

  async machine(send, providerServerId): Promise<ComputeMachine | null> {
    const res = await send({
      method: 'GET', path: `/v1/servers/${encodeURIComponent(providerServerId)}`,
    })

    // 404 is *the vendor no longer has it*, which is an answer. Anything else
    // is NOT KNOWING and must never read as gone — the caller turns a null into
    // a `reportDestroyed` move.
    if (res.error) {
      if (res.status === 404) return null
      throw new Error(said(res))
    }

    const server = (res.data as Row | null)?.server as Row | undefined
    return server ? toMachine(server, providerServerId) : null
  },

  async create(send, spec: MachineSpec): Promise<{ providerServerId: string }> {
    const res = await send({ method: 'POST', path: '/v1/servers', body: {
      name:        spec.name,
      server_type: spec.size,
      image:       spec.image,
      location:    spec.region,
      user_data:   spec.userData,
      labels:      markLabels(spec.mark),
      // Hetzner will hand back a root password for a machine created without
      // an SSH key unless it is told to start on its own. There is nothing here
      // to receive one — the machine installs itself from `user_data` and
      // enrolls (`FJS-D241`) — so it is asked to boot and the password is
      // never read.
      start_after_create: true,
    }})

    if (res.error) throw new Error(`Hetzner refused the create — ${said(res)}`)

    const server = (res.data as Row | null)?.server as Row | undefined
    // A 2xx with no id is the worst answer this call can give: the machine may
    // exist and nothing here can name it. The label is then the only thread.
    if (!server?.id)
      throw new Error('Hetzner accepted the create and answered no server id — '
        + 'the machine may exist; reconcile by mark')

    return { providerServerId: String(server.id) }
  },

  async destroy(send, providerServerId): Promise<boolean> {
    const res = await send({
      method: 'DELETE', path: `/v1/servers/${encodeURIComponent(providerServerId)}`,
    })

    // A machine the vendor has never heard of is destroyed for our purposes:
    // every path into this one is a job that may be redelivered.
    if (res.status === 404) return true
    if (res.error) throw new Error(said(res))
    return true
  },

  async marked(send, mark): Promise<ComputeMachine[]> {
    const res = await send({
      method: 'GET',
      path:   `/v1/servers?label_selector=${encodeURIComponent(markSelector(mark))}`
            + `&per_page=${PER_PAGE}`,
    })
    if (res.error) throw new Error(said(res))

    return rows(res.data, 'servers').map(s => toMachine(s)).filter(m => m.providerServerId)
  },

  async verify(send): Promise<boolean> {
    // Hetzner has no account endpoint, so the cheapest authenticated read is a
    // one-row list. It answers the only question Verify asks — does this token
    // open anything — and a token that opens an EMPTY account still proves it
    // is a token, which is why the test is the absence of an error and not the
    // presence of a machine.
    const res = await send({ method: 'GET', path: '/v1/servers?per_page=1' })
    return !res.error && Array.isArray((res.data as Row | null)?.servers)
  },
}
