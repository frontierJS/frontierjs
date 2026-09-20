/*
 * geo.js — where a row is, as arithmetic over two numbers.
 *
 * Both ends need this and neither may own it. The Data boundary answers
 * `where: { site: { near: … } }` in SQL; the browser answers *is this arriving
 * row still in the list* (`matchesQuery`) and *how far away is this one* on a
 * screen, over rows it is already holding. A copy on each side is `FJS-059`'s
 * bill paid a second time, so the functions live below the graph where both may
 * import them (`FJS-D26`).
 *
 * The scope is five functions and stops there (`FJS-D325`): a convex hull and a
 * spherical buffer are a geometry library with a spine, and half of one is a
 * battery that has stopped being severable. A crew's working area here is a box
 * around a centroid — rougher than the buffered hull an application built by
 * hand out of turf, and five functions instead of a dependency.
 *
 * ── The trap this file exists to hold ─────────────────────────────────────
 *
 * A bounding box is the cheap half of a proximity search: prune with the box,
 * then measure exactly. Written naively it silently returns FEWER rows, with a
 * 200, in two places — a box crossing ±180°, where `lng >= west AND lng <= east`
 * is false for every point when west > east, and near a pole, where a radius in
 * degrees of longitude exceeds the meridian's own convergence. Elasticsearch,
 * qdrant and GeoBlacklight each shipped that defect; the known answer is to
 * SPLIT the wrapping box into two, and to widen to the whole parallel at the
 * pole. `boundingBox` therefore returns a LIST of boxes and never one, so a
 * caller cannot forget the case that has no error message.
 *
 * Distances are metres and angles are degrees, everywhere, both directions.
 */

const R = 6371008.8            // IUGG mean earth radius, metres
const RAD = Math.PI / 180

const toRad = (deg) => deg * RAD
const toDeg = (rad) => rad / RAD

/**
 * A point, from either spelling. `{lat, lng}` is the wire and the column pair
 * is what a row out of an older schema carries, so both are read rather than
 * making every caller normalize first — which is exactly what four files of one
 * real application did by hand, one of them with a `||` between the two.
 */
function point(p, label = 'point') {
  if (!p || typeof p !== 'object')
    throw new Error(`${label}: expected { lat, lng }, got ${p === null ? 'null' : typeof p}`)
  const lat = Number(p.lat ?? p.latitude)
  const lng = Number(p.lng ?? p.longitude ?? p.lon)
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    throw new Error(`${label}: lat and lng must both be numbers`)
  if (lat < -90 || lat > 90)
    throw new Error(`${label}: latitude ${lat} is outside ±90`)
  if (lng < -180 || lng > 180)
    throw new Error(`${label}: longitude ${lng} is outside ±180`)
  return { lat, lng }
}

/**
 * Is this value a usable point? The question `matchesQuery` asks before it
 * compares, and the one a screen asks before it prints a distance — a row whose
 * coordinate was never set is the common case, not an error.
 *
 * @param {unknown} p
 * @returns {boolean}
 */
export function isPoint(p) {
  try { point(p); return true } catch { return false }
}

/**
 * Great-circle distance in metres.
 *
 * The haversine rather than the spherical law of cosines: the two agree to
 * millimetres at city scale and the law of cosines loses precision for points a
 * few metres apart, which is the distance a delivery, a technician and a
 * meter-reading are all measured at.
 *
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number} metres
 */
export function distance(a, b) {
  const p = point(a, 'distance(a)'), q = point(b, 'distance(b)')
  const dLat = toRad(q.lat - p.lat)
  const dLng = toRad(q.lng - p.lng)
  const s = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(p.lat)) * Math.cos(toRad(q.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)))
}

/**
 * The boxes that contain every point within `metres` of a centre.
 *
 * A LIST, because one box is not always enough and the caller who assumes it is
 * writes the defect this module's header names. Two shapes come back:
 *
 *   one box   — the ordinary case
 *   two boxes — the radius crosses ±180°, split at the seam
 *
 * At a pole the longitude span stops being meaningful (every meridian is
 * inside the circle), so the box widens to the whole parallel — one box, and
 * `full: true` says the longitude bound admits everything, which lets a query
 * compiler drop the clause rather than emit a tautology.
 *
 * Every box is a PREFILTER. It is always wider than the circle — a box around a
 * disc — so the exact `distance` test still runs over what it returns.
 *
 * @param {{lat:number,lng:number}} centre
 * @param {number} metres
 * @returns {Array<{south:number,north:number,west:number,east:number,full:boolean}>}
 */
export function boundingBox(centre, metres) {
  const c = point(centre, 'boundingBox(centre)')
  const m = Number(metres)
  if (!Number.isFinite(m) || m <= 0)
    throw new Error(`boundingBox: radius must be a positive number of metres, got ${metres}`)

  const dLat = toDeg(m / R)
  const south = Math.max(-90, c.lat - dLat)
  const north = Math.min(90, c.lat + dLat)

  // The circle reaches a pole: every longitude is inside it. cos() of the
  // widest latitude the box touches is what shrinks, and at the pole it is 0 —
  // dividing by it is the Infinity that makes a naive box empty.
  const widest = Math.max(Math.abs(south), Math.abs(north))
  const shrink = Math.cos(toRad(widest))
  if (south <= -90 || north >= 90 || shrink <= 1e-12)
    return [{ south, north, west: -180, east: 180, full: true }]

  const dLng = toDeg(m / R / shrink)
  if (dLng >= 180) return [{ south, north, west: -180, east: 180, full: true }]

  const west = c.lng - dLng
  const east = c.lng + dLng

  // Crossing ±180: two boxes, each of which reads as an ordinary BETWEEN. One
  // box with west > east matches nothing and says nothing.
  if (west < -180)
    return [
      { south, north, west: -180, east, full: false },
      { south, north, west: west + 360, east: 180, full: false },
    ]
  if (east > 180)
    return [
      { south, north, west, east: 180, full: false },
      { south, north, west: -180, east: east - 360, full: false },
    ]

  return [{ south, north, west, east, full: false }]
}

/**
 * Is the point inside any of the boxes `boundingBox` returned?
 *
 * The same prefilter, evaluated in JS — which is what the browser half needs so
 * that a live store grades an arriving row without a round trip.
 *
 * @param {{lat:number,lng:number}} p
 * @param {ReturnType<typeof boundingBox>} boxes
 * @returns {boolean}
 */
export function inBoxes(p, boxes) {
  const q = point(p, 'inBoxes(point)')
  return boxes.some((b) =>
    q.lat >= b.south && q.lat <= b.north &&
    (b.full || (q.lng >= b.west && q.lng <= b.east)))
}

/**
 * Is the point within `metres` of the centre? Box first, then the exact
 * measurement — the same two steps in the same order as the SQL, so the two
 * halves of a live list cannot disagree about a row on the edge.
 *
 * @param {{lat:number,lng:number}} p
 * @param {{lat:number,lng:number}} centre
 * @param {number} metres
 * @returns {boolean}
 */
export function isNear(p, centre, metres) {
  if (!isPoint(p)) return false
  return inBoxes(p, boundingBox(centre, metres)) && distance(p, centre) <= metres
}

/**
 * Is the point inside the ring?
 *
 * Ray casting, with the ring read as closed whether or not its last vertex
 * repeats the first. A point exactly on an edge is not specified — the answer
 * depends on which side the ray left from, and no caller here is asking a
 * question where the boundary is the answer.
 *
 * @param {{lat:number,lng:number}} p
 * @param {Array<{lat:number,lng:number}>} ring
 * @returns {boolean}
 */
export function pointInPolygon(p, ring) {
  const q = point(p, 'pointInPolygon(point)')
  const pts = ringOf(ring, 'pointInPolygon(ring)')
  let inside = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j]
    const straddles = (a.lng > q.lng) !== (b.lng > q.lng)
    if (!straddles) continue
    const crossing = ((b.lat - a.lat) * (q.lng - a.lng)) / (b.lng - a.lng) + a.lat
    if (q.lat < crossing) inside = !inside
  }
  return inside
}

/**
 * The ring's area in square metres.
 *
 * The spherical excess formula, so a parcel measured near a pole is not
 * reported as a parcel measured at the equator — which is what treating degrees
 * as a plane does, and the error is the cosine of the latitude, 35% at 45°.
 *
 * @param {Array<{lat:number,lng:number}>} ring
 * @returns {number} square metres
 */
export function polygonArea(ring) {
  const pts = ringOf(ring, 'polygonArea(ring)')
  if (pts.length < 3) return 0
  let total = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[j], b = pts[i]
    total += toRad(b.lng - a.lng) * (2 + Math.sin(toRad(a.lat)) + Math.sin(toRad(b.lat)))
  }
  return Math.abs((total * R * R) / 2)
}

/**
 * The mean of several points.
 *
 * Averaged as VECTORS rather than as two numbers, because the arithmetic mean
 * of -179 and 179 is 0 — the middle of the wrong ocean. Every application that
 * averages `lat` and `lng` directly carries that bug and never meets it, which
 * is the worst way to hold one.
 *
 * @param {Array<{lat:number,lng:number}>} points
 * @returns {{lat:number,lng:number}|null} null when there is nothing to average
 */
export function centroid(points) {
  const pts = (Array.isArray(points) ? points : []).filter(isPoint).map((p) => point(p))
  if (!pts.length) return null
  let x = 0, y = 0, z = 0
  for (const p of pts) {
    const lat = toRad(p.lat), lng = toRad(p.lng)
    x += Math.cos(lat) * Math.cos(lng)
    y += Math.cos(lat) * Math.sin(lng)
    z += Math.sin(lat)
  }
  x /= pts.length; y /= pts.length; z /= pts.length
  const hyp = Math.sqrt(x * x + y * y)
  // Every point cancelled — antipodes, or a great circle's worth of them. There
  // is no mean direction, and 0,0 is a plausible-looking lie.
  if (hyp < 1e-12 && Math.abs(z) < 1e-12) return null
  return { lat: toDeg(Math.atan2(z, hyp)), lng: toDeg(Math.atan2(y, x)) }
}

function ringOf(ring, label) {
  if (!Array.isArray(ring) || ring.length < 3)
    throw new Error(`${label}: expected at least three points`)
  const pts = ring.map((p, i) => point(p, `${label}[${i}]`))
  // A closed ring repeats its first vertex; the algorithms here close it
  // themselves, and the duplicate would contribute a zero-length edge.
  const first = pts[0], last = pts[pts.length - 1]
  if (pts.length > 3 && first.lat === last.lat && first.lng === last.lng) pts.pop()
  return pts
}
