// @frontierjs/conduit-digitalocean — DigitalOcean's dialect over conduit.
//
// Extracted from `packages/basecamp/api/src/providers/compute/digitalocean.ts`.
// The `ComputeConnector` interface, `MachineMark` and the fleet's spelling of
// a tag stay in basecamp; here a create takes `tags: string[]` and a list
// takes `{ tag }`, which is what DO reads.
//
// ─── Money ───────────────────────────────────────────────────────────────
// `price_monthly` is `24.0` — dollars, as a JSON number. It crosses this
// boundary as minor units plus a currency: the divisor belongs to the
// currency, so `* 100` is wrong for the yen by a hundred (`@money`'s rule).

import type { ConduitError, ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { minorUnits, roundMinor } from '@frontierjs/toolbelt/units'

export const DIGITALOCEAN_ADDRESS = 'https://api.digitalocean.com'
/** DO's documented maximum, so a fleet picker gets the whole list in one call. */
export const PER_PAGE = 200
export const CURRENCY = 'USD'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string): Send {
  return req => conduit.send({ target, ...req })
}

/** One target per ACCOUNT, bearer, JSON. */
export function digitaloceanTarget(opts: { accountId: string; ref: string; address?: string }): TargetDescriptor {
  return {
    id: `provider:digitalocean:${opts.accountId}`, kind: 'provider', protocol: 'http',
    address: (opts.address ?? DIGITALOCEAN_ADDRESS).replace(/\/$/, ''),
    auth: { type: 'bearer', ref: opts.ref }, registered_at: Date.now(), last_seen_at: null,
  }
}

// ─── Shapes ──────────────────────────────────────────────────────────────

export interface Region { slug: string; label: string; available: boolean }
export interface Size   { slug: string; label: string; vcpu: number; memoryMb: number; diskGb: number; currency: string; /** region → monthly, minor units */ prices: Record<string, number> }
export interface Image  { slug: string; label: string }
export interface Catalog { regions: Region[]; sizes: Size[]; images: Image[] }
export type MachineState = 'running' | 'starting' | 'stopping' | 'off' | 'rebuilding' | 'deleting' | 'unknown'
export interface Machine { providerServerId: string; name: string | null; size: string | null; status: MachineState; ipAddress: string | null; region: string | null; tags: string[] }
export interface MachineSpec { name: string; region: string; size: string; image: string; userData: string; tags: string[] }

/** `indeterminate` is a create DO accepted without naming the machine: it may exist, and only the tag finds it. */
export type DoFailureKind = 'gone' | 'refused' | 'indeterminate' | ConduitError['kind']
export interface DoFailure { kind: DoFailureKind; id?: string; message: string; retryable: boolean; retryAfterMs?: number; /** `RateLimit-Reset`, unix seconds, where sent */ rateLimitReset?: number
  /** The request left and its outcome is unknown — a lost create reads `timeout` and this is what says the machine may exist. */
  indeterminate?: boolean }
export class DigitalOceanError extends Error { constructor(public failure: DoFailure) { super(`DigitalOcean: ${failure.kind}${failure.id ? ` (${failure.id})` : ''} — ${failure.message}`) } }

type Row = Record<string, unknown>
const rows = (body: unknown, key: string): Row[] => { const l = (body as Row | null)?.[key]; return Array.isArray(l) ? l as Row[] : [] }
const str = (v: unknown) => typeof v === 'string' ? v : ''
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0

/** DO's `{ id, message }` error body, read for the sentence and the id. */
export function translate(error: ConduitError, status?: number, headers?: Record<string, string>): DoFailure {
  let body: { id?: string; message?: string } | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as typeof body) } catch { /* not JSON */ }
  const base: DoFailure = { kind: error.kind, message: body?.message ?? error.message, retryable: error.retryable,
    ...(error.indeterminate ? { indeterminate: true } : {}), ...(body?.id ? { id: body.id } : {}), ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(headers?.['ratelimit-reset'] ? { rateLimitReset: Number(headers['ratelimit-reset']) } : {}) }
  // The test is the STATUS: conduit answers every 4xx as `client_error` on
  // purpose, so `kind` cannot tell a deleted droplet from a malformed request.
  if (status === 404) return { ...base, kind: 'gone', retryable: false }
  if (error.kind === 'client_error') return { ...base, kind: 'refused', retryable: false }
  return base
}

const fail = (r: { error: ConduitError; meta: { status?: number; headers?: Record<string, string> } }): never => { throw new DigitalOceanError(translate(r.error, r.meta.status, r.meta.headers)) }

export const STATES: Record<string, MachineState> = { new: 'starting', active: 'running', off: 'off', archive: 'deleting' }

export function toSize(s: Row): Size {
  const minor = roundMinor(num(s.price_monthly) * 10 ** minorUnits(CURRENCY))
  const regions = Array.isArray(s.regions) ? (s.regions as unknown[]).map(str).filter(Boolean) : []
  return { slug: str(s.slug), label: str(s.description) || str(s.slug), vcpu: num(s.vcpus), memoryMb: num(s.memory), diskGb: num(s.disk), currency: CURRENCY,
    // DO states one price and the regions that have it; the map is what makes this and Hetzner's per-location pricing one shape.
    prices: Object.fromEntries(regions.map(r => [r, minor])) }
}
const toRegion = (r: Row): Region => ({ slug: str(r.slug), label: str(r.name) || str(r.slug), available: r.available !== false })
const toImage  = (i: Row): Image  => ({ slug: str(i.slug), label: [str(i.distribution), str(i.name)].filter(Boolean).join(' ') || str(i.slug) })
function publicIp(d: Row): string | null { const v4 = (d.networks as Row | undefined)?.v4; if (!Array.isArray(v4)) return null; const p = (v4 as Row[]).find(n => str(n.type) === 'public'); return p ? str(p.ip_address) || null : null }
const toMachine = (d: Row, fallback = ''): Machine => ({ providerServerId: String(d.id ?? fallback), name: str(d.name) || null, size: str(d.size_slug) || null, status: STATES[str(d.status)] ?? 'unknown', ipAddress: publicIp(d), region: str((d.region as Row | undefined)?.slug) || null, tags: Array.isArray(d.tags) ? (d.tags as unknown[]).map(str) : [] })

export async function catalog(send: Send): Promise<Catalog> {
  const [regions, sizes, images] = await Promise.all([
    send<Row>({ method: 'GET', path: `/v2/regions?per_page=${PER_PAGE}` }),
    send<Row>({ method: 'GET', path: `/v2/sizes?per_page=${PER_PAGE}` }),
    send<Row>({ method: 'GET', path: `/v2/images?type=distribution&per_page=${PER_PAGE}` }),
  ])
  for (const r of [regions, sizes, images]) if (r.error) fail(r as never)
  return { regions: rows(regions.data, 'regions').map(toRegion).filter(r => r.slug), sizes: rows(sizes.data, 'sizes').map(toSize).filter(s => s.slug), images: rows(images.data, 'images').map(toImage).filter(i => i.slug) }
}

/** One machine, or null where the vendor says it is GONE. Any other failure
 *  throws: not knowing must never read as *it is gone*. */
export async function machine(send: Send, providerServerId: string): Promise<Machine | null> {
  const r = await send<Row>({ method: 'GET', path: `/v2/droplets/${encodeURIComponent(providerServerId)}` })
  if (r.error) { if (r.meta.status === 404) return null; fail(r as never) }
  const d = (r.data as Row | null)?.droplet as Row | undefined
  return d ? toMachine(d, providerServerId) : null
}

/** Never keyed: DO ignores `Idempotency-Key`, so a lost response is
 *  `indeterminate` and the tag is the way back to a machine nobody recorded. */
export async function create(send: Send, spec: MachineSpec): Promise<{ providerServerId: string }> {
  const r = await send<Row>({ method: 'POST', path: '/v2/droplets', body: { name: spec.name, region: spec.region, size: spec.size, image: spec.image, user_data: spec.userData, tags: spec.tags, monitoring: true } })
  if (r.error) fail(r as never)
  const d = (r.data as Row | null)?.droplet as Row | undefined
  if (!d?.id) throw new DigitalOceanError({ kind: 'indeterminate', indeterminate: true, message: 'accepted the create and answered no droplet id — the machine may exist; reconcile by tag', retryable: false })
  return { providerServerId: String(d.id) }
}

/** True when the vendor accepted the instruction OR has never heard of the id. */
export async function destroy(send: Send, providerServerId: string): Promise<boolean> {
  const r = await send<null>({ method: 'DELETE', path: `/v2/droplets/${encodeURIComponent(providerServerId)}` })
  if (r.meta.status === 404) return true
  if (r.error) fail(r as never)
  return true
}

export async function list(send: Send, opts: { tag?: string } = {}): Promise<Machine[]> {
  const r = await send<Row>({ method: 'GET', path: `/v2/droplets?per_page=${PER_PAGE}${opts.tag ? `&tag_name=${encodeURIComponent(opts.tag)}` : ''}` })
  if (r.error) fail(r as never)
  return rows(r.data, 'droplets').map(d => toMachine(d)).filter(m => m.providerServerId)
}

export async function verify(send: Send): Promise<boolean> {
  const r = await send<Row>({ method: 'GET', path: '/v2/account' })
  return !r.error && Boolean((r.data as Row | null)?.account)
}
