// sink/maps.ts — Google Maps Platform, standing in for three hosts.
//
// One listener answers for `places.googleapis.com` AND `routes.googleapis.com`
// and tells them apart by PATH (`/v1/places…` against `/directions/v2:…`), so
// the drive registers both targets on one port. Google's shape, by hand: the
// key in `X-Goog-Api-Key`, the field mask required and applied to what comes
// back, the gRPC-status error envelope, `{}` for no match, and a protobuf
// Duration spelled `"1234s"`. It bills nothing but it RECORDS the SKU a mask
// would have cost, so a drive can see that a wildcard was never sent.
//
// It owns the chaos (FJS-D890): `/maps/_sink/arm` takes `{ lost }` for a request
// that is recorded and never answered, `{ rateLimit: { retryAfter?, times? } }`
// for a 429 that may carry no Retry-After and may repeat, `{ failNext }` for one
// 503 UNAVAILABLE, and `{ denyApi: 'places' | 'routes' }` for Google's
// PERMISSION_DENIED naming the API that is not enabled on the project. The
// vendor's own domain refusal is a request with no field mask: 400
// INVALID_ARGUMENT, the drive's negative control. `/maps/_sink/seen` is what
// arrived, `/maps/_sink/reset` clears it and what is armed.
//
// It does NOT pretend to geocode: four addresses are known and everything
// else is `{}`. A place id the table lacks is NOT_FOUND. Legacy Geocoding
// (`/maps/api/geocode/json`) is the third host: key in the query, status in a 200.
//
// A module of the one Google sink (`../sink.ts`): `mapsSink()` answers a path it
// owns and returns null for any other, and its control endpoints are
// `/maps/_sink/{seen,arm,reset}`.

interface KnownPlace { id: string; formattedAddress: string; location: { latitude: number; longitude: number }; displayName: { text: string; languageCode: string }; types: string[]; aliases: string[] }

export const KNOWN_PLACES: KnownPlace[] = [
  { id: 'ChIJ_sink_townhall', formattedAddress: '1 Town Hall Square, Springfield, IL 62701, USA', location: { latitude: 39.7990, longitude: -89.6440 }, displayName: { text: 'Springfield Town Hall', languageCode: 'en' }, types: ['city_hall', 'point_of_interest'], aliases: ['1 town hall square, springfield', 'springfield town hall'] },
  { id: 'ChIJ_sink_depot',    formattedAddress: '400 Depot Street, Springfield, IL 62702, USA',  location: { latitude: 39.8150, longitude: -89.6320 }, displayName: { text: 'Springfield Depot', languageCode: 'en' },     types: ['train_station'],              aliases: ['400 depot street, springfield', '400 depot st, springfield', 'springfield depot'] },
  { id: 'ChIJ_sink_library',  formattedAddress: '326 S 7th St, Springfield, IL 62701, USA',      location: { latitude: 39.7985, longitude: -89.6487 }, displayName: { text: 'Lincoln Library', languageCode: 'en' },        types: ['library'],                    aliases: ['326 s 7th st, springfield', 'lincoln library springfield'] },
  { id: 'ChIJ_sink_airport',  formattedAddress: '1200 Capital Airport Dr, Springfield, IL 62707, USA', location: { latitude: 39.8441, longitude: -89.6779 }, displayName: { text: 'Abraham Lincoln Capital Airport', languageCode: 'en' }, types: ['airport'], aliases: ['1200 capital airport dr, springfield', 'springfield airport'] },
]

const fold = (s: string) => s.toLowerCase().replace(/[.,;]+$/, '').replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').trim()
const findByText = (q: string) => { const f = fold(q); return KNOWN_PLACES.find(p => p.aliases.includes(f) || fold(p.formattedAddress).startsWith(f)) }

/** What Google would bill for a Places mask: ids only are free, `location` is Essentials, `*` is everything. */
export function skuOf(mask: string | null): string {
  if (mask === null) return 'refused'
  const fields = mask.split(',').map(s => s.trim())
  if (fields.some(f => f === '*' || f.endsWith('.*'))) return 'enterprise+atmosphere'
  if (fields.some(f => /(^|\.)(rating|reviews|priceLevel|regularOpeningHours|websiteUri|nationalPhoneNumber)$/.test(f))) return 'pro'
  if (fields.every(f => /(^|\.)(id|name|photos|attributions)$/.test(f))) return 'ids_only'
  return 'essentials'
}

/** Applies a field mask to a response object: `places.location` keeps `location` under each element of `places`. */
export function applyMask(value: unknown, mask: string): unknown {
  const paths = mask.split(',').map(s => s.trim().split('.'))
  const keep = (v: unknown, ps: string[][]): unknown => {
    if (Array.isArray(v)) return v.map(x => keep(x, ps))
    if (!v || typeof v !== 'object') return v
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      const here = ps.filter(p => p[0] === k)
      if (here.length === 0) continue
      out[k] = here.some(p => p.length === 1) ? x : keep(x, here.map(p => p.slice(1)))
    }
    return out
  }
  return keep(value, paths)
}

const haversine = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
  const r = Math.PI / 180, R = 6_371_000
  const dLat = (b.latitude - a.latitude) * r, dLng = (b.longitude - a.longitude) * r
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8', ...headers } })
const googleError = (code: number, status: string, message: string, details: unknown[] = [], headers: Record<string, string> = {}) =>
  json({ error: { code, message, status, details } }, code, headers)

export interface MapsSinkOptions {
  /** The one key both APIs accept. */
  key?:  string
}

export interface ModuleSink {
  /** The response for a path this module owns; null for any other. */
  handle(req: Request): Promise<Response | null>
  reset(): void
  stop(): void
}

export function mapsSink(opts: MapsSinkOptions = {}): ModuleSink {
  const KEY = opts.key ?? 'AIza-sink-dev'
  const seen: { api: 'places' | 'routes' | 'geocoding' | 'unknown'; method: string; path: string; headers: Record<string, string>; body: string; fieldMask: string | null; sku: string; at: number; keyInQuery?: boolean }[] = []
  const armed = { lost: false, failNext: false, rateLimit: null as null | { retryAfter?: number; times?: number }, denyApi: null as null | 'places' | 'routes' }
  const disarm = () => Object.assign(armed, { lost: false, failNext: false, rateLimit: null, denyApi: null })
  const hanging: Array<() => void> = []

  return {
    reset() { seen.length = 0; disarm() },
    stop() { for (const r of hanging) r() },
    async handle(req) {
      const url  = new URL(req.url)
      const path = url.pathname

      if (path === '/maps/_sink/seen')  return json({ requests: seen })
      if (path === '/maps/_sink/reset') { seen.length = 0; disarm(); return json({ ok: true }) }
      if (path === '/maps/_sink/arm')   { Object.assign(armed, await req.json()); return json({ ok: true, armed }) }

      // Legacy Geocoding: the key ONLY as `?key=`, and every answer a 200 whose
      // `status` says what happened — a wrong key is REQUEST_DENIED, not a 4xx.
      if (path === '/maps/api/geocode/json') {
        seen.push({ api: 'geocoding', method: req.method, path, headers: Object.fromEntries(req.headers), body: '', fieldMask: null, sku: 'geocoding', at: Date.now(), keyInQuery: url.searchParams.get('key') === KEY })
        if (url.searchParams.get('key') !== KEY) return json({ status: 'REQUEST_DENIED', error_message: 'The provided API key is invalid.', results: [] })
        const q = url.searchParams.get('address')
        if (!q) return json({ status: 'INVALID_REQUEST', error_message: 'Invalid request. Missing the \'address\' parameter.', results: [] })
        const hit = findByText(q)
        if (!hit) return json({ status: 'ZERO_RESULTS', results: [] })
        return json({ status: 'OK', results: [{ place_id: hit.id, formatted_address: hit.formattedAddress, geometry: { location: { lat: hit.location.latitude, lng: hit.location.longitude } } }] })
      }

      const api: 'places' | 'routes' | 'unknown' = path.startsWith('/v1/places') ? 'places' : path.startsWith('/directions/v2:') ? 'routes' : 'unknown'
      if (api === 'unknown') return null
      const apiName = api === 'routes' ? 'Routes API' : 'Places API (New)'
      const text = req.method === 'POST' ? await req.text() : ''
      const mask = req.headers.get('x-goog-fieldmask')
      seen.push({ api, method: req.method, path, headers: Object.fromEntries(req.headers), body: text, fieldMask: mask, sku: skuOf(mask), at: Date.now() })

      // Google answers a wrong key as a 400, not a 401: INVALID_ARGUMENT with
      // the reason in `details`. A connector that read only the status would
      // file it under the caller's mistakes.
      if (req.headers.get('x-goog-api-key') !== KEY)
        return googleError(400, 'INVALID_ARGUMENT', 'API key not valid. Please pass a valid API key.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com', metadata: { service: api === 'routes' ? 'routes.googleapis.com' : 'places.googleapis.com' } }])

      if (armed.denyApi === api) { armed.denyApi = null
        return googleError(403, 'PERMISSION_DENIED', `${apiName} has not been used in project 000000000000 before or it is disabled. Enable it by visiting the console then retry.`, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com', metadata: { service: api === 'routes' ? 'routes.googleapis.com' : 'places.googleapis.com' } }]) }

      if (armed.rateLimit) {
        const { retryAfter, times = 1 } = armed.rateLimit
        armed.rateLimit = times > 1 ? { retryAfter, times: times - 1 } : null
        return googleError(429, 'RESOURCE_EXHAUSTED', `Quota exceeded for quota metric 'Requests' and limit 'Requests per minute' of service '${api}.googleapis.com'.`, [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'RATE_LIMIT_EXCEEDED', domain: 'googleapis.com' }], retryAfter === undefined ? {} : { 'retry-after': String(retryAfter) })
      }
      if (armed.failNext) { armed.failNext = false; return googleError(503, 'UNAVAILABLE', 'The service is currently unavailable.') }

      // The real refusal: Google will not guess what to bill for.
      if (!mask)
        return googleError(400, 'INVALID_ARGUMENT', 'Request must contain a field mask. Specify the fields to return in the X-Goog-FieldMask header or the $fields query parameter.', [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field: 'X-Goog-FieldMask', description: 'required' }] }])

      let body: Record<string, unknown> = {}
      if (text) { try { body = JSON.parse(text) } catch { return googleError(400, 'INVALID_ARGUMENT', 'Invalid JSON payload received.') } }
      let answer: Response | null = null

      if (path === '/v1/places:searchText' && req.method === 'POST') {
        const q = body.textQuery
        if (typeof q !== 'string' || !q.trim()) answer = googleError(400, 'INVALID_ARGUMENT', 'Invalid value at \'text_query\': must be non-empty.')
        else {
          const hit = findByText(q)
          const { aliases: _a, ...place } = hit ?? ({} as KnownPlace)
          answer = json(hit ? applyMask({ places: [{ ...place, name: `places/${place.id}` }] }, mask) : {})
        }
      }

      const details = path.match(/^\/v1\/places\/([^/]+)$/)
      if (details && req.method === 'GET') {
        const hit = KNOWN_PLACES.find(p => p.id === details[1])
        if (!hit) answer = googleError(404, 'NOT_FOUND', `Place ${details[1]} not found.`)
        else { const { aliases: _a, ...place } = hit; answer = json(applyMask({ ...place, name: `places/${place.id}` }, mask)) }
      }

      if (path === '/directions/v2:computeRoutes' && req.method === 'POST') {
        const resolve = (w: unknown) => {
          if (!w || typeof w !== 'object') return null
          const o = w as { address?: string; placeId?: string; location?: { latLng?: { latitude: number; longitude: number } } }
          if (o.location?.latLng) return o.location.latLng
          if (o.placeId) return KNOWN_PLACES.find(p => p.id === o.placeId)?.location ?? null
          if (o.address) return findByText(o.address)?.location ?? null
          return null
        }
        if (body.travelMode !== undefined && body.travelMode !== 'DRIVE') answer = googleError(400, 'INVALID_ARGUMENT', `Invalid value at 'travel_mode': ${String(body.travelMode)}`)
        else {
          const a = resolve(body.origin), b = resolve(body.destination)
          if (!body.origin || !body.destination) answer = googleError(400, 'INVALID_ARGUMENT', 'Origin and destination are required.')
          else if (!a || !b) answer = json({})
          else {
            // Roads are not straight: 1.3 x the great-circle distance at 40 km/h.
            const meters = Math.round(haversine(a, b) * 1.3)
            answer = json(applyMask({ routes: [{ duration: `${Math.round(meters / (40_000 / 3600))}s`, distanceMeters: meters, polyline: { encodedPolyline: 'sink' } }] }, mask))
          }
        }
      }

      if (!answer) answer = googleError(404, 'NOT_FOUND', `Method not found: ${req.method} ${path}`)

      // A lost response: recorded (it would have been billed), never answered.
      if (armed.lost) { armed.lost = false; await new Promise<void>(resolve => hanging.push(resolve)) }
      return answer
    },
  }
}
