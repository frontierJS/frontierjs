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
import { FLEET, keyBody }         from './index.ts'
import type {
  ComputeConnector, ComputeCatalog, ComputeMachine, MachineState,
  ComputeRegion, ComputeSize, ComputeImage, MachineSpec, MachineMark, ReservedIp, ReservedIps,
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
  const minor   = roundMinor(dollars * 10 ** minorUnits(CURRENCY))
  const regions = Array.isArray(s.regions) ? (s.regions as unknown[]).map(str).filter(Boolean) : []

  return {
    slug:     str(s.slug),
    label:    str(s.description) || str(s.slug),
    vcpu:     num(s.vcpus),
    memoryMb: num(s.memory),
    diskGb:   num(s.disk),
    currency: CURRENCY,
    // DO sells no Arm droplet.
    arch:     'x86',
    // DO states one price and a list of regions that have the size, so every
    // entry here is the same number. Filling the map rather than carrying the
    // flat price is what makes this and Hetzner's per-location pricing one
    // shape — and the keys are the availability list either way.
    prices:   Object.fromEntries(regions.map(r => [r, minor])),
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

// ─── DO's spelling of a mark ─────────────────────────────────────────────
// Flat tag strings, which is what DO takes. The colon is legal here and is not
// at Hetzner, which is why the caller states a mark and this file states the
// spelling.

const identityTag = (mark: MachineMark) => `${mark.fleet}:server:${mark.serverId}`
const hostTag     = (fleet: string) => `${fleet}:host`

/** What a create applies. The fleet tag always, since a sweep selects on it
 *  and a lookup on the narrower one, and DO's filter is a single exact value. */
const markTags = (mark: MachineMark): string[] => [
  mark.fleet,
  ...(mark.serverId ? [identityTag(mark)] : []),
  ...(mark.basecampHost ? [hostTag(mark.fleet)] : []),
]

/** Which single tag answers this mark. */
const selectorTag = (mark: MachineMark): string =>
  mark.serverId ? identityTag(mark) : mark.basecampHost ? hostTag(mark.fleet) : mark.fleet

const tagsOf = (droplet: Row): string[] =>
  Array.isArray(droplet.tags) ? (droplet.tags as unknown[]).map(str) : []

/** The `Server` a droplet says it is, read back off its tags. Null where
 *  nothing marked it — a droplet somebody made in their own console. */
function markedServer(droplet: Row): string | null {
  const prefix = `${FLEET}:server:`
  const hit    = tagsOf(droplet).find(t => t.startsWith(prefix))
  return hit ? hit.slice(prefix.length) || null : null
}

/** The public v4 address, or null. A droplet that is still building has an
 *  empty `networks`, which is a stage rather than an error. */
function publicIp(droplet: Row): string | null {
  const v4 = (droplet.networks as Row | undefined)?.v4
  if (!Array.isArray(v4)) return null
  const pub = (v4 as Row[]).find(n => str(n.type) === 'public')
  return pub ? str(pub.ip_address) || null : null
}

/** A refusal as a sentence: the kind, the status, and the vendor's own reason.
 *  DO's envelope is `{ id, message }`, read off `data` because conduit fills
 *  `error.message` with the status line on a 4xx. */
const said = (res: { error?: { kind: string; message?: string }; status?: number; data?: unknown }) => {
  const reason = str((res.data as Row | null)?.message) || res.error?.message
  return `${res.error?.kind ?? 'error'}`
    + (res.status ? ` (HTTP ${res.status})` : '')
    + (reason ? ` — ${reason}` : '')
}

// ─── Reserved IPs ────────────────────────────────────────────────────────
// An address beside the droplet on an anchor, attached after boot, and $5 a
// month while no droplet holds it.

function toReserved(r: Row): ReservedIp {
  const droplet = r.droplet as Row | null | undefined
  const ip      = str(r.ip)
  return {
    id:        ip,
    ip,
    region:    str((r.region as Row | undefined)?.slug),
    machineId: droplet?.id == null ? null : String(droplet.id),
  }
}

/**
 * Cloud-init that sends the box's outbound traffic out its reserved IP, so an
 * allowlist at a mail relay or a third-party API names the address that
 * outlives the box rather than the droplet's own.
 *
 * Read from metadata every 30 seconds rather than written into netplan: the
 * address is assigned after boot, it can be moved or released, and a default
 * route through the anchor gateway with no reserved IP behind it is a box that
 * cannot reach apt, its certificate authority or Basecamp. The two source rules
 * keep a reply leaving by the gateway its request came in on, so ssh to the
 * droplet's own address still answers once the default has moved.
 */
const RESERVED_EGRESS = `#!/bin/sh
cat > /usr/local/sbin/reserved-egress <<'SH'
#!/bin/sh
md=http://169.254.169.254/metadata/v1
get() { curl -sf --max-time 2 "$md/$1"; }
pub=$(get interfaces/public/0/ipv4/address) || exit 0
pubgw=$(get interfaces/public/0/ipv4/gateway) || exit 0
ip route replace default via "$pubgw" dev eth0 table 100
ip rule show | grep -q "from $pub lookup 100" || ip rule add from "$pub" lookup 100 priority 100
gw=$pubgw src=$pub
anchor=$(get interfaces/public/0/anchor_ipv4/address) && anchorgw=$(get interfaces/public/0/anchor_ipv4/gateway) && {
  ip route replace default via "$anchorgw" dev eth0 table 101
  ip rule show | grep -q "from $anchor lookup 101" || ip rule add from "$anchor" lookup 101 priority 101
  [ "$(get reserved_ip/ipv4/active)" = true ] && gw=$anchorgw src=$anchor
}
ip route replace default via "$gw" dev eth0 src "$src"
SH
chmod 755 /usr/local/sbin/reserved-egress
cat > /etc/systemd/system/reserved-egress.service <<'UNIT'
[Unit]
Description=Route outbound traffic out the reserved IP while one is assigned
After=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/reserved-egress
UNIT
cat > /etc/systemd/system/reserved-egress.timer <<'UNIT'
[Timer]
OnBootSec=5
OnUnitActiveSec=30
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now reserved-egress.timer
`

const reservedIps: ReservedIps = {
  async list(send) {
    const res = await send({ method: 'GET', path: `/v2/reserved_ips?per_page=${PER_PAGE}` })
    if (res.error) throw new Error(`DigitalOcean: ${said(res)}`)
    return rows(res.data, 'reserved_ips').map(toReserved).filter(r => r.ip)
  },

  async get(send, ip) {
    const res = await send({ method: 'GET', path: `/v2/reserved_ips/${encodeURIComponent(ip)}` })
    if (res.status === 404) return null
    if (res.error) throw new Error(`DigitalOcean: ${said(res)}`)
    const row = (res.data as Row | null)?.reserved_ip as Row | undefined
    return row ? toReserved(row) : null
  },

  async reserve(send, region) {
    const res = await send({ method: 'POST', path: '/v2/reserved_ips', body: { region } })
    if (res.error) throw new Error(`DigitalOcean refused the reserved IP: ${said(res)}`)
    const row = (res.data as Row | null)?.reserved_ip as Row | undefined
    if (!row || !str(row.ip)) throw new Error('DigitalOcean reserved an IP and answered no address')
    return toReserved(row)
  },

  async assign(send, held, machineId) {
    const res = await send({
      method: 'POST', path: `/v2/reserved_ips/${encodeURIComponent(held.ip)}/actions`,
      body:   { type: 'assign', droplet_id: Number(machineId) },
    })
    if (res.error) throw new Error(`DigitalOcean refused to assign ${held.ip}: ${said(res)}`)
  },

  async release(send, held) {
    const res = await send({ method: 'DELETE', path: `/v2/reserved_ips/${encodeURIComponent(held.ip)}` })
    if (res.status === 404) return
    if (res.error) throw new Error(`DigitalOcean: ${said(res)}`)
  },

  egress: RESERVED_EGRESS,
}

// ─── The connector ───────────────────────────────────────────────────────

export const digitalOcean: ComputeConnector = {
  kind:  'digitalocean',
  label: 'DigitalOcean',

  // A getter, not a value: a module-level read is captured at import and a test
  // that points this at a stand-in after the first import would be talking to
  // the real DigitalOcean.
  get address() { return env.DIGITALOCEAN_URL || DO_API },

  defaults: { region: 'nyc3', image: 'ubuntu-24-04-x64' },
  reservedIps,

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
    if (failed?.error) throw new Error(`DigitalOcean: ${said(failed)}`)

    return {
      regions: rows(regions.data, 'regions').map(toRegion).filter(r => r.slug),
      sizes:   rows(sizes.data,   'sizes'  ).map(toSize  ).filter(s => s.slug),
      images:  rows(images.data,  'images' ).map(toImage ).filter(i => i.slug),
    }
  },

  async machine(send, providerServerId): Promise<ComputeMachine | null> {
    const res = await send({ method: 'GET', path: `/v2/droplets/${encodeURIComponent(providerServerId)}` })

    // A machine the vendor no longer has is an ANSWER — somebody destroyed it
    // here or in their own console — so it is null rather than a throw. Any
    // other failure is NOT KNOWING, which must never read as *it is gone*: the
    // caller turns a null into a `reportDestroyed` move.
    //
    // The test is the STATUS and not the kind. Conduit answers every 4xx as
    // `client_error` on purpose — none of them is retryable and none says the
    // target is unwell — so `kind` cannot tell a deleted droplet from a
    // malformed request, and reading `not_found` off it silently never matched
    // anything at all.
    if (res.error) {
      if (res.status === 404) return null
      throw new Error(`DigitalOcean: ${said(res)}`)
    }

    const droplet = (res.data as Row | null)?.droplet as Row | undefined
    if (!droplet) return null

    return {
      providerServerId: String(droplet.id ?? providerServerId),
      status:           STATES[str(droplet.status)] ?? 'unknown',
      ipAddress:        publicIp(droplet),
      region:           str((droplet.region as Row | undefined)?.slug) || null,
      name:             str(droplet.name) || null,
      serverId:         markedServer(droplet),
      basecampHost:     tagsOf(droplet).includes(hostTag(FLEET)),
      createdAt:        str(droplet.created_at) || null,
    }
  },

  async create(send, spec: MachineSpec): Promise<{ providerServerId: string }> {
    // DO's create is a single POST and it answers the droplet already, with an
    // id and a status of `new`. `user_data` is cloud-init and is what installs
    // the Outpost — the machine reaches this app on its own afterwards, so
    // nothing here opens an SSH connection (`FJS-D241`).
    const res = await send({ method: 'POST', path: '/v2/droplets', body: {
      name:      spec.name,
      region:    spec.region,
      size:      spec.size,
      image:     spec.image,
      user_data: spec.userData,
      ssh_keys:  spec.sshKeys,
      tags:      markTags(spec.mark),
      // Private networking is on by default at DO now and the flag is
      // deprecated; monitoring is free and is what `Server.health` would
      // otherwise have to infer.
      monitoring: true,
    }})

    if (res.error) throw new Error(`DigitalOcean refused the create: ${said(res)}`)

    const id = (res.data as Row | null)?.droplet as Row | undefined
    // A 2xx with no id is the worst answer this call can give: the machine may
    // exist and nothing here can name it. Loud, because the tag is then the
    // only way back to it.
    if (!id?.id)
      throw new Error('DigitalOcean accepted the create and answered no droplet id — '
        + 'the machine may exist; reconcile by tag')

    return { providerServerId: String(id.id) }
  },

  async sshKey(send, key): Promise<string> {
    // The FINGERPRINT is the handle, not the numeric id: a create's `ssh_keys`
    // reads a string as a fingerprint, so an id passed as a string names no key.
    const listed = await send({ method: 'GET', path: `/v2/account/keys?per_page=${PER_PAGE}` })
    if (listed.error) throw new Error(`DigitalOcean: ${said(listed)}`)

    const want = keyBody(key.publicKey)
    const have = rows(listed.data, 'ssh_keys').find(k => keyBody(str(k.public_key)) === want)
    if (have) return str(have.fingerprint)

    const made = await send({ method: 'POST', path: '/v2/account/keys', body: {
      name: key.name, public_key: key.publicKey.trim(),
    }})
    if (made.error) throw new Error(`DigitalOcean refused the SSH key: ${said(made)}`)
    const fingerprint = str(((made.data as Row | null)?.ssh_key as Row | undefined)?.fingerprint)
    if (!fingerprint) throw new Error('DigitalOcean accepted the SSH key and answered no fingerprint')
    return fingerprint
  },

  async destroy(send, providerServerId): Promise<boolean> {
    const res = await send({
      method: 'DELETE', path: `/v2/droplets/${encodeURIComponent(providerServerId)}`,
    })

    // A machine the vendor has never heard of is DESTROYED for our purposes.
    // Not an error: a destroy that cannot be run twice is one that cannot be
    // retried, and every path into this one is a job that may be redelivered.
    if (res.status === 404) return true
    if (res.error) throw new Error(`DigitalOcean: ${said(res)}`)
    return true
  },

  async powerOff(send, providerServerId): Promise<boolean> {
    const res = await send({
      method: 'POST', path: `/v2/droplets/${encodeURIComponent(providerServerId)}/actions`,
      body:   { type: 'power_off' },
    })
    if (res.status === 404) return false
    if (res.error) throw new Error(`DigitalOcean: ${said(res)}`)
    return true
  },

  async marked(send, mark): Promise<ComputeMachine[]> {
    const res = await send({
      method: 'GET',
      path:   `/v2/droplets?tag_name=${encodeURIComponent(selectorTag(mark))}&per_page=${PER_PAGE}`,
    })
    if (res.error) throw new Error(`DigitalOcean: ${said(res)}`)

    return rows(res.data, 'droplets').map(d => ({
      providerServerId: String(d.id ?? ''),
      status:           STATES[str(d.status)] ?? 'unknown',
      ipAddress:        publicIp(d),
      region:           str((d.region as Row | undefined)?.slug) || null,
      name:             str(d.name) || null,
      serverId:         markedServer(d),
      basecampHost:     tagsOf(d).includes(hostTag(FLEET)),
      createdAt:        str(d.created_at) || null,
    })).filter(m => m.providerServerId)
  },

  async addMark(send, providerServerId, mark): Promise<void> {
    // A droplet create makes the tags it names; tagging one that exists does
    // not, and DO answers a tag it has never seen with a 404.
    for (const name of markTags(mark)) {
      const made = await send({ method: 'POST', path: '/v2/tags', body: { name } })
      if (made.error && made.status !== 422) throw new Error(`DigitalOcean: ${said(made)}`)
      const res = await send({
        method: 'POST', path: `/v2/tags/${encodeURIComponent(name)}/resources`,
        body:   { resources: [{ resource_id: String(providerServerId), resource_type: 'droplet' }] },
      })
      if (res.error) throw new Error(`DigitalOcean: ${said(res)}`)
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
