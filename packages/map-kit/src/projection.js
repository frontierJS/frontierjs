/**
 * projection.js — web mercator, the tiles a window needs, and a fit.
 *
 * Pure: no DOM, no I/O, so a server render and a browser agree to the pixel.
 * The reference is Leaflet 1.9.4 (SphericalMercator, GridLayer, Map); the
 * numbers its behavior produces are the tests.
 */

export const TILE_SIZE = 256
export const MAX_LATITUDE = 85.0511287798

// Leaflet's SphericalMercator radius. CRS.Earth's 6371000 is for distance only.
const R = 6378137
const D = Math.PI / 180

/** @typedef {{ lat: number, lng: number }} LatLng */
/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ x: number, y: number, z: number, left: number, top: number, size: number }} Tile */
/** @typedef {{ zoom: number, width: number, height: number, origin: Point, tiles: Tile[], toLayer: (point: LatLng) => Point }} View */
/** @typedef {{ tiles: string, attribution?: string, maxZoom?: number, tileSize?: number, subdomains?: string | string[] }} Basemap */

/** @param {string} name @param {unknown} value */
function refuseNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number, got ${String(value)}`)
  }
}

/** @param {unknown} zoom */
function refuseZoom(zoom) {
  if (typeof zoom !== 'number' || !Number.isInteger(zoom) || zoom < 0) {
    throw new Error(`zoom must be a whole number of 0 or more, got ${String(zoom)}`)
  }
}

/** @param {string} name @param {unknown} value */
function refuseSize(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number, got ${String(value)}`)
  }
}

/**
 * A point in world pixels at `zoom`. Latitude is clamped to ±MAX_LATITUDE,
 * where the mercator square ends; longitude is NOT wrapped, so 181 lands east
 * of the world's right edge and only a tile's column wraps.
 * @param {LatLng} point
 * @param {number} zoom
 * @returns {Point}
 */
export function project({ lat, lng }, zoom) {
  refuseNumber('lat', lat)
  refuseNumber('lng', lng)
  refuseNumber('zoom', zoom)
  const world = TILE_SIZE * 2 ** zoom
  const phi = Math.max(Math.min(MAX_LATITUDE, lat), -MAX_LATITUDE) * D
  const mx = R * lng * D
  const my = R * Math.log(Math.tan(Math.PI / 4 + phi / 2))
  const scale = 0.5 / (Math.PI * R)
  return { x: world * (scale * mx + 0.5), y: world * (-scale * my + 0.5) }
}

/**
 * The inverse of `project`.
 * @param {Point} point
 * @param {number} zoom
 * @returns {LatLng}
 */
export function unproject({ x, y }, zoom) {
  refuseNumber('x', x)
  refuseNumber('y', y)
  refuseNumber('zoom', zoom)
  const world = TILE_SIZE * 2 ** zoom
  const mx = (x / world - 0.5) * 2 * Math.PI * R
  const my = (0.5 - y / world) * 2 * Math.PI * R
  return { lat: (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) / D, lng: mx / R / D }
}

/**
 * The window a map shows. Layer pixels are world pixels minus `origin`, so the
 * window is always 0 0 width height. The tile range comes from `origin`, not
 * from a floored center, so a tile and a marker cannot disagree by a pixel.
 * A tile's `x` is the wrapped column, what goes in the URL; `left` and `top`
 * come from the unwrapped column, so every copy of a wrapped tile is kept at
 * its own position. A row outside the world is skipped, never wrapped.
 * @param {{ center: LatLng, zoom: number, width: number, height: number }} args
 * @returns {View}
 */
export function view({ center, zoom, width, height }) {
  refuseZoom(zoom)
  refuseSize('width', width)
  refuseSize('height', height)
  const c = project(center, zoom)
  const origin = { x: Math.round(c.x - width / 2), y: Math.round(c.y - height / 2) }
  const n = 2 ** zoom
  const x0 = Math.floor(origin.x / TILE_SIZE)
  const x1 = Math.ceil((origin.x + width) / TILE_SIZE) - 1
  const y0 = Math.floor(origin.y / TILE_SIZE)
  const y1 = Math.ceil((origin.y + height) / TILE_SIZE) - 1

  /** @type {Tile[]} */
  const tiles = []
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= n) continue
    for (let x = x0; x <= x1; x++) {
      tiles.push({
        x: ((x % n) + n) % n,
        y,
        z: zoom,
        left: x * TILE_SIZE - origin.x,
        top: y * TILE_SIZE - origin.y,
        size: TILE_SIZE,
      })
    }
  }

  return {
    zoom,
    width,
    height,
    origin,
    tiles,
    toLayer(point) {
      const p = project(point, zoom)
      return { x: p.x - origin.x, y: p.y - origin.y }
    },
  }
}

/**
 * Every [lng, lat] position under a GeoJSON value, and a bare point or bbox.
 * @param {any} g
 * @param {LatLng[]} out
 * @returns {void}
 */
function collect(g, out) {
  if (Array.isArray(g)) {
    const [w, so, e, n] = readBbox(g)
    out.push({ lat: so, lng: w }, { lat: n, lng: e })
    return
  }
  if (!g || typeof g !== 'object') throw new Error(`fit: cannot read a geometry from ${String(g)}`)
  if (typeof g.lat === 'number' && typeof g.lng === 'number') {
    out.push({ lat: g.lat, lng: g.lng })
    return
  }
  if (g.bbox !== undefined) {
    if (!Array.isArray(g.bbox)) throw new Error('fit: bbox must be [west, south, east, north]')
    readBbox(g.bbox)
  }
  switch (g.type) {
    case 'Point': return position(g.coordinates, out)
    case 'MultiPoint':
    case 'LineString': return g.coordinates.forEach((/** @type {any} */ p) => position(p, out))
    case 'MultiLineString':
    case 'Polygon': return g.coordinates.forEach((/** @type {any[]} */ ring) => ring.forEach((p) => position(p, out)))
    case 'MultiPolygon':
      return g.coordinates.forEach((/** @type {any[]} */ poly) =>
        poly.forEach((ring) => ring.forEach((/** @type {any} */ p) => position(p, out))))
    case 'GeometryCollection': return g.geometries.forEach((/** @type {any} */ x) => collect(x, out))
    case 'Feature': return g.geometry ? collect(g.geometry, out) : undefined
    case 'FeatureCollection': return g.features.forEach((/** @type {any} */ x) => collect(x, out))
    default: throw new Error(`fit: unknown geometry type ${String(g.type)}`)
  }
}

/** @param {any} p @param {LatLng[]} out */
function position(p, out) {
  if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') {
    throw new Error('fit: a GeoJSON position must be [lng, lat]')
  }
  out.push({ lat: p[1], lng: p[0] })
}

/**
 * A 4- or 6-number GeoJSON bbox as [west, south, east, north]; one that crosses
 * the antimeridian (west > east) is refused.
 * @param {number[]} b
 * @returns {number[]}
 */
function readBbox(b) {
  const four = b.length === 6 ? [b[0], b[1], b[3], b[4]] : b
  if (four.length !== 4 || four.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('fit: a bbox must be [west, south, east, north]')
  }
  if (four[0] > four[2]) {
    throw new Error(`fit: bbox west ${four[0]} is east of its east ${four[2]}; a fit across the antimeridian is not supported`)
  }
  return four
}

/**
 * The center and whole zoom at which `geometries` fill a box of `width` by
 * `height` less `padding` on each side. The zoom is floored, never rounded up
 * the way Leaflet does within 1% of a level, because a static box has no pan to
 * recover the overflow. The center is the midpoint in projected pixels, not in
 * degrees.
 * @param {unknown[]} geometries points, GeoJSON, or bare [west, south, east, north] bboxes
 * @param {{ width: number, height: number, padding?: number, maxZoom: number }} options
 * @returns {{ center: LatLng, zoom: number }}
 */
export function fit(geometries, { width, height, padding = 0, maxZoom } = /** @type {any} */ ({})) {
  if (!Array.isArray(geometries) || geometries.length === 0) {
    throw new Error('fit: geometries must be a non-empty array')
  }
  if (width === undefined) throw new Error('fit: width is required')
  if (height === undefined) throw new Error('fit: height is required')
  if (maxZoom === undefined) throw new Error('fit: maxZoom is required')
  refuseSize('width', width)
  refuseSize('height', height)
  refuseNumber('padding', padding)
  refuseNumber('maxZoom', maxZoom)
  if (padding < 0) throw new Error(`padding must be 0 or more, got ${padding}`)
  const innerW = width - 2 * padding
  const innerH = height - 2 * padding
  if (innerW <= 0 || innerH <= 0) throw new Error(`padding ${padding} leaves no room in ${width} by ${height}`)

  /** @type {LatLng[]} */
  const points = []
  for (const g of geometries) collect(g, points)
  if (points.length === 0) throw new Error('fit: the geometries hold no positions')

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    const w = project(p, 0)
    minX = Math.min(minX, w.x); maxX = Math.max(maxX, w.x)
    minY = Math.min(minY, w.y); maxY = Math.max(maxY, w.y)
  }

  const spanX = maxX - minX
  const spanY = maxY - minY
  const scale = Math.min(spanX > 0 ? innerW / spanX : Infinity, spanY > 0 ? innerH / spanY : Infinity)
  // The epsilon forgives float error on a box that fits at exactly a whole level.
  const raw = scale === Infinity ? maxZoom : Math.floor(Math.log2(scale) + 1e-9)
  const zoom = Math.max(0, Math.min(maxZoom, raw))

  return { center: unproject({ x: (minX + maxX) / 2, y: (minY + maxY) / 2 }, 0), zoom }
}

/**
 * The URL of one tile. `x` and `y` arrive wrapped, from `view().tiles`; a
 * template key with no value throws, naming the key.
 * @param {Basemap} basemap
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {{ r?: string }} [options]
 */
export function tileUrl(basemap, x, y, z, { r = '' } = {}) {
  const { tiles, subdomains } = basemap
  return tiles.replace(/\{(\w+)\}/g, (_, key) => {
    switch (key) {
      case 'z': return String(z)
      case 'x': return String(x)
      case 'y': return String(y)
      case 'r': return r
      case 's': {
        if (!subdomains || subdomains.length === 0) throw new Error('tileUrl: the template has {s} but the basemap has no subdomains')
        return String(subdomains[Math.abs(x + y) % subdomains.length])
      }
      default: throw new Error(`tileUrl: the template has {${key}}, which has no value`)
    }
  })
}
