/*
 * projection.test.js — every number here is Leaflet 1.9.4's, reimplemented from
 * its formulas (plan 0.3), not read back from this module. A rewrite that is
 * confidently wrong fails.
 */
import { describe, expect, test } from 'bun:test'
import { MAX_LATITUDE, TILE_SIZE, fit, project, tileUrl, unproject, view } from '../src/projection.js'

/** @param {number} a @param {number} b @param {number} tol */
const near = (a, b, tol) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol)

const NYC = { lat: 40.7128, lng: -74.006 }
const SYDNEY = { lat: -33.8688, lng: 151.2093 }

describe('project', () => {
  test('constants', () => {
    expect(TILE_SIZE).toBe(256)
    expect(MAX_LATITUDE).toBe(85.0511287798)
  })

  /** @type {[{ lat: number, lng: number }, number, number, number, number, number][]} */
  const rows = [
    [{ lat: 0, lng: 0 }, 0, 128, 128, 0, 0],
    [{ lat: 0, lng: 180 }, 0, 256, 128, 1, 0],
    [NYC, 10, 77182.475378, 98561.110379, 301, 385],
    [NYC, 17, 9879356.848356, 12615822.128454, 38591, 49280],
    [NYC, 20, 79034854.786844, 100926577.027633, 308729, 394244],
    [SYDNEY, 17, 30870944.262827, 20135754.6453, 120589, 78655],
  ]
  for (const [p, z, x, y, tx, ty] of rows) {
    test(`${p.lat}, ${p.lng} at z${z}`, () => {
      const w = project(p, z)
      near(w.x, x, 1e-6)
      near(w.y, y, 1e-6)
      expect([Math.floor(w.x / 256), Math.floor(w.y / 256)]).toEqual([tx, ty])
    })
  }

  test('latitude clamps inside project; the clamped y is not exactly 0', () => {
    const w = project({ lat: 89, lng: 10 }, 0)
    near(w.x, 135.111111, 1e-6)
    near(w.y, 0, 1e-9)
    expect(w.y).not.toBe(0)
    near(project({ lat: 89, lng: 0 }, 20).y, 5.7e-5, 1e-5)
    near(project({ lat: -90, lng: 0 }, 0).y, 256, 1e-9)
    expect(project({ lat: 89, lng: 10 }, 5)).toEqual(project({ lat: MAX_LATITUDE, lng: 10 }, 5))
  })

  test('project does not wrap longitude', () => {
    near(project({ lat: 0, lng: 181 }, 0).x, 256.711111, 1e-6)
    near(project({ lat: 0, lng: -181 }, 0).x, -0.711111, 1e-6)
  })

  test('the raw OSM slippy-map formula agrees with floor(project / 256)', () => {
    let seed = 20261122
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
    for (let i = 0; i < 4000; i++) {
      const lat = (rand() - 0.5) * 170
      const lng = (rand() - 0.5) * 360
      const z = Math.floor(rand() * 21)
      const n = 2 ** z
      const rad = (lat * Math.PI) / 180
      const osmX = Math.floor(((lng + 180) / 360) * n)
      const osmY = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n)
      const w = project({ lat, lng }, z)
      expect([Math.floor(w.x / 256), Math.floor(w.y / 256)]).toEqual([osmX, osmY])
    }
  })

  test('the raw OSM formula does not clamp: lat 89 at z0 is tile y -1', () => {
    const rad = (89 * Math.PI) / 180
    expect(Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * 1)).toBe(-1)
    expect(Math.floor(project({ lat: 89, lng: 0 }, 0).y / 256)).toBe(0)
  })

  test('refuses a non-number', () => {
    expect(() => project({ lat: NaN, lng: 0 }, 0)).toThrow(/lat/)
    expect(() => project({ lat: 0, lng: 0 }, Infinity)).toThrow(/zoom/)
  })
})

describe('unproject', () => {
  test('a round trip stays within 1e-9 degrees and 1e-6 px', () => {
    for (const p of [NYC, SYDNEY, { lat: 0, lng: 0 }, { lat: -85, lng: -179.9 }, { lat: 84, lng: 179.9 }]) {
      for (const z of [0, 3, 10, 17, 20]) {
        const w = project(p, z)
        const back = unproject(w, z)
        near(back.lat, p.lat, 1e-9)
        near(back.lng, p.lng, 1e-9)
        const again = project(back, z)
        near(again.x, w.x, 1e-6)
        near(again.y, w.y, 1e-6)
      }
    }
  })

  test('the center of the world is 0, 0', () => {
    const p = unproject({ x: 128, y: 128 }, 0)
    near(p.lat, 0, 1e-12)
    near(p.lng, 0, 1e-12)
  })
})

describe('view', () => {
  /** @param {ReturnType<typeof view>} v */
  const cols = (v) => [...new Set(v.tiles.map((t) => t.x))]
  /** @param {ReturnType<typeof view>} v */
  const rows = (v) => [...new Set(v.tiles.map((t) => t.y))]

  test('NYC at z17, 640x360: x 38589..38592, y 49279..49281, 12 tiles', () => {
    const v = view({ center: NYC, zoom: 17, width: 640, height: 360 })
    expect(cols(v)).toEqual([38589, 38590, 38591, 38592])
    expect(rows(v)).toEqual([49279, 49280, 49281])
    expect(v.tiles.length).toBe(12)
  })

  test('across the east antimeridian: x 6, 7, 0', () => {
    const v = view({ center: { lat: 0, lng: 179.5 }, zoom: 3, width: 512, height: 256 })
    expect(cols(v)).toEqual([6, 7, 0])
    expect(rows(v)).toEqual([3, 4])
  })

  test('across the west antimeridian: x 7, 0, 1', () => {
    const v = view({ center: { lat: 0, lng: -179.5 }, zoom: 3, width: 512, height: 256 })
    expect(cols(v)).toEqual([7, 0, 1])
    expect(rows(v)).toEqual([3, 4])
  })

  test('a wrapped tile is positioned by its unwrapped column', () => {
    const v = view({ center: { lat: 0, lng: 179.5 }, zoom: 3, width: 512, height: 256 })
    const lefts = v.tiles.filter((t) => t.y === 3).map((t) => t.left)
    expect(lefts[1] - lefts[0]).toBe(256)
    expect(lefts[2] - lefts[1]).toBe(256)
    const wrapped = v.tiles.find((t) => t.x === 0)
    expect(wrapped?.left).toBe(8 * 256 - v.origin.x)
  })

  test('z0 in 1024x768: y outside the world is skipped, five copies of (0, 0)', () => {
    const v = view({ center: { lat: 0, lng: 0 }, zoom: 0, width: 1024, height: 768 })
    expect(v.tiles.length).toBe(5)
    expect(v.tiles.every((t) => t.x === 0 && t.y === 0)).toBe(true)
    expect(new Set(v.tiles.map((t) => t.left)).size).toBe(5)
  })

  test('y -1 is skipped, never wrapped: 80, 0 at z2 gives 4 tiles', () => {
    const v = view({ center: { lat: 80, lng: 0 }, zoom: 2, width: 512, height: 512 })
    expect(cols(v)).toEqual([1, 2])
    expect(rows(v)).toEqual([0, 1])
    expect(v.tiles.length).toBe(4)
  })

  test('a max exactly on a tile edge adds none: z1 in 256x256 gives 4 tiles', () => {
    const v = view({ center: { lat: 0, lng: 0 }, zoom: 1, width: 256, height: 256 })
    expect(v.tiles.length).toBe(4)
  })

  test('origin is round(project(center) - size / 2), and toLayer subtracts it', () => {
    const v = view({ center: NYC, zoom: 17, width: 640, height: 360 })
    expect(v.origin).toEqual({ x: 9879037, y: 12615642 })
    const c = v.toLayer(NYC)
    near(c.x, 9879356.848356 - 9879037, 1e-6)
    near(c.y, 12615822.128454 - 12615642, 1e-6)
    near(c.x, 320, 0.5)
    near(c.y, 180, 0.5)
  })

  test('tiles and toLayer agree: a tile sits where the projection says', () => {
    const v = view({ center: NYC, zoom: 17, width: 640, height: 360 })
    const t = v.tiles[0]
    expect(t.left).toBe(t.x * 256 - v.origin.x)
    expect(t.top).toBe(t.y * 256 - v.origin.y)
    expect(t.size).toBe(256)
    expect(t.z).toBe(17)
    const p = v.toLayer(unproject({ x: t.x * 256, y: t.y * 256 }, 17))
    near(p.x, t.left, 1e-6)
    near(p.y, t.top, 1e-6)
  })

  test('every tile touches the window', () => {
    const v = view({ center: SYDNEY, zoom: 12, width: 500, height: 300 })
    for (const t of v.tiles) {
      expect(t.left + 256).toBeGreaterThan(0)
      expect(t.left).toBeLessThan(500)
      expect(t.top + 256).toBeGreaterThan(0)
      expect(t.top).toBeLessThan(300)
    }
  })

  test('refuses a zoom that is not a whole number of 0 or more', () => {
    for (const zoom of [-1, 1.5, NaN, Infinity]) {
      expect(() => view({ center: NYC, zoom, width: 100, height: 100 })).toThrow(/zoom/)
    }
  })

  test('refuses a non-positive or non-finite width or height', () => {
    for (const width of [0, -5, NaN, Infinity]) {
      expect(() => view({ center: NYC, zoom: 3, width, height: 100 })).toThrow(/width/)
    }
    for (const height of [0, -5, NaN, Infinity]) {
      expect(() => view({ center: NYC, zoom: 3, width: 100, height })).toThrow(/height/)
    }
  })
})

describe('fit', () => {
  // 100 m x 60 m, centered on 40.7, -74.
  const mx = 100 / (111320 * Math.cos((40.7 * Math.PI) / 180))
  const my = 60 / 110574
  const LOT = [-74 - mx / 2, 40.7 - my / 2, -74 + mx / 2, 40.7 + my / 2]
  const NYC_BOUNDS = [-74.2591, 40.4774, -73.7004, 40.9176]

  /** @param {number[]} bbox @param {number} width @param {number} height @param {number} padding */
  const rawZoom = (bbox, width, height, padding) => {
    const a = project({ lat: bbox[1], lng: bbox[0] }, 0)
    const b = project({ lat: bbox[3], lng: bbox[2] }, 0)
    return Math.log2(Math.min((width - 2 * padding) / (b.x - a.x), (height - 2 * padding) / (a.y - b.y)))
  }

  test('the lot: raw 19.27 gives 19, centered on the lot', () => {
    near(rawZoom(LOT, 640, 360, 20), 19.27, 0.01)
    const f = fit([LOT], { width: 640, height: 360, padding: 20, maxZoom: 20 })
    expect(f.zoom).toBe(19)
    near(f.center.lat, 40.7, 1e-8)
    near(f.center.lng, -74, 1e-8)
  })

  test('the lot with maxZoom 18 gives 18', () => {
    const f = fit([LOT], { width: 640, height: 360, padding: 20, maxZoom: 18 })
    expect(f.zoom).toBe(18)
    near(f.center.lat, 40.7, 1e-8)
  })

  test('NYC bounds: raw 10.41 gives 10, center 40.697864, -73.97975', () => {
    near(rawZoom(NYC_BOUNDS, 800, 600, 20), 10.41, 0.005)
    const f = fit([NYC_BOUNDS], { width: 800, height: 600, padding: 20, maxZoom: 20 })
    expect(f.zoom).toBe(10)
    near(f.center.lat, 40.697864, 1e-6)
    near(f.center.lng, -73.97975, 1e-6)
  })

  test('a single point returns maxZoom and the point', () => {
    const f = fit([{ lat: 40.7, lng: -74 }], { width: 500, height: 300, maxZoom: 20 })
    expect(f.zoom).toBe(20)
    near(f.center.lat, 40.7, 1e-9)
    near(f.center.lng, -74, 1e-9)
  })

  test('a lone point fits at the maxZoom it is given', () => {
    expect(fit([{ lat: 1, lng: 2 }], { width: 500, height: 300, maxZoom: 19 }).zoom).toBe(19)
  })

  test('the center is the midpoint in projected pixels, not in degrees', () => {
    const f = fit([{ lat: 10, lng: 0 }, { lat: 80, lng: 0 }], { width: 400, height: 400, maxZoom: 20 })
    const a = project({ lat: 10, lng: 0 }, 0)
    const b = project({ lat: 80, lng: 0 }, 0)
    near(project(f.center, 0).y, (a.y + b.y) / 2, 1e-9)
    expect(f.center.lat).not.toBe(45)
  })

  test('a point set, GeoJSON of every kind, and a bbox fit the same box', () => {
    const [w, s, e, n] = NYC_BOUNDS
    const opts = { width: 800, height: 600, padding: 20, maxZoom: 20 }
    const want = fit([NYC_BOUNDS], opts)
    const corners = [[w, s], [e, n]]
    const same = (/** @type {unknown[]} */ g) => {
      const f = fit(g, opts)
      expect(f.zoom).toBe(want.zoom)
      near(f.center.lat, want.center.lat, 1e-9)
      near(f.center.lng, want.center.lng, 1e-9)
    }
    same([{ lat: s, lng: w }, { lat: n, lng: e }])
    same([{ type: 'MultiPoint', coordinates: corners }])
    same([{ type: 'LineString', coordinates: corners }])
    same([{ type: 'MultiLineString', coordinates: [[[w, s]], [[e, n]]] }])
    same([{ type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] }])
    same([{ type: 'MultiPolygon', coordinates: [[[[w, s], [e, s], [w, n], [w, s]]], [[[e, n], [e, s], [w, n], [e, n]]]] }])
    same([{ type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [w, s] }, { type: 'Point', coordinates: [e, n] }] }])
    same([{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: corners } }])
    same([{ type: 'FeatureCollection', features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [w, s] } },
      { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [e, n] } },
    ] }])
    same([{ type: 'Point', coordinates: [w, s] }, { lat: n, lng: e }])
    same([[w, s, 0, e, n, 0]])
  })

  test('padding is subtracted from each side and the smaller axis wins', () => {
    // 100 px of padding leaves 200 x 100 of a 400 x 300 box; the height decides.
    const bbox = [-1, -1, 1, 1]
    const f = fit([bbox], { width: 400, height: 300, padding: 100, maxZoom: 20 })
    const a = project({ lat: -1, lng: -1 }, 0)
    const b = project({ lat: 1, lng: 1 }, 0)
    const raw = Math.log2(Math.min(200 / (b.x - a.x), 100 / (a.y - b.y)))
    expect(f.zoom).toBe(Math.floor(raw))
  })

  test('zoom clamps to [0, maxZoom]', () => {
    expect(fit([[-179, -80, 179, 80]], { width: 100, height: 100, maxZoom: 20 }).zoom).toBe(0)
    expect(fit([[-74.0001, 40.7, -74, 40.7001]], { width: 640, height: 360, maxZoom: 12 }).zoom).toBe(12)
  })

  /**
   * The fitted bounds, drawn through view() at the returned center and zoom,
   * lie inside the padded box on both axes.
   * @param {number[]} bbox @param {number} width @param {number} height @param {number} padding
   */
  const holds = (bbox, width, height, padding) => {
    const f = fit([bbox], { width, height, padding, maxZoom: 22 })
    const v = view({ center: f.center, zoom: f.zoom, width, height })
    for (const [lng, lat] of [[bbox[0], bbox[1]], [bbox[2], bbox[3]], [bbox[0], bbox[3]], [bbox[2], bbox[1]]]) {
      const p = v.toLayer({ lat, lng })
      expect(p.x).toBeGreaterThanOrEqual(padding - 1e-6)
      expect(p.x).toBeLessThanOrEqual(width - padding + 1e-6)
      expect(p.y).toBeGreaterThanOrEqual(padding - 1e-6)
      expect(p.y).toBeLessThanOrEqual(height - padding + 1e-6)
    }
    return f
  }

  test('the fitted bounds never overflow the padded box: the lot', () => {
    holds(LOT, 640, 360, 20)
  })

  test('the fitted bounds never overflow the padded box: raw 10.41', () => {
    holds(NYC_BOUNDS, 800, 600, 20)
  })

  test('the fitted bounds never overflow the padded box: raw 0.5% below a whole level', () => {
    // Leaflet rounds a zoom within 1% of the next level up, so this box
    // would overflow by 0.5% there.
    const k = 5
    const spanX = 560 / (2 ** k * 0.995)
    const a = unproject({ x: 128 - spanX / 2, y: 127.9995 }, 0)
    const b = unproject({ x: 128 + spanX / 2, y: 128.0005 }, 0)
    const bbox = [a.lng, b.lat, b.lng, a.lat]
    near(rawZoom(bbox, 600, 400, 20), k + Math.log2(0.995), 1e-9)
    expect(holds(bbox, 600, 400, 20).zoom).toBe(k - 1)
  })

  test('a box that fits at exactly a whole level is not dropped a level', () => {
    const a = unproject({ x: 128 - 100 / 2 ** 4, y: 128 - 50 / 2 ** 4 }, 0)
    const b = unproject({ x: 128 + 100 / 2 ** 4, y: 128 + 50 / 2 ** 4 }, 0)
    expect(fit([[a.lng, b.lat, b.lng, a.lat]], { width: 200, height: 100, maxZoom: 22 }).zoom).toBe(4)
  })

  test('refuses an empty geometries', () => {
    expect(() => fit([], { width: 100, height: 100, maxZoom: 5 })).toThrow(/geometries/)
  })

  test('refuses a bbox across the antimeridian, bare or on a GeoJSON object', () => {
    const opts = { width: 100, height: 100, maxZoom: 5 }
    expect(() => fit([[170, 0, -170, 10]], opts)).toThrow(/antimeridian/)
    expect(() => fit([{ type: 'Point', coordinates: [0, 0], bbox: [170, 0, -170, 10] }], opts)).toThrow(/antimeridian/)
    expect(() => fit([{ type: 'FeatureCollection', features: [], bbox: [170, 0, -170, 10] }], opts)).toThrow(/antimeridian/)
  })

  test('refuses a missing maxZoom, width or height', () => {
    expect(() => fit([[0, 0, 1, 1]], /** @type {any} */ ({ width: 100, height: 100 }))).toThrow(/maxZoom/)
    expect(() => fit([[0, 0, 1, 1]], /** @type {any} */ ({ height: 100, maxZoom: 5 }))).toThrow(/width/)
    expect(() => fit([[0, 0, 1, 1]], /** @type {any} */ ({ width: 100, maxZoom: 5 }))).toThrow(/height/)
  })

  test('refuses padding that leaves no room, and an unknown geometry', () => {
    expect(() => fit([[0, 0, 1, 1]], { width: 100, height: 100, padding: 50, maxZoom: 5 })).toThrow(/padding/)
    expect(() => fit([{ type: 'Circle' }], { width: 100, height: 100, maxZoom: 5 })).toThrow(/Circle/)
  })
})

describe('tileUrl', () => {
  const osm = { tiles: 'https://{s}.tile.example.org/{z}/{x}/{y}{r}.png', attribution: '', maxZoom: 19, tileSize: 256, subdomains: 'abc' }

  test('fills z, x, y, s and r', () => {
    expect(tileUrl(osm, 38591, 49280, 17)).toBe('https://b.tile.example.org/17/38591/49280.png')
    expect(tileUrl(osm, 38591, 49280, 17, { r: '@2x' })).toBe('https://b.tile.example.org/17/38591/49280@2x.png')
  })

  test('{s} is subdomains[abs(x + y) % n], for a string or an array', () => {
    expect(tileUrl(osm, 0, 0, 3)).toContain('//a.')
    expect(tileUrl(osm, 1, 0, 3)).toContain('//b.')
    expect(tileUrl(osm, 2, 0, 3)).toContain('//c.')
    expect(tileUrl(osm, 3, 0, 3)).toContain('//a.')
    expect(tileUrl({ ...osm, subdomains: ['one', 'two'] }, 1, 2, 3)).toContain('//two.')
    expect(tileUrl({ ...osm, subdomains: ['one', 'two'] }, 1, 1, 3)).toContain('//one.')
  })

  test('a template with no {s}, {r} or subdomains is fine', () => {
    expect(tileUrl({ tiles: 'https://t.example.org/{z}/{x}/{y}.png' }, 1, 2, 3)).toBe('https://t.example.org/3/1/2.png')
  })

  test('a key with no value throws, naming the key', () => {
    expect(() => tileUrl({ tiles: 'https://{s}.t.example.org/{z}/{x}/{y}.png' }, 1, 2, 3)).toThrow(/\{s\}/)
    expect(() => tileUrl({ tiles: 'https://t.example.org/{z}/{x}/{y}/{q}.png', subdomains: 'a' }, 1, 2, 3)).toThrow(/\{q\}/)
  })

  test('takes the wrapped column from view(), including across the antimeridian', () => {
    const v = view({ center: { lat: 0, lng: 179.5 }, zoom: 3, width: 512, height: 256 })
    const urls = v.tiles.map((t) => tileUrl({ tiles: '{z}/{x}/{y}' }, t.x, t.y, t.z))
    expect(urls).toEqual(['3/6/3', '3/7/3', '3/0/3', '3/6/4', '3/7/4', '3/0/4'])
  })
})

describe('purity', () => {
  test('there is no document and no window', () => {
    expect(typeof document === 'undefined' && typeof window === 'undefined').toBe(true)
  })
})
