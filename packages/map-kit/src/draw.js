/**
 * draw.js — everything StaticMap decides, as plain functions.
 *
 * Pure like projection.js: the component holds markup and styles only, so every
 * refusal and every number is testable under `bun test` with no Mesa in the way.
 */
import vocabulary from '@frontierjs/css/vocabulary.json' with { type: 'json' }
import { fit, imageUrl, project, tileUrl, view } from './projection.js'

/** @typedef {import('./projection.js').LatLng} LatLng */
/** @typedef {import('./projection.js').Basemap} Basemap */
/** @typedef {import('./projection.js').View} View */
/** @typedef {import('./projection.js').ImageBasemap} ImageBasemap */

// The tone set is css's, read from its vocabulary, so a tone added there is
// valid here with no edit. A bare copy would drift and refuse a tone css ships.
export const TONES = /** @type {string[]} */ (vocabulary.notATerm.tone)

// Stage 1 draws a shape one of two ways: a translucent toned fill, or `outlined`.
export const TREATMENTS = ['outlined']

export const DEFAULT_ZOOM = 19
export const DEFAULT_PADDING = 20

/** @param {number} n */
const round = (n) => Math.round(n * 100) / 100

/** @param {any} p @param {(point: LatLng) => { x: number, y: number }} toLayer */
function vertex(p, toLayer) {
  if (!Array.isArray(p) || typeof p[0] !== 'number' || typeof p[1] !== 'number') {
    throw new Error('pathData: a GeoJSON position must be [lng, lat]')
  }
  const { x, y } = toLayer({ lat: p[1], lng: p[0] })
  return `${round(x)} ${round(y)}`
}

/**
 * @param {any} coordinates
 * @param {(point: LatLng) => { x: number, y: number }} toLayer
 * @param {boolean} closed
 */
function ring(coordinates, toLayer, closed) {
  const min = closed ? 4 : 2
  if (!Array.isArray(coordinates) || coordinates.length < min) {
    throw new Error(`pathData: a ${closed ? 'polygon ring' : 'line'} needs at least ${min} positions`)
  }
  return `M${coordinates.map((/** @type {any} */ p) => vertex(p, toLayer)).join('L')}${closed ? 'Z' : ''}`
}

/**
 * The `d` of a `<path>` for a GeoJSON Polygon, MultiPolygon, LineString or
 * MultiLineString, or a Feature wrapping one. Each position goes through
 * `toLayer`, numbers are rounded to 2 decimals, polygon rings close with `Z`
 * and lines do not. Any other type is refused by name.
 * @param {any} geojson
 * @param {(point: LatLng) => { x: number, y: number }} toLayer
 * @returns {string}
 */
export function pathData(geojson, toLayer) {
  if (!geojson || typeof geojson !== 'object') throw new Error(`pathData: cannot read a geometry from ${String(geojson)}`)
  switch (geojson.type) {
    case 'Feature':
      if (!geojson.geometry) throw new Error('pathData: a Feature has no geometry')
      return pathData(geojson.geometry, toLayer)
    case 'Polygon': return geojson.coordinates.map((/** @type {any} */ r) => ring(r, toLayer, true)).join('')
    case 'MultiPolygon':
      return geojson.coordinates.map((/** @type {any[]} */ poly) => poly.map((r) => ring(r, toLayer, true)).join('')).join('')
    case 'LineString': return ring(geojson.coordinates, toLayer, false)
    case 'MultiLineString': return geojson.coordinates.map((/** @type {any} */ l) => ring(l, toLayer, false)).join('')
    default: throw new Error(`pathData: cannot draw a ${String(geojson.type)}; use Polygon, MultiPolygon, LineString or MultiLineString`)
  }
}

/**
 * Place the window: `fit` or `center` (with an optional `zoom`), exactly one.
 * A lone `center` zooms to 19, ELA's measured default (plan 0.4), capped at what
 * the basemap serves; `fit` is floored by `maxZoom` the same way.
 * @param {{ basemap?: Basemap, width: number, height: number, center?: LatLng, zoom?: number, fit?: unknown[], padding?: number, maxZoom?: number }} props
 * @returns {{ center: LatLng, zoom: number }}
 */
export function resolvePlace({ basemap, width, height, center, zoom, fit: fitting, padding, maxZoom }) {
  const served = Math.min(basemap?.maxZoom ?? DEFAULT_ZOOM, DEFAULT_ZOOM)
  if (fitting !== undefined && fitting !== null) {
    if (center) throw new Error('StaticMap: give fit or center, not both')
    if (zoom !== undefined && zoom !== null) throw new Error('StaticMap: zoom goes with center; fit chooses its own zoom')
    return fit(fitting, { width, height, padding: padding ?? DEFAULT_PADDING, maxZoom: maxZoom ?? served })
  }
  if (!center) throw new Error('StaticMap: fit or center is required')
  return { center, zoom: zoom ?? served }
}

/**
 * The tiled window.
 * @param {Parameters<typeof resolvePlace>[0]} props
 * @returns {View}
 */
export function resolveView(props) {
  return view({ ...resolvePlace(props), width: props.width, height: props.height })
}

/** @param {number} n */
const trim = (n) => Math.round(n * 1e7) / 1e7

/**
 * The one image of an image basemap and where its pixels sit. The image
 * covers the whole box, centered on `center` at `zoom`, so a layer pixel is a
 * world pixel minus the box's top-left corner and the center lands at
 * width/2 height/2 exactly. A tiled view rounds that corner to a whole pixel
 * to keep tile seams on pixels; here nothing has a seam, and a round would
 * put a center marker half a pixel off the point the vendor centered on.
 *
 * A box over `maxSize` or a zoom over `maxZoom` is refused, not clamped: a
 * clamped box is an image that does not cover the map and a clamped zoom is a
 * map that is not where the caller asked, with nothing on screen to say so.
 * (A DEFAULT zoom is capped, as for tiles, because nobody asked for it.)
 * @param {ImageBasemap} basemap
 * @param {{ center: LatLng, zoom: number, width: number, height: number }} frame
 */
export function imageFrame(basemap, { center, zoom, width, height }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`StaticMap: an image basemap needs a whole width and height, got ${String(width)} by ${String(height)}`)
  }
  if (!Number.isInteger(zoom) || zoom < 0) throw new Error(`StaticMap: an image basemap needs a whole zoom of 0 or more, got ${String(zoom)}`)
  const { maxSize, maxZoom, scale = 1 } = basemap
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`StaticMap: the basemap's scale must be a whole number of 1 or more, got ${String(scale)}`)
  if (maxSize !== undefined && (width > maxSize || height > maxSize)) {
    throw new Error(`StaticMap: ${width} by ${height} is over the basemap's maxSize of ${maxSize}; the vendor cannot draw it`)
  }
  if (maxZoom !== undefined && zoom > maxZoom) {
    throw new Error(`StaticMap: zoom ${zoom} is over the basemap's maxZoom of ${maxZoom}`)
  }
  // The URL carries a trimmed center, so the markers are placed against that
  // same center, not the caller's longer one.
  const at = { lat: trim(center.lat), lng: trim(center.lng) }
  const c = project(at, zoom)
  const origin = { x: c.x - width / 2, y: c.y - height / 2 }
  return {
    href: imageUrl(basemap, { center: at, zoom, width, height }),
    x: 0,
    y: 0,
    width,
    height,
    /** @param {LatLng} point */
    toLayer(point) {
      const p = project(point, zoom)
      return { x: p.x - origin.x, y: p.y - origin.y }
    },
  }
}

/** @param {...(string | undefined | null | false)} names */
const classes = (...names) => names.filter(Boolean).join(' ')

/** @param {string} what @param {unknown} tone @param {unknown} treatment */
function checkLook(what, tone, treatment) {
  if (tone && !TONES.includes(/** @type {string} */ (tone))) {
    throw new Error(`StaticMap: unknown tone "${String(tone)}" on a ${what}; the tones are ${TONES.join(', ')}`)
  }
  if (treatment && !TREATMENTS.includes(/** @type {string} */ (treatment))) {
    throw new Error(`StaticMap: unknown treatment "${String(treatment)}" on a ${what}; the treatments are ${TREATMENTS.join(', ')}`)
  }
}

/**
 * Everything the component renders, resolved and validated.
 * @param {{
 *   basemap: Basemap, label: string, width?: number, height?: number,
 *   center?: LatLng, zoom?: number, fit?: unknown[], padding?: number, maxZoom?: number,
 *   shapes?: { geojson: any, tone?: string, treatment?: string }[],
 *   markers?: { at: LatLng, tone?: string, label?: string }[],
 *   r?: string
 * }} props
 */
export function mapModel(props) {
  const { basemap, label, width = 500, height = 300, shapes = [], markers = [] } = props
  if (typeof label !== 'string' || label.trim() === '') {
    throw new Error('StaticMap: label is required, the map\'s accessible name')
  }
  const tiled = typeof (/** @type {any} */ (basemap))?.tiles === 'string'
  const imaged = typeof (/** @type {any} */ (basemap))?.image === 'string'
  if (tiled === imaged) {
    throw new Error(`StaticMap: basemap is required, with a tiles template or an image template${tiled ? ', not both' : ''}`)
  }
  /** @type {{ toLayer: (point: LatLng) => { x: number, y: number } }} */
  let frame
  /** @type {{ href: string, x: number, y: number, size: number }[]} */
  let tiles = []
  /** @type {ReturnType<typeof imageFrame> | null} */
  let image = null
  if (imaged) {
    image = imageFrame(/** @type {ImageBasemap} */ (basemap), { ...resolvePlace({ ...props, basemap, width, height }), width, height })
    frame = image
  } else {
    const v = resolveView({ ...props, basemap, width, height })
    const tb = /** @type {import('./projection.js').TiledBasemap} */ (basemap)
    const r = props.r ?? (tb.tiles.includes('{r}') ? '@2x' : '')
    tiles = v.tiles.map((t) => ({ href: tileUrl(basemap, t.x, t.y, t.z, { r }), x: t.left, y: t.top, size: t.size }))
    frame = v
  }

  return {
    width,
    height,
    label,
    viewBox: `0 0 ${width} ${height}`,
    tiles,
    image,
    shapes: shapes.map((s) => {
      checkLook('shape', s.tone, s.treatment)
      return { d: pathData(s.geojson, frame.toLayer), class: classes('shape', s.tone, s.treatment) }
    }),
    markers: markers.map((m) => {
      checkLook('marker', m.tone, undefined)
      const p = frame.toLayer(m.at)
      return { transform: `translate(${round(p.x)} ${round(p.y)})`, class: classes('marker', m.tone), label: m.label ?? '' }
    }),
    labels: markers.map((m) => m.label).filter((l) => typeof l === 'string' && l !== ''),
    attribution: basemap.attribution ?? '',
  }
}
