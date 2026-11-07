// @frontierjs/conduit-hetzner — Hetzner Cloud's dialect over conduit.
//
// Extracted from `packages/basecamp/api/src/providers/compute/hetzner.ts`.
// The second compute dialect, and what it disagreed with DigitalOcean on
// reached the shared shape: a price is per LOCATION, so `prices` is a map; a
// machine is marked with LABELS, a map whose keys are DNS labels (no colon);
// memory is gigabytes as a float; nine state words. A create takes `labels`
// and a list takes `{ labelSelector }`, which is Hetzner's own grammar.
//
// ─── Money ───────────────────────────────────────────────────────────────
// A price is a decimal STRING, twice — `net` and `gross`. `gross` is what the
// account is billed, computed with ITS VAT rate, so it is the number on the
// invoice. EUR, the first currency here that is not USD.

import type { ConduitError, ConduitRequest, ConduitResult, TargetDescriptor } from '@frontierjs/conduit'
import { minorUnits, roundMinor } from '@frontierjs/toolbelt/units'

export const HETZNER_ADDRESS = 'https://api.hetzner.cloud'
/** Hetzner's maximum, a quarter of DO's. A larger value is accepted and clamped in silence. */
export const PER_PAGE = 50
export const CURRENCY = 'EUR'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string): Send {
  return req => conduit.send({ target, ...req })
}

export function hetznerTarget(opts: { accountId: string; ref: string; address?: string }): TargetDescriptor {
  return {
    id: `provider:hetzner:${opts.accountId}`, kind: 'provider', protocol: 'http',
    address: (opts.address ?? HETZNER_ADDRESS).replace(/\/$/, ''),
    auth: { type: 'bearer', ref: opts.ref }, registered_at: Date.now(), last_seen_at: null,
  }
}

export interface Region { slug: string; label: string; available: boolean }
export interface Size   { slug: string; label: string; vcpu: number; memoryMb: number; diskGb: number; currency: string; prices: Record<string, number> }
export interface Image  { slug: string; label: string }
export interface Catalog { regions: Region[]; sizes: Size[]; images: Image[] }
export type MachineState = 'running' | 'starting' | 'stopping' | 'off' | 'rebuilding' | 'deleting' | 'unknown'
export interface Machine { providerServerId: string; name: string | null; size: string | null; status: MachineState; ipAddress: string | null; region: string | null; labels: Record<string, string> }
export interface MachineSpec { name: string; region: string; size: string; image: string; userData: string; labels: Record<string, string> }

/** `indeterminate` is a create Hetzner accepted without naming the server: it may exist, and only the label finds it. */
export type HzFailureKind = 'gone' | 'refused' | 'capacity' | 'indeterminate' | ConduitError['kind']
export interface HzFailure { kind: HzFailureKind; code?: string; message: string; retryable: boolean; retryAfterMs?: number; rateLimitReset?: number
  /** The request left and its outcome is unknown — a lost create reads `timeout` and this is what says the server may exist. */
  indeterminate?: boolean }
export class HetznerError extends Error { constructor(public failure: HzFailure) { super(`Hetzner: ${failure.kind}${failure.code ? ` (${failure.code})` : ''} — ${failure.message}`) } }

type Row = Record<string, unknown>
const rows = (body: unknown, key: string): Row[] => { const l = (body as Row | null)?.[key]; return Array.isArray(l) ? l as Row[] : [] }
const str = (v: unknown) => typeof v === 'string' ? v : ''
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : 0

/** Hetzner's `{ error: { code, message } }`, which is not DO's `{ id, message }`. */
export function translate(error: ConduitError, status?: number, headers?: Record<string, string>): HzFailure {
  let body: { error?: { code?: string; message?: string } } | null = null
  try { body = typeof error.raw === 'string' ? JSON.parse(error.raw) : (error.raw as typeof body) } catch { /* not JSON */ }
  const e = body?.error
  const base: HzFailure = { kind: error.kind, message: e?.message ?? error.message, retryable: error.retryable,
    ...(error.indeterminate ? { indeterminate: true } : {}), ...(e?.code ? { code: e.code } : {}), ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}),
    ...(headers?.['ratelimit-reset'] ? { rateLimitReset: Number(headers['ratelimit-reset']) } : {}) }
  if (status === 404 || e?.code === 'not_found') return { ...base, kind: 'gone', retryable: false }
  // 423: the account's limit or the location's stock. Not now, but not never.
  if (e?.code === 'resource_limit_exceeded' || e?.code === 'resource_unavailable' || status === 423) return { ...base, kind: 'capacity', retryable: false }
  if (error.kind === 'client_error') return { ...base, kind: 'refused', retryable: false }
  return base
}
const fail = (r: { error: ConduitError; meta: { status?: number; headers?: Record<string, string> } }): never => { throw new HetznerError(translate(r.error, r.meta.status, r.meta.headers)) }

export const STATES: Record<string, MachineState> = { initializing: 'starting', starting: 'starting', running: 'running', stopping: 'stopping', off: 'off', deleting: 'deleting', rebuilding: 'rebuilding', migrating: 'rebuilding', unknown: 'unknown' }

/** `Number('')` is 0 and a size costing nothing would be offered as free, so an
 *  unparseable price is null and the size loses that location. */
export function toMinor(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const n = Number(value)
  return Number.isFinite(n) ? roundMinor(n * 10 ** minorUnits(CURRENCY)) : null
}
export function toSize(t: Row): Size {
  const prices: Record<string, number> = {}
  for (const p of Array.isArray(t.prices) ? t.prices as Row[] : []) { const loc = str(p.location), m = toMinor((p.price_monthly as Row | undefined)?.gross); if (loc && m !== null) prices[loc] = m }
  return { slug: str(t.name), label: str(t.description) || str(t.name), vcpu: num(t.cores), memoryMb: Math.round(num(t.memory) * 1024), diskGb: num(t.disk), currency: CURRENCY, prices }
}
/** `available` is always true: Hetzner has no per-location flag; what is sold where is `Size.prices`'s keys. */
const toRegion = (l: Row): Region => ({ slug: str(l.name), label: str(l.description) || str(l.name), available: true })
const toImage  = (i: Row): Image  => ({ slug: str(i.name), label: str(i.description) || str(i.name) })
const toMachine = (s: Row, fallback = ''): Machine => ({
  providerServerId: String(s.id ?? fallback), name: str(s.name) || null,
  size: str((s.server_type as Row | undefined)?.name) || null, status: STATES[str(s.status)] ?? 'unknown',
  ipAddress: str(((s.public_net as Row | undefined)?.ipv4 as Row | undefined)?.ip) || null,
  region: str(((s.datacenter as Row | undefined)?.location as Row | undefined)?.name) || null,
  labels: (s.labels ?? {}) as Record<string, string>,
})

export async function catalog(send: Send): Promise<Catalog> {
  const [locations, types, images] = await Promise.all([
    send<Row>({ method: 'GET', path: `/v1/locations?per_page=${PER_PAGE}` }),
    send<Row>({ method: 'GET', path: `/v1/server_types?per_page=${PER_PAGE}` }),
    send<Row>({ method: 'GET', path: `/v1/images?type=system&status=available&per_page=${PER_PAGE}` }),
  ])
  for (const r of [locations, types, images]) if (r.error) fail(r as never)
  return { regions: rows(locations.data, 'locations').map(toRegion).filter(r => r.slug),
    // A type with no price anywhere is one nothing can be quoted for.
    sizes: rows(types.data, 'server_types').map(toSize).filter(s => s.slug && Object.keys(s.prices).length),
    images: rows(images.data, 'images').map(toImage).filter(i => i.slug) }
}
export async function machine(send: Send, providerServerId: string): Promise<Machine | null> {
  const r = await send<Row>({ method: 'GET', path: `/v1/servers/${encodeURIComponent(providerServerId)}` })
  if (r.error) { if (r.meta.status === 404) return null; fail(r as never) }
  const s = (r.data as Row | null)?.server as Row | undefined
  return s ? toMachine(s, providerServerId) : null
}
export async function create(send: Send, spec: MachineSpec): Promise<{ providerServerId: string }> {
  for (const key of Object.keys(spec.labels)) if (!/^[a-zA-Z0-9]([-_.a-zA-Z0-9]{0,61}[a-zA-Z0-9])?$/.test(key))
    throw new HetznerError({ kind: 'refused', message: `label key ${JSON.stringify(key)} is not a DNS label; Hetzner refuses it`, retryable: false })
  const r = await send<Row>({ method: 'POST', path: '/v1/servers', body: { name: spec.name, server_type: spec.size, image: spec.image, location: spec.region, user_data: spec.userData, labels: spec.labels, start_after_create: true } })
  if (r.error) fail(r as never)
  const s = (r.data as Row | null)?.server as Row | undefined
  if (!s?.id) throw new HetznerError({ kind: 'indeterminate', indeterminate: true, message: 'accepted the create and answered no server id — the machine may exist; reconcile by label', retryable: false })
  return { providerServerId: String(s.id) }
}
export async function destroy(send: Send, providerServerId: string): Promise<boolean> {
  const r = await send<Row>({ method: 'DELETE', path: `/v1/servers/${encodeURIComponent(providerServerId)}` })
  if (r.meta.status === 404) return true
  if (r.error) fail(r as never)
  return true
}
export async function list(send: Send, opts: { labelSelector?: string } = {}): Promise<Machine[]> {
  const r = await send<Row>({ method: 'GET', path: `/v1/servers?per_page=${PER_PAGE}${opts.labelSelector ? `&label_selector=${encodeURIComponent(opts.labelSelector)}` : ''}` })
  if (r.error) fail(r as never)
  return rows(r.data, 'servers').map(s => toMachine(s)).filter(m => m.providerServerId)
}
/** No account endpoint: a one-row list is the cheapest authenticated read, and an empty account still proves the token. */
export async function verify(send: Send): Promise<boolean> {
  const r = await send<Row>({ method: 'GET', path: '/v1/servers?per_page=1' })
  return !r.error && Array.isArray((r.data as Row | null)?.servers)
}
