// src/maps/static-map.ts — one Maps Static API image, keyed per account.
//
// The caller is a public image route (an app's FJS-D2336 proxy), so every
// number is range-checked BEFORE anything is sent, and the upstream host and
// path are fixed here: a request value never shapes either (Invariant 8).
//
// ─── Its own target, not one of googleMapsTargets ─────────────────────────
// The bundle's key is the process's (`GOOGLE_MAPS_API_KEY`, `get(ref)`). This
// key is the ACCOUNT's: `per_caller`, resolved `getFor(ref, who)` per send. One
// ref answering both ways would hand an account the operator's key when its
// own row is missing, so the two never share a descriptor.
//
// ─── Signing ──────────────────────────────────────────────────────────────
// Google signs the path and query, `key=` included, and takes the signature
// as `&signature=`. So the target is `signed` (FJS-D2354): the account's one
// stored value is `staticMapCredential(key, secret?)`, JSON `{ key, secret? }`,
// and `googleUrlSigner` hands conduit both URL parameters, which conduit sets
// on the fetched URL and scrubs from everything it returns. A key stored with
// no secret goes out unsigned, under the project's unsigned daily quota.
//
// Google answers 403 for a bad signature (digital-signature page). What it
// answers for a bad key is not on a primary source; 403 is assumed.

import type { ConduitError, ConduitRequest, ConduitResult, CredentialCaller, Signer, TargetDescriptor } from '@frontierjs/conduit'
import { RATE_LIMIT_FALLBACK_MS } from './errors.ts'

export const GOOGLE_STATIC_MAP_TARGET  = 'provider:google-maps:static'
export const GOOGLE_STATIC_MAP_ADDRESS = 'https://maps.googleapis.com'
export const GOOGLE_STATIC_MAP_PATH    = '/maps/api/staticmap'
export const GOOGLE_URL_SIGNER         = 'google-maps-url'
/** Per side, before `scale`. 640×640 at scale 2 is a 1280×1280 image. */
export const STATIC_MAP_MAX_SIZE = 640
export const STATIC_MAP_MAX_ZOOM = 21
export const STATIC_MAP_TYPES = ['satellite', 'hybrid', 'roadmap', 'terrain'] as const
export type StaticMapType = typeof STATIC_MAP_TYPES[number]

export type StaticMapSend = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
export function bindStaticMap(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, target: { id: string } = { id: GOOGLE_STATIC_MAP_TARGET }): StaticMapSend {
  return req => conduit.send({ target: target.id, ...req })
}

/** `address` exists for a sink; Google's host is the only one the connector names. */
export function googleStaticMapTarget(opts: { ref?: string; address?: string; id?: string } = {}): TargetDescriptor {
  return {
    id: opts.id ?? GOOGLE_STATIC_MAP_TARGET, kind: 'provider', protocol: 'http',
    address: (opts.address ?? GOOGLE_STATIC_MAP_ADDRESS).replace(/\/$/, ''),
    auth: { type: 'signed', ref: opts.ref ?? 'GOOGLE_STATIC_MAP_CREDENTIAL', signer: GOOGLE_URL_SIGNER, per_caller: true },
    registered_at: Date.now(), last_seen_at: null,
  }
}

// ─── Failures ─────────────────────────────────────────────────────────────

export type StaticMapFailureKind =
  | 'refused'       // a number out of range; nothing was sent
  | 'no_key'        // no key for this account; nothing was sent. The route's cue to try Esri
  | 'bad_key'       // Google refused the key or the signature (403)
  | 'not_an_image'  // a 2xx whose body is not an image
  | ConduitError['kind']
export interface StaticMapFailure { kind: StaticMapFailureKind; message: string; retryable: boolean; status?: number; retryAfterMs?: number }

export interface StaticMapImage { bytes: Uint8Array; contentType: string; cacheControl?: string; etag?: string }

// `raw` is not forwarded: a vendor body that echoed the URL would carry the key out.
export function translateStaticMap(error: ConduitError, status?: number): StaticMapFailure {
  const base: StaticMapFailure = { kind: error.kind, message: error.message, retryable: error.retryable,
    ...(status !== undefined ? { status } : {}),
    ...(error.retry_after_ms !== undefined ? { retryAfterMs: error.retry_after_ms } : {}) }
  if (error.kind === 'auth_failed') {
    // Nothing left the process: the resolver had no key for this caller.
    // Nothing left the process: no credential for this caller, or one the signer could not read.
    if (status === undefined || status === 0) return { ...base, kind: 'no_key', retryable: false }
    return { ...base, kind: 'bad_key', message: 'Google refused the key or its signature', retryable: false }
  }
  if (error.kind === 'rate_limited' && base.retryAfterMs === undefined) return { ...base, retryAfterMs: RATE_LIMIT_FALLBACK_MS }
  if (error.kind === 'client_error') return { ...base, retryable: false }
  return base
}

// ─── The request ──────────────────────────────────────────────────────────

export interface StaticMapRequest {
  center:   { lat: number; lng: number }
  zoom:     number
  width:    number
  height:   number
  scale?:   1 | 2
  maptype?: StaticMapType
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)
const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

export function refuseStaticMap(r: StaticMapRequest): StaticMapFailure | null {
  const bad = (m: string): StaticMapFailure => ({ kind: 'refused', message: m, retryable: false })
  const c = r?.center as { lat?: unknown; lng?: unknown } | undefined
  if (!isNum(c?.lat) || c.lat < -90 || c.lat > 90) return bad('center.lat must be a number from -90 to 90')
  if (!isNum(c?.lng) || c.lng < -180 || c.lng > 180) return bad('center.lng must be a number from -180 to 180')
  if (!isInt(r.zoom) || r.zoom < 0 || r.zoom > STATIC_MAP_MAX_ZOOM) return bad(`zoom must be an integer from 0 to ${STATIC_MAP_MAX_ZOOM}`)
  if (!isInt(r.width) || r.width < 1 || r.width > STATIC_MAP_MAX_SIZE) return bad(`width must be an integer from 1 to ${STATIC_MAP_MAX_SIZE}`)
  if (!isInt(r.height) || r.height < 1 || r.height > STATIC_MAP_MAX_SIZE) return bad(`height must be an integer from 1 to ${STATIC_MAP_MAX_SIZE}`)
  if (r.scale !== undefined && r.scale !== 1 && r.scale !== 2) return bad('scale must be 1 or 2')
  if (r.maptype !== undefined && !(STATIC_MAP_TYPES as readonly string[]).includes(r.maptype)) return bad(`maptype must be one of ${STATIC_MAP_TYPES.join(', ')}`)
  return null
}

/** The query Google is sent, from checked numbers only. Six decimals is 11 cm, and never an exponent. */
export function staticMapQuery(r: StaticMapRequest): Record<string, string> {
  return {
    center:  `${r.center.lat.toFixed(6)},${r.center.lng.toFixed(6)}`,
    zoom:    String(r.zoom),
    size:    `${r.width}x${r.height}`,
    scale:   String(r.scale ?? 1),
    maptype: r.maptype ?? 'satellite',
  }
}

// ─── Signing ──────────────────────────────────────────────────────────────

const fromUrlBase64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), c => c.charCodeAt(0))
const toUrlBase64   = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_')

/**
 * Google's URL signature: HMAC-SHA1 over the path and query exactly as sent,
 * keyed by the URL-safe-base64-decoded secret, answered URL-safe base64
 * (https://developers.google.com/maps/documentation/maps-static/digital-signature).
 * `pathAndQuery` is everything after the host; scheme and host are not signed.
 * WebCrypto, so the sink's node:crypto verifier is a second implementation.
 */
export async function signStaticMapUrl(pathAndQuery: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', fromUrlBase64(secret), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign'])
  return toUrlBase64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(pathAndQuery)))
}

/** The one value an account stores for the Static target. */
export function staticMapCredential(key: string, secret?: string): string {
  return JSON.stringify(secret ? { key, secret } : { key })
}

// The message names the shape and never the value: it reaches logs as auth_failed.
function readCredential(stored: string): { key: string; secret?: string } {
  let v: unknown
  try { v = JSON.parse(stored) } catch { v = null }
  const o = v as { key?: unknown; secret?: unknown } | null
  if (!o || typeof o !== 'object' || typeof o.key !== 'string' || !o.key || (o.secret !== undefined && (typeof o.secret !== 'string' || !o.secret)))
    throw new TypeError('google-maps: the Static Maps credential must be JSON { key, secret? } (staticMapCredential)')
  return { key: o.key, ...(typeof o.secret === 'string' ? { secret: o.secret } : {}) }
}

/**
 * Writes `key`, signs the URL as conduit will fetch it, and adds `signature`.
 * The URL is re-serialized here as the transport re-serializes it on `set`,
 * so the bytes signed are the bytes sent.
 */
export const googleUrlSigner: Signer = async ({ secret: stored, url }) => {
  const { key, secret } = readCredential(stored)
  const u = new URL(url)
  // conduit replaces a caller's `signature` in place, after what was signed.
  if (u.searchParams.has('signature')) throw new TypeError('google-maps: a request may not carry its own signature parameter')
  u.searchParams.set('key', key)
  if (!secret) return { query: { key } }
  return { query: { key, signature: await signStaticMapUrl(u.pathname + u.search, secret) } }
}

/** Spread into `createConduit({ signers })`. */
export const staticMapSigners: Record<string, Signer> = { [GOOGLE_URL_SIGNER]: googleUrlSigner }

// ─── The call ─────────────────────────────────────────────────────────────

const IMAGE = /^image\/(png|jpe?g|gif|webp)$/

/** One image. `who` only where the caller is not junction's plugin, which writes it. */
export async function staticMap(send: StaticMapSend, req: StaticMapRequest, opts: { who?: CredentialCaller } = {}): Promise<{ image?: StaticMapImage; error?: StaticMapFailure }> {
  const refused = refuseStaticMap(req)
  if (refused) return { error: refused }
  // A read billed per request: a lost answer replayed is a second charge, never a second write.
  const r = await send<unknown>({
    method: 'GET', path: GOOGLE_STATIC_MAP_PATH, query: staticMapQuery(req), replayable: true,
    ...(opts.who ? { who: opts.who } : {}),
  })
  if (r.error) return { error: translateStaticMap(r.error, r.meta?.status) }

  const type = (r.meta?.headers?.['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  if (r.data instanceof Uint8Array && r.data.byteLength > 0 && IMAGE.test(type)) {
    const h = r.meta?.headers ?? {}
    return { image: { bytes: r.data, contentType: type, ...(h['cache-control'] ? { cacheControl: h['cache-control'] } : {}), ...(h.etag ? { etag: h.etag } : {}) } }
  }
  return { error: { kind: 'not_an_image', message: `expected an image, got ${type || 'no content-type'}`, retryable: false, status: r.meta?.status } }
}
