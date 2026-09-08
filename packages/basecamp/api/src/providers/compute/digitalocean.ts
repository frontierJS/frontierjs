// src/providers/compute/digitalocean.ts
// DigitalOcean's dialect, and the only file in this app that knows it.
//
// Everything vendor-specific is here: the `/v2/` prefix, the envelope key each
// list arrives under, that a size's price is a FLOAT OF DOLLARS, that memory is
// megabytes and disk is gigabytes, and that a droplet's state is one of four
// words. A caller sees `ComputeCatalog` and `ComputeMachine` and never a
// droplet.
//
// The token is a REF on the descriptor, resolved at send time by
// `core/credentials.ts`, so it is not in the registry and not on the
// `GET /conduit-targets` answer.
//
// ─── Money ───────────────────────────────────────────────────────────────
//
// `price_monthly` is `24.0` — dollars, as a JSON number. It crosses this
// boundary as minor units plus a currency, which is `docs/ADAPTERS.md`'s rule
// and `@money`'s: the divisor belongs to the currency, so `* 100` is wrong for
// the yen by a hundred. `minorUnits('USD')` is asked rather than assumed even
// though the answer is 2, because the day a vendor bills in another currency
// the only thing that has to change is the code below reading it.

import { minorUnits, roundMinor } from '@frontierjs/toolbelt/units'
import { env }                    from '../../core/env.ts'
import type { TargetDescriptor }  from '@frontierjs/conduit'
import type {
  ComputeConnector, ComputeSend, ComputeCatalog, ComputeMachine, MachineState,
  ComputeRegion, ComputeSize, ComputeImage,
} from './index.ts'

/** Where DigitalOcean is. Overridden by `DIGITALOCEAN_URL` for the dev sink.
 *  Read through `env` rather than `process.env`, so a name nobody declared is a
 *  startup refusal instead of an undefined that silently means *the real one*. */
const DO_API = 'https://api.digitalocean.com'

/** DO pages at 20 by default and a fleet picker wants the whole list. 200 is
 *  its documented maximum; a cloud with more sizes than that would need the
 *  `links.pages.next` walk, which is deliberately not written until one does. */
const PER_PAGE = 200

const CURRENCY = 'USD'

// ─── Reading DO's answers ────────────────────────────────────────────────
// Each of these takes `unknown` and gives back the app's own shape. A field DO
// stops sending arrives here as undefined and is defaulted; a caller never sees
// a half-built row, because a picker rendering `undefined vCPU` is worse than a
// picker missing a size.

type Row = Record<string, unknown>

const rows = (body: unknown, key: string): Row[] => {
  const list = (body as Row | null)?.[key]
  return Array.isArray(list) ? list as Row[] : []
}

const str = (v: unknown): string   => typeof v === 'string' ? v : ''
const num = (v: unknown): number   => typeof v === 'number' && Number.isFinite(v) ? v : 0

function toRegion(r: Row): ComputeRegion {
  return { slug: str(r.slug), label: str(r.name) || str(r.slug), available: r.available !== false }
}

function toSize(s: Row): ComputeSize {
  // `* 10 ** minorUnits(...)` and not `* 100`: the exponent is the currency's.
  const dollars = num(s.price_monthly)
  return {
    slug:       str(s.slug),
    label:      str(s.description) || str(s.slug),
    vcpu:       num(s.vcpus),
    memoryMb:   num(s.memory),
    diskGb:     num(s.disk),
    priceMinor: roundMinor(dollars * 10 ** minorUnits(CURRENCY)),
    currency:   CURRENCY,
    regions:    Array.isArray(s.regions) ? (s.regions as unknown[]).map(str).filter(Boolean) : [],
  }
}

function toImage(i: Row): ComputeImage {
  const name = [str(i.distribution), str(i.name)].filter(Boolean).join(' ')
  return { slug: str(i.slug), label: name || str(i.slug) }
}

/**
 * DO's four words, in this app's vocabulary.
 *
 * `new` is a droplet that has been created and is still coming up, which is
 * `starting` here; `archive` is one on its way out. A word not in this table is
 * `unknown` rather than a guess — the caller records it and moves nothing,
 * which is the difference between *we have not seen this* and *it is off*.
 */
const STATES: Record<string, MachineState> = {
  new:     'starting',
  active:  'running',
  off:     'off',
  archive: 'deleting',
}

/** The public v4 address, or null. A droplet that is still building has an
 *  empty `networks`, which is a stage rather than an error. */
function publicIp(droplet: Row): string | null {
  const v4 = (droplet.networks as Row | undefined)?.v4
  if (!Array.isArray(v4)) return null
  const pub = (v4 as Row[]).find(n => str(n.type) === 'public')
  return pub ? str(pub.ip_address) || null : null
}

// ─── The connector ───────────────────────────────────────────────────────

export const digitalOcean: ComputeConnector = {
  kind:  'digitalocean',
  label: 'DigitalOcean',

  // A getter, not a value: a module-level read is captured at import and a test
  // that points this at a stand-in after the first import would be talking to
  // the real DigitalOcean.
  get address() { return env.DIGITALOCEAN_URL || DO_API },

  descriptor({ accountId, ref, address }): TargetDescriptor {
    return {
      id:            `provider:digitalocean:${accountId}`,
      kind:          'provider',
      protocol:      'http',
      address:       address || digitalOcean.address,
      // Bearer, because that is what DO issues. `encoding` is left at the
      // default: DO takes JSON, where Stripe is the connector that needed
      // conduit to grow `form`.
      auth:          { type: 'bearer', ref },
      registered_at: Date.now(),
      last_seen_at:  null,
    } as TargetDescriptor
  },

  async catalog(send): Promise<ComputeCatalog> {
    // Three calls, not one — DO has no combined endpoint, and asking in
    // parallel is the difference between a wizard step that opens and one that
    // waits three round trips.
    const [regions, sizes, images] = await Promise.all([
      send({ method: 'GET', path: `/v2/regions?per_page=${PER_PAGE}` }),
      send({ method: 'GET', path: `/v2/sizes?per_page=${PER_PAGE}` }),
      send({ method: 'GET', path: `/v2/images?type=distribution&per_page=${PER_PAGE}` }),
    ])

    const failed = [regions, sizes, images].find(r => r.error)
    if (failed?.error)
      throw new Error(`DigitalOcean: ${failed.error.kind}${failed.error.message ? ` — ${failed.error.message}` : ''}`)

    return {
      regions: rows(regions.data, 'regions').map(toRegion).filter(r => r.slug),
      sizes:   rows(sizes.data,   'sizes'  ).map(toSize  ).filter(s => s.slug),
      images:  rows(images.data,  'images' ).map(toImage ).filter(i => i.slug),
    }
  },

  async machine(send, providerServerId): Promise<ComputeMachine | null> {
    const res = await send({ method: 'GET', path: `/v2/droplets/${encodeURIComponent(providerServerId)}` })

    // A machine the vendor no longer has is an ANSWER — the shop destroyed it,
    // or somebody did it in their console — so it is null rather than a throw.
    // Any other failure is not knowing, which must not read as *it is gone*.
    if (res.error) {
      if (res.error.kind === 'not_found') return null
      throw new Error(`DigitalOcean: ${res.error.kind}`)
    }

    const droplet = (res.data as Row | null)?.droplet as Row | undefined
    if (!droplet) return null

    return {
      providerServerId: String(droplet.id ?? providerServerId),
      status:           STATES[str(droplet.status)] ?? 'unknown',
      ipAddress:        publicIp(droplet),
      region:           str((droplet.region as Row | undefined)?.slug) || null,
    }
  },

  async verify(send): Promise<boolean> {
    // The cheapest authenticated read DO has. It answers the only question
    // Verify asks — does this token open anything — and reads no machine, so a
    // key scoped to nothing still proves it is a key.
    const res = await send({ method: 'GET', path: '/v2/account' })
    return !res.error && Boolean((res.data as Row | null)?.account)
  },
}
