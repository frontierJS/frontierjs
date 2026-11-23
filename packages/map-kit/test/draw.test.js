import { describe, expect, test } from 'bun:test'
import vocabulary from '../../css/vocabulary.json' with { type: 'json' }
import { mapModel, pathData, resolveView, TONES } from '../src/draw.js'
import { fit, project, view } from '../src/projection.js'

const basemap = { tiles: '/tiles/{z}/{x}/{y}{r}.svg', attribution: 'Fixture tiles', maxZoom: 19 }
const center = { lat: 40.7128, lng: -74.006 }
const lot = {
  type: 'Polygon',
  coordinates: [[[-74.0062, 40.7126], [-74.0058, 40.7126], [-74.0058, 40.713], [-74.0062, 40.713], [-74.0062, 40.7126]]],
}

describe('TONES', () => {
  test('is the css vocabulary, the file a tone is added to', () => {
    expect(TONES).toEqual(vocabulary.notATerm.tone)
    expect(TONES).toContain('danger')
  })
})

describe('pathData', () => {
  const v = view({ center, zoom: 19, width: 500, height: 300 })
  const at = (/** @type {number} */ lng, /** @type {number} */ lat) => {
    const p = v.toLayer({ lat, lng })
    return `${Math.round(p.x * 100) / 100} ${Math.round(p.y * 100) / 100}`
  }

  test('a polygon ring closes with Z', () => {
    const d = pathData(lot, v.toLayer)
    expect(d).toBe(`M${at(-74.0062, 40.7126)}L${at(-74.0058, 40.7126)}L${at(-74.0058, 40.713)}L${at(-74.0062, 40.713)}L${at(-74.0062, 40.7126)}Z`)
  })

  test('a line does not close', () => {
    const d = pathData({ type: 'LineString', coordinates: [[-74.0062, 40.7126], [-74.0058, 40.713]] }, v.toLayer)
    expect(d).toBe(`M${at(-74.0062, 40.7126)}L${at(-74.0058, 40.713)}`)
  })

  test('MultiPolygon and MultiLineString concatenate their parts', () => {
    const ring = lot.coordinates[0]
    const one = pathData(lot, v.toLayer)
    expect(pathData({ type: 'MultiPolygon', coordinates: [lot.coordinates, lot.coordinates] }, v.toLayer)).toBe(one + one)
    const line = [[-74.0062, 40.7126], [-74.0058, 40.713]]
    const l = pathData({ type: 'LineString', coordinates: line }, v.toLayer)
    expect(pathData({ type: 'MultiLineString', coordinates: [line, line] }, v.toLayer)).toBe(l + l)
    expect(ring.length).toBe(5)
  })

  test('a Feature is read through to its geometry', () => {
    expect(pathData({ type: 'Feature', properties: {}, geometry: lot }, v.toLayer)).toBe(pathData(lot, v.toLayer))
  })

  test('numbers carry at most 2 decimals', () => {
    for (const n of pathData(lot, v.toLayer).match(/-?\d+(\.\d+)?/g) ?? []) {
      expect(n.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2)
    }
  })

  test('positions are [lng, lat]: a swapped pair lands elsewhere', () => {
    const d = pathData({ type: 'LineString', coordinates: [[-74.006, 40.7128], [-74.0059, 40.7128]] }, v.toLayer)
    const p = project(center, 19)
    const o = view({ center, zoom: 19, width: 500, height: 300 }).origin
    expect(d.startsWith(`M${Math.round((p.x - o.x) * 100) / 100} `)).toBe(true)
  })

  test('refuses another type by name', () => {
    expect(() => pathData({ type: 'Point', coordinates: [0, 0] }, v.toLayer)).toThrow('cannot draw a Point')
    expect(() => pathData({ type: 'FeatureCollection', features: [] }, v.toLayer)).toThrow('FeatureCollection')
    expect(() => pathData(null, v.toLayer)).toThrow('cannot read a geometry')
  })

  test('refuses a bad position and a short ring', () => {
    expect(() => pathData({ type: 'LineString', coordinates: [[1], [2, 3]] }, v.toLayer)).toThrow('[lng, lat]')
    expect(() => pathData({ type: 'LineString', coordinates: [[1, 2]] }, v.toLayer)).toThrow('at least 2')
    expect(() => pathData({ type: 'Polygon', coordinates: [[[1, 2], [3, 4], [1, 2]]] }, v.toLayer)).toThrow('at least 4')
  })
})

describe('resolveView', () => {
  const size = { width: 640, height: 360 }

  test('center alone zooms to 19', () => {
    expect(resolveView({ basemap, center, ...size }).zoom).toBe(19)
  })

  test('center alone is capped at the basemap maxZoom', () => {
    expect(resolveView({ basemap: { ...basemap, maxZoom: 17 }, center, ...size }).zoom).toBe(17)
    expect(resolveView({ basemap: { ...basemap, maxZoom: 22 }, center, ...size }).zoom).toBe(19)
    expect(resolveView({ basemap: { tiles: 'x' }, center, ...size }).zoom).toBe(19)
  })

  test('an explicit zoom is used as given', () => {
    expect(resolveView({ basemap, center, zoom: 12, ...size }).zoom).toBe(12)
  })

  test('fit is projection fit, padding 20 and maxZoom from the basemap by default', () => {
    const want = fit([lot], { ...size, padding: 20, maxZoom: 19 })
    const got = resolveView({ basemap, fit: [lot], ...size })
    expect(got.zoom).toBe(want.zoom)
    expect(got.origin).toEqual(view({ ...want, ...size }).origin)
    expect(resolveView({ basemap: { ...basemap, maxZoom: 17 }, fit: [lot], ...size }).zoom).toBe(17)
  })

  test('fit takes its own padding and maxZoom', () => {
    const got = resolveView({ basemap, fit: [lot], padding: 100, maxZoom: 16, ...size })
    expect(got.zoom).toBe(fit([lot], { ...size, padding: 100, maxZoom: 16 }).zoom)
  })

  test('refuses neither, both, and zoom with fit, by name', () => {
    expect(() => resolveView({ basemap, ...size })).toThrow('fit or center is required')
    expect(() => resolveView({ basemap, fit: [lot], center, ...size })).toThrow('not both')
    expect(() => resolveView({ basemap, fit: [lot], zoom: 15, ...size })).toThrow('zoom goes with center')
  })
})

describe('mapModel', () => {
  const base = { basemap, label: 'A map', center, width: 500, height: 300 }

  test('the viewBox is the declared window', () => {
    expect(mapModel(base).viewBox).toBe('0 0 500 300')
    expect(mapModel({ ...base, width: 640, height: 360 }).viewBox).toBe('0 0 640 360')
  })

  test('r defaults to @2x only when the template has {r}', () => {
    expect(mapModel(base).tiles[0].href).toContain('@2x.svg')
    expect(mapModel({ ...base, r: '' }).tiles[0].href).not.toContain('@2x')
    expect(mapModel({ ...base, basemap: { tiles: '/t/{z}/{x}/{y}.png' } }).tiles[0].href).toMatch(/\/t\/19\/\d+\/\d+\.png$/)
  })

  test('tiles are 256 layer pixels with or without {r}', () => {
    expect(new Set(mapModel(base).tiles.map((t) => t.size))).toEqual(new Set([256]))
  })

  test('classes join without stray spaces', () => {
    const m = mapModel({
      ...base,
      shapes: [{ geojson: lot }, { geojson: lot, tone: 'success', treatment: 'outlined' }],
      markers: [{ at: center }, { at: center, tone: 'info', label: 'Here' }],
    })
    expect(m.shapes.map((s) => s.class)).toEqual(['shape', 'shape success outlined'])
    expect(m.markers.map((s) => s.class)).toEqual(['marker', 'marker info'])
    expect(m.labels).toEqual(['Here'])
  })

  test('a marker at the center lands at half the window', () => {
    const m = mapModel({ ...base, markers: [{ at: center }] })
    const [x, y] = m.markers[0].transform.match(/-?\d+(\.\d+)?/g) ?? []
    expect(Math.abs(Number(x) - 250)).toBeLessThanOrEqual(1)
    expect(Math.abs(Number(y) - 150)).toBeLessThanOrEqual(1)
  })

  test('refuses what has no name, no basemap, an unknown tone or treatment', () => {
    expect(() => mapModel({ ...base, label: '' })).toThrow('label is required')
    expect(() => mapModel(/** @type {any} */ ({ ...base, label: undefined }))).toThrow('label is required')
    expect(() => mapModel(/** @type {any} */ ({ ...base, basemap: undefined }))).toThrow('basemap is required')
    expect(() => mapModel({ ...base, shapes: [{ geojson: lot, tone: 'teal' }] })).toThrow('unknown tone "teal" on a shape')
    expect(() => mapModel({ ...base, markers: [{ at: center, tone: 'teal' }] })).toThrow('unknown tone "teal" on a marker')
    expect(() => mapModel({ ...base, shapes: [{ geojson: lot, treatment: 'glass' }] })).toThrow('unknown treatment "glass"')
  })
})

describe('an image basemap', () => {
  const image = {
    image: 'https://api.test/static?center={lat},{lng}&zoom={zoom}&size={width}x{height}&scale={scale}',
    maxSize: 640,
    maxZoom: 20,
    scale: 2,
  }
  const base = { basemap: image, label: 'A map', center, width: 500, height: 300 }

  test('one image covers the whole box, its URL carrying the center, zoom, size and scale', () => {
    const m = mapModel(base)
    expect(m.tiles).toEqual([])
    expect(m.image).toMatchObject({ x: 0, y: 0, width: 500, height: 300 })
    expect(m.image?.href).toBe('https://api.test/static?center=40.7128,-74.006&zoom=19&size=500x300&scale=2')
  })

  test('scale defaults to 1', () => {
    expect(mapModel({ ...base, basemap: { image: image.image } }).image?.href).toEndWith('&scale=1')
  })

  test('a marker at the center lands at exactly half the box, with no whole-pixel round', () => {
    const m = mapModel({ ...base, width: 501, height: 299, markers: [{ at: center }] })
    expect(m.markers[0].transform).toBe('translate(250.5 149.5)')
  })

  test('shapes and markers are projected as for tiles, a whole-pixel origin apart at most', () => {
    const tiled = mapModel({ ...base, basemap, shapes: [{ geojson: lot }], markers: [{ at: { lat: 40.7126, lng: -74.0062 } }] })
    const imaged = mapModel({ ...base, shapes: [{ geojson: lot }], markers: [{ at: { lat: 40.7126, lng: -74.0062 } }] })
    const nums = (/** @type {string} */ s) => (s.match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
    nums(tiled.shapes[0].d).forEach((n, i) => expect(Math.abs(n - nums(imaged.shapes[0].d)[i])).toBeLessThanOrEqual(0.5))
    nums(tiled.markers[0].transform).forEach((n, i) => expect(Math.abs(n - nums(imaged.markers[0].transform)[i])).toBeLessThanOrEqual(0.5))
  })

  test('a fit centers the image on the fitted center', () => {
    const size = { width: 640, height: 360 }
    const want = fit([lot], { ...size, padding: 20, maxZoom: 19 })
    const m = mapModel({ ...base, center: undefined, fit: [lot], ...size })
    const href = m.image?.href ?? ''
    expect(href).toContain(`zoom=${want.zoom}&`)
    expect(Number(href.match(/center=([-\d.]+),/)?.[1])).toBeCloseTo(want.center.lat, 6)
  })

  test('a default zoom is capped at maxZoom and 19; an explicit one is used', () => {
    expect(mapModel({ ...base, basemap: { ...image, maxZoom: 17 } }).image?.href).toContain('zoom=17&')
    expect(mapModel({ ...base, zoom: 20 }).image?.href).toContain('zoom=20&')
  })

  test('refuses, never clamps: a box over maxSize, a zoom over maxZoom, a fractional size or zoom', () => {
    expect(() => mapModel({ ...base, width: 641 })).toThrow('over the basemap\'s maxSize of 640')
    expect(() => mapModel({ ...base, height: 700 })).toThrow('maxSize')
    expect(() => mapModel({ ...base, zoom: 21 })).toThrow('over the basemap\'s maxZoom of 20')
    expect(() => mapModel({ ...base, width: 500.5 })).toThrow('whole width and height')
    expect(() => mapModel({ ...base, zoom: 18.5 })).toThrow('whole zoom')
    expect(() => mapModel({ ...base, basemap: { ...image, scale: 0 } })).toThrow('scale')
  })

  test('refuses a template key with no value, and a basemap that is both kinds or neither', () => {
    expect(() => mapModel({ ...base, basemap: { image: 'https://api.test/{key}' } })).toThrow('{key}')
    expect(() => mapModel({ ...base, basemap: { ...image, tiles: '/t/{z}/{x}/{y}.png' } })).toThrow('not both')
    expect(() => mapModel(/** @type {any} */ ({ ...base, basemap: { attribution: 'x' } }))).toThrow('basemap is required')
  })

  test('an empty attribution stays empty', () => {
    expect(mapModel(base).attribution).toBe('')
  })
})
