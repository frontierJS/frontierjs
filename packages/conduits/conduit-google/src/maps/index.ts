// @frontierjs/conduit-google/maps — Google Maps Platform over conduit, outbound only.
//
// Calls across three Google hosts: Places (New) for geocoding an address and
// reading a place, Routes for a drive time, legacy Geocoding. The builder
// returns the descriptors as a bundle and installs nothing (FJS-D890); every
// call takes the bundle `bindGoogleMaps` returns and picks the target its host
// serves, so the connector runs in a drive with no junction in the process.
//
// ─── Three targets, one key ──────────────────────────────────────────────
// `places.googleapis.com`, `routes.googleapis.com` and `maps.googleapis.com`
// are three origins and a descriptor has one `address`, so they are three
// targets. They share a `ref`: a Maps Platform key is one credential enabled
// per API on the project, which is also why `PERMISSION_DENIED` names the API
// and not the key.
//
// ─── The field mask is the price ─────────────────────────────────────────
// Every Places and Routes request carries `X-Goog-FieldMask`, and the fields
// named decide which SKU is billed. Google refuses a request with none (400)
// and bills `*` at the most expensive tier, so both are refused here before
// the send (C9) — the first costs a round trip, the second costs money.
//
// ─── Legacy Geocoding: the key in the URL ────────────────────────────────
// `maps.googleapis.com/maps/api/geocode/json` takes the key ONLY as `?key=`,
// so its target is `api_key` with `query: 'key'` (FJS-2727): conduit puts the
// key on the fetched URL alone, never in what a caller or observer is handed.
// It answers every outcome as a 200 and says which in `status` — a wrong key
// is REQUEST_DENIED — so `geocodeLegacy` reads the body, not the status.

import type { ConduitRequest, ConduitResult, ResponseValidator, TargetDescriptor } from '@frontierjs/conduit'
import { translate, RATE_LIMIT_FALLBACK_MS, type GoogleMapsFailure } from './errors.ts'
import type { ComputeRoutesResponse, LatLng, Place, Route, SearchTextResponse, Waypoint } from './types.ts'

export * from './types.ts'
export * from './errors.ts'
export * from './cache-key.ts'

export const GOOGLE_MAPS_PLACES_TARGET  = 'provider:google-maps:places'
export const GOOGLE_MAPS_ROUTES_TARGET  = 'provider:google-maps:routes'
export const GOOGLE_MAPS_PLACES_ADDRESS = 'https://places.googleapis.com'
export const GOOGLE_MAPS_ROUTES_ADDRESS = 'https://routes.googleapis.com'
export const GOOGLE_MAPS_GEOCODING_TARGET  = 'provider:google-maps:geocoding'
export const GOOGLE_MAPS_GEOCODING_ADDRESS = 'https://maps.googleapis.com'
export const GOOGLE_MAPS_KEY_HEADER     = 'X-Goog-Api-Key'
export const FIELD_MASK_HEADER          = 'X-Goog-FieldMask'

export type Send = <T>(req: Omit<ConduitRequest, 'target'>) => Promise<ConduitResult<T>>
/** One Send per target. Every call below takes this and picks its own. */
export interface GoogleMapsSend { places: Send; routes: Send; geocoding: Send }

export interface GoogleMapsTargets { places: TargetDescriptor; routes: TargetDescriptor; geocoding: TargetDescriptor }

/**
 * Three origins, three descriptors, ONE `ref`. `address` overrides are per
 * origin because a sink stands in for all of them on one port and a real
 * deployment never moves any.
 *
 * Places and Routes carry the key in `X-Goog-Api-Key`. Legacy Geocoding takes
 * it ONLY as `?key=`, so its target is `api_key` with `query: 'key'`.
 */
export function googleMapsTargets(opts: { ref?: string; placesAddress?: string; routesAddress?: string; geocodingAddress?: string } = {}): GoogleMapsTargets {
  const ref = opts.ref ?? 'GOOGLE_MAPS_API_KEY'
  const common = { kind: 'provider' as const, protocol: 'http' as const, registered_at: Date.now(), last_seen_at: null }
  const header = { type: 'api_key' as const, ref, header: GOOGLE_MAPS_KEY_HEADER }
  return {
    places:    { ...common, id: GOOGLE_MAPS_PLACES_TARGET,    address: opts.placesAddress ?? GOOGLE_MAPS_PLACES_ADDRESS,       auth: header },
    routes:    { ...common, id: GOOGLE_MAPS_ROUTES_TARGET,    address: opts.routesAddress ?? GOOGLE_MAPS_ROUTES_ADDRESS,       auth: header },
    geocoding: { ...common, id: GOOGLE_MAPS_GEOCODING_TARGET, address: opts.geocodingAddress ?? GOOGLE_MAPS_GEOCODING_ADDRESS, auth: { type: 'api_key' as const, ref, query: 'key' } },
  }
}

export function bindGoogleMaps(conduit: { send<T>(req: ConduitRequest): Promise<ConduitResult<T>> }, targets: GoogleMapsTargets | { places: { id: string }; routes: { id: string }; geocoding: { id: string } } = googleMapsTargets()): GoogleMapsSend {
  return {
    places:    req => conduit.send({ target: targets.places.id, ...req }),
    routes:    req => conduit.send({ target: targets.routes.id, ...req }),
    geocoding: req => conduit.send({ target: targets.geocoding.id, ...req }),
  }
}

// ─── The field mask ───────────────────────────────────────────────────────

/** The mask a geocode needs and nothing a dearer SKU bills for. */
export const GEOCODE_FIELD_MASK = ['places.id', 'places.formattedAddress', 'places.location']
export const DETAILS_FIELD_MASK = ['id', 'formattedAddress', 'location', 'displayName']
export const DRIVE_TIME_FIELD_MASK = ['routes.duration', 'routes.distanceMeters']

export function assertFieldMask(mask: readonly string[] | undefined, call: string): string {
  if (!mask || mask.length === 0)
    throw new TypeError(`google-maps: ${call} needs a field mask. Google answers a request without X-Goog-FieldMask with a 400, and the fields named are what is billed.`)
  const wild = mask.find(m => m.trim() === '*' || m.endsWith('.*'))
  if (wild !== undefined)
    throw new TypeError(`google-maps: ${call} field mask '${wild}' asks for every field, which Google bills at the most expensive SKU. Name the fields.`)
  return mask.join(',')
}

// ─── Validation ───────────────────────────────────────────────────────────

/** A 200 whose body is not an object, or carries Google's error envelope, is refused (C4). */
const payload: ResponseValidator = {
  validate(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { ok: false, errors: ['google-maps: expected a JSON object'] }
    if ('error' in data) return { ok: false, errors: ['google-maps: an error envelope under a 2xx'] }
    return { ok: true, value: data }
  },
}

// ─── Places (New) ─────────────────────────────────────────────────────────

/**
 * `POST /v1/places:searchText`. A read Google charges per request, and a
 * repeat is harmless apart from the charge, so it is `replayable: true`: a
 * lost response is a second cent, never a second write.
 */
export async function searchText(gm: GoogleMapsSend, req: {
  query:        string
  fieldMask:    readonly string[]
  maxResults?:  number
  regionCode?:  string
  languageCode?: string
}): Promise<{ places?: Place[]; error?: GoogleMapsFailure }> {
  const mask = assertFieldMask(req.fieldMask, 'searchText')
  if (!req.query.trim()) throw new TypeError('google-maps: searchText needs a non-empty query')
  const result = await gm.places<SearchTextResponse>({
    method:  'POST',
    path:    '/v1/places:searchText',
    headers: { [FIELD_MASK_HEADER]: mask },
    body:    {
      textQuery: req.query,
      ...(req.maxResults   ? { maxResultCount: req.maxResults } : {}),
      ...(req.regionCode   ? { regionCode:     req.regionCode } : {}),
      ...(req.languageCode ? { languageCode:   req.languageCode } : {}),
    },
    validate:   payload,
    replayable: true,
  })
  if (result.error) return { error: translate(result.error) }
  // `{}` is how Google spells no match: `places` is absent rather than empty.
  return { places: result.data.places ?? [] }
}

export type Geocoded =
  | { answer: 'found'; place: Place; location: LatLng }
  | { answer: 'zero_results' }

/**
 * An address → the first place and its coordinates. `zero_results` is an
 * ANSWER: the address is not on the map, nothing failed, and the app may
 * cache it under `cacheKey(address)` as readily as a hit.
 */
export async function geocode(gm: GoogleMapsSend, req: { address: string; regionCode?: string }): Promise<{ result?: Geocoded; error?: GoogleMapsFailure }> {
  const got = await searchText(gm, { query: req.address, fieldMask: GEOCODE_FIELD_MASK, maxResults: 1, ...(req.regionCode ? { regionCode: req.regionCode } : {}) })
  if (got.error) return { error: got.error }
  const place = got.places?.[0]
  if (!place || !place.location) return { result: { answer: 'zero_results' } }
  return { result: { answer: 'found', place, location: place.location } }
}

/** `GET /v1/places/{id}`. A GET, so conduit replays it on its own. */
export async function placeDetails(gm: GoogleMapsSend, req: { id: string; fieldMask?: readonly string[]; languageCode?: string }): Promise<{ place?: Place; error?: GoogleMapsFailure }> {
  const mask = assertFieldMask(req.fieldMask ?? DETAILS_FIELD_MASK, 'placeDetails')
  if (!/^[\w-]+$/.test(req.id)) throw new TypeError(`google-maps: '${req.id}' is not a place id`)
  const result = await gm.places<Place>({
    method:   'GET',
    path:     `/v1/places/${req.id}`,
    headers:  { [FIELD_MASK_HEADER]: mask },
    ...(req.languageCode ? { query: { languageCode: req.languageCode } } : {}),
    validate: payload,
  })
  if (result.error) return { error: translate(result.error) }
  return { place: result.data }
}

// ─── Routes ───────────────────────────────────────────────────────────────

export interface DriveTime {
  durationSeconds: number
  distanceMeters:  number
  route:           Route
}

const waypoint = (w: Waypoint) =>
  'placeId' in w ? { placeId: w.placeId }
  : 'location' in w ? { location: { latLng: w.location } }
  : { address: w.address }

/** `"1234s"` → 1234. A protobuf Duration may carry fractions: `"12.5s"`. */
export function parseDuration(s: string | undefined): number | undefined {
  if (s === undefined) return undefined
  const m = /^(\d+(?:\.\d+)?)s$/.exec(s)
  return m ? Math.round(Number(m[1])) : undefined
}

/**
 * `POST /directions/v2:computeRoutes`, `travelMode: DRIVE`. The same cost
 * argument as `searchText`: a read, replayable. `no_route` is an answer.
 */
export async function driveTime(gm: GoogleMapsSend, req: {
  origin:       Waypoint
  destination:  Waypoint
  fieldMask?:   readonly string[]
  departureTime?: string
}): Promise<{ result?: { answer: 'found' } & DriveTime | { answer: 'no_route' }; error?: GoogleMapsFailure }> {
  const mask = assertFieldMask(req.fieldMask ?? DRIVE_TIME_FIELD_MASK, 'driveTime')
  const result = await gm.routes<ComputeRoutesResponse>({
    method:  'POST',
    path:    '/directions/v2:computeRoutes',
    headers: { [FIELD_MASK_HEADER]: mask },
    body:    {
      origin:      waypoint(req.origin),
      destination: waypoint(req.destination),
      travelMode:  'DRIVE',
      ...(req.departureTime ? { departureTime: req.departureTime, routingPreference: 'TRAFFIC_AWARE' } : {}),
    },
    validate:   payload,
    replayable: true,
  })
  if (result.error) return { error: translate(result.error) }
  const route = result.data.routes?.[0]
  const seconds = parseDuration(route?.duration)
  if (!route || seconds === undefined || route.distanceMeters === undefined) return { result: { answer: 'no_route' } }
  return { result: { answer: 'found', durationSeconds: seconds, distanceMeters: route.distanceMeters, route } }
}

// ─── Legacy Geocoding ─────────────────────────────────────────────────────

interface LegacyGeocodeResponse {
  status:         string
  error_message?: string
  results:        { place_id: string; formatted_address: string; geometry: { location: { lat: number; lng: number } } }[]
}

export type LegacyGeocoded =
  | { answer: 'found'; placeId: string; formattedAddress: string; location: LatLng }
  | { answer: 'zero_results' }

// Every outcome is a 200; `status` is the answer, so it is graded here.
const LEGACY_STATUS: Record<string, { kind: GoogleMapsFailure['kind']; retryable: boolean }> = {
  REQUEST_DENIED:   { kind: 'auth_failed',  retryable: false },
  INVALID_REQUEST:  { kind: 'refused',      retryable: false },
  OVER_QUERY_LIMIT: { kind: 'rate_limited', retryable: true },
  OVER_DAILY_LIMIT: { kind: 'forbidden',    retryable: false },
}

/** `GET /maps/api/geocode/json?address=`. A GET, so conduit replays it on its own. */
export async function geocodeLegacy(gm: GoogleMapsSend, req: { address: string; region?: string }): Promise<{ result?: LegacyGeocoded; error?: GoogleMapsFailure }> {
  const r = await gm.geocoding<LegacyGeocodeResponse>({
    method: 'GET',
    path:   '/maps/api/geocode/json',
    query:  { address: req.address, ...(req.region ? { region: req.region } : {}) },
    validate: payload,
  })
  if (r.error) return { error: translate(r.error) }
  const { status, results, error_message } = r.data
  if (status === 'ZERO_RESULTS') return { result: { answer: 'zero_results' } }
  if (status !== 'OK' || !results[0]) {
    const graded = LEGACY_STATUS[status] ?? { kind: 'server_error' as const, retryable: true }
    return { error: { ...graded, status, message: error_message ?? status, ...(graded.kind === 'rate_limited' ? { retryAfterMs: RATE_LIMIT_FALLBACK_MS } : {}) } }
  }
  const hit = results[0]
  return { result: { answer: 'found', placeId: hit.place_id, formattedAddress: hit.formatted_address, location: { latitude: hit.geometry.location.lat, longitude: hit.geometry.location.lng } } }
}
