// @frontierjs/conduit-esri — one raster tile of aerial imagery over conduit.
//
// Two sources, one verb. Esri World Imagery is keyed per account (the key
// travels as the `token` URL parameter, which conduit puts on the fetched URL
// and nowhere a caller or log is handed); USGS NAIP is keyless and public
// domain. Which one a request uses is the app route's policy: a missing
// account key answers `no_key`, and the route's fallback to NAIP is its own.
//
// The caller of `esriTile`/`naipTile` is a public tile route, so z, x and y
// are checked as integers in range BEFORE anything is sent, and the upstream
// host and path are fixed here. A caller-supplied value never shapes either.

import type { ConduitError, ConduitRequest, ConduitResult, CredentialCaller, TargetDescriptor } from '@frontierjs/conduit'

export const ESRI_TARGET  = 'provider:esri-imagery'
export const NAIP_TARGET  = 'provider:naip'
export const ESRI_ADDRESS = 'https://ibasemaps-api.arcgis.com'
export const NAIP_ADDRESS = 'https://basemap.nationalmap.gov'
/** The World Imagery cache is defined to level 23 but holds imagery to 19. */
export const ESRI_MAX_ZOOM = 19
/** USGSImageryOnly's cache stops at level 16 (1:9,028); 17 and above are 404. */
export const NAIP_MAX_ZOOM = 16

export type Source = 'esri' | 'naip'

const TILE_PATH: Record<Source, string> = {
  esri: '/arcgis/rest/services/World_Imagery/MapServer/tile',
  naip: '/arcgis/rest/services/USGSImageryOnly/MapServer/tile',
}
const MAX_ZOOM: Record<Source, number> = { esri: ESRI_MAX_ZOOM, naip: NAIP_MAX_ZOOM }

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindSend(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: string): Send {
  return req => conduit.send({ target, ...req })
}

// `address` exists for a sink; the vendor hosts are the defaults and the only
// ones the connector names.
export function esriImageryTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id: opts.id ?? ESRI_TARGET, kind: 'provider', protocol: 'http',
    address: (opts.address ?? ESRI_ADDRESS).replace(/\/$/, ''),
    // The key belongs to the account the tile is served for, so the resolver is asked getFor(ref, who).
    auth: { type: 'api_key', ref: opts.ref ?? 'ESRI_API_KEY', query: 'token', per_caller: true },
    registered_at: Date.now(), last_seen_at: null,
  }
}

export function naipTarget(opts: { address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id: opts.id ?? NAIP_TARGET, kind: 'provider', protocol: 'http',
    address: (opts.address ?? NAIP_ADDRESS).replace(/\/$/, ''),
    auth: { type: 'none' }, registered_at: Date.now(), last_seen_at: null,
  }
}

// ─── Basemap descriptors ───────────────────────────────────────────────────

/** The shape `@frontierjs/map-kit` reads, as plain data. */
export interface Basemap { tiles: string; attribution: string; maxZoom: number; tileSize: number }

export const ATTRIBUTION: Record<Source, string> = {
  esri: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community',
  naip: 'USDA, USGS The National Map: Orthoimagery',
}

/** `tiles` is the app's own proxy template (`/api/tiles/{z}/{x}/{y}`), never a vendor URL. */
export function basemap(source: Source, tiles: string): Basemap {
  return { tiles, attribution: ATTRIBUTION[source], maxZoom: MAX_ZOOM[source], tileSize: 256 }
}

// ─── Failures ──────────────────────────────────────────────────────────────

export type TileFailureKind =
  | 'refused'       // z, x or y is not a tile of this source; nothing was sent
  | 'no_key'        // no key for this account; nothing was sent. The route's cue to fall back to NAIP
  | 'bad_key'       // the vendor refused the key (401/403, or Esri's 498/499 under a 200)
  | 'no_tile'       // the vendor has no such tile (404)
  | 'not_an_image'  // a 2xx whose body is not a tile
  | ConduitError['kind']
export interface TileFailure { kind: TileFailureKind; message: string; retryable: boolean; status?: number; retryAfterMs?: number }

export interface Tile { bytes: Uint8Array; contentType: string; cacheControl?: string; etag?: string }

// The error carries the target and ref by name and never the key (FJS-D940); `raw`
// is not forwarded, so a vendor body that echoed a URL could not carry one out either.
export function translate(error: ConduitError, status?: number): TileFailure {
  const base: TileFailure = { kind: error.kind, message: error.message, retryable: error.retryable,
    ...(status !== undefined ? { status } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (error.kind === 'auth_failed') {
    // Nothing left the process: the resolver had no key for this caller.
    if (status === undefined || status === 0) return { ...base, kind: 'no_key', message: 'no Esri key for this account', retryable: false }
    return { ...base, kind: 'bad_key', message: 'Esri refused the key', retryable: false }
  }
  if (error.kind === 'client_error') {
    if (status === 404) return { ...base, kind: 'no_tile', message: 'no such tile', retryable: false }
    return { ...base, retryable: false }
  }
  return base
}

// ─── The call ──────────────────────────────────────────────────────────────

const IMAGE = /^image\/(png|jpe?g|webp)$/

function refuse(source: Source, z: unknown, x: unknown, y: unknown): TileFailure | null {
  const max = MAX_ZOOM[source]
  const bad = (m: string): TileFailure => ({ kind: 'refused', message: m, retryable: false })
  if (typeof z !== 'number' || !Number.isInteger(z) || z < 0 || z > max) return bad(`z must be an integer from 0 to ${max}`)
  const n = 2 ** z
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x >= n) return bad(`x must be an integer from 0 to ${n - 1} at z ${z}`)
  if (typeof y !== 'number' || !Number.isInteger(y) || y < 0 || y >= n) return bad(`y must be an integer from 0 to ${n - 1} at z ${z}`)
  return null
}

async function fetchTile(send: Send, source: Source, c: { z: number; x: number; y: number }, who?: CredentialCaller): Promise<{ tile?: Tile; error?: TileFailure }> {
  const refused = refuse(source, c.z, c.x, c.y)
  if (refused) return { error: refused }
  // Esri's path order is z/y/x; every segment is a checked integer.
  const r = await send<unknown>({
    method: 'GET', path: `${TILE_PATH[source]}/${c.z}/${c.y}/${c.x}`, replayable: true,
    ...(who ? { who } : {}),
  })
  if (r.error) return { error: translate(r.error, r.meta?.status) }

  const type = (r.meta?.headers?.['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (r.data instanceof Uint8Array && r.data.byteLength > 0 && IMAGE.test(type)) {
    const h = r.meta?.headers ?? {}
    return { tile: { bytes: r.data, contentType: type, ...(h['cache-control'] ? { cacheControl: h['cache-control'] } : {}), ...(h.etag ? { etag: h.etag } : {}) } }
  }
  // Esri answers a refused key as JSON under a 200: { error: { code: 498 | 499 } }.
  const code = (r.data as { error?: { code?: unknown } } | null)?.error?.code
  if (typeof code === 'number') {
    const keyRefused = code === 498 || code === 499 || code === 403
    return { error: { kind: keyRefused ? 'bad_key' : 'refused', message: keyRefused ? 'Esri refused the key' : `Esri answered error ${code}`, retryable: false, status: r.meta?.status } }
  }
  return { error: { kind: 'not_an_image', message: `expected an image tile, got ${type || 'no content-type'}`, retryable: false, status: r.meta?.status } }
}

/** Esri World Imagery. `who` only where the caller is not junction's plugin, which writes it. */
export const esriTile = (send: Send, c: { z: number; x: number; y: number }, opts: { who?: CredentialCaller } = {}) => fetchTile(send, 'esri', c, opts.who)
/** USGS NAIP, no key. */
export const naipTile = (send: Send, c: { z: number; x: number; y: number }) => fetchTile(send, 'naip', c)
