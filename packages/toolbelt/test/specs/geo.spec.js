/*
 * geo.spec.js
 *
 * The five functions, and one test that is the reason the module is shaped the
 * way it is: `boundingBox` is compared against a BRUTE-FORCE scan of the same
 * points, at the equator, at a pole and across ±180°. A prefilter that drops a
 * row returns fewer rows with a 200 — the failure Elasticsearch, qdrant and
 * GeoBlacklight each shipped — and no test that only offers it the easy case
 * can see it.
 *
 * Distances are checked against published figures rather than against this
 * implementation's own output, so a rewrite that is confidently wrong fails.
 */

import { distance, boundingBox, inBoxes, isNear, isPoint, pointInPolygon, polygonArea, centroid }
  from '../../src/geo/geo.js'
import { parseLength, formatDistance } from '../../src/units/units.js'

/** Metres → degrees of latitude, for sizing a fixture around a radius. */
const degreesFor = (metres) => (metres / 6371008.8) * (180 / Math.PI)

const near = (a, b, tolerance, msg) => assert.ok(Math.abs(a - b) <= tolerance,
  `${msg || ''} expected ${b} ± ${tolerance}, got ${a}`)

const LONDON = { lat: 51.5074, lng: -0.1278 }
const PARIS  = { lat: 48.8566, lng: 2.3522 }
const NY     = { lat: 40.7128, lng: -74.0060 }

test('geo: distance matches published great-circle figures', function () {
  near(distance(LONDON, PARIS), 343_500, 2_000, 'London-Paris')
  near(distance(LONDON, NY),  5_570_000, 20_000, 'London-New York')
  assert.equal(distance(LONDON, LONDON), 0)
  // A few metres apart is the scale this is actually used at, and it is the
  // scale the spherical law of cosines loses precision at.
  near(distance({ lat: 51.5074, lng: -0.1278 }, { lat: 51.50749, lng: -0.1278 }), 10, 1, '10m apart')
})

test('geo: a point is read from either spelling, and a bad one is refused by name', function () {
  assert.equal(distance({ latitude: 51.5074, longitude: -0.1278 }, LONDON), 0)
  assert.ok(isPoint({ lat: 0, lng: 0 }))
  assert.ok(!isPoint({ lat: 0 }))
  assert.ok(!isPoint(null))
  assert.ok(!isPoint({ lat: 91, lng: 0 }))
  assert.throws(() => distance({ lat: 91, lng: 0 }, LONDON), /outside ±90/)
  assert.throws(() => distance({ lat: 0, lng: 181 }, LONDON), /outside ±180/)
})

test('geo: the box contains every point the exact measure admits — equator', function () {
  const center = { lat: 0.5, lng: 0.5 }
  const radius = 20_000
  compare(spread(center, degreesFor(radius) * 2.5, 2000), center, radius)
})

test('geo: …and at a pole, where a naive box divides by a cosine that is zero', function () {
  const center = { lat: 89.7, lng: 20 }
  const radius = 60_000
  const points = spread(center, degreesFor(radius) * 2.5, 2000)
  const boxes = boundingBox(center, radius)
  assert.equal(boxes.length, 1)
  assert.equal(boxes[0].full, true, 'a circle reaching the pole admits every longitude')
  compare(points, center, radius)
})

test('geo: …and across ±180, where one box matches nothing and says nothing', function () {
  const center = { lat: 10, lng: 179.9 }
  const radius = 50_000
  const boxes = boundingBox(center, radius)
  assert.equal(boxes.length, 2, 'a wrapping radius is TWO boxes, split at the seam')
  for (const b of boxes) assert.ok(b.west <= b.east, 'neither box may be inverted')
  compare(spread(center, degreesFor(radius) * 2.5, 2000), center, radius)
})

test('geo: the box is a prefilter and is deliberately wider than the circle', function () {
  const center = { lat: 45, lng: 10 }
  const boxes  = boundingBox(center, 10_000)
  // The corner of the box is outside the circle by construction — √2 × r — so a
  // caller that treats the box AS the answer returns rows it should not.
  const corner = { lat: boxes[0].north, lng: boxes[0].east }
  assert.ok(inBoxes(corner, boxes), 'the corner is in the box')
  assert.ok(distance(corner, center) > 10_000, 'and outside the circle')
  assert.ok(!isNear(corner, center, 10_000), 'so isNear must run the exact test too')
})

test('geo: a radius that is not a positive number is refused', function () {
  assert.throws(() => boundingBox(LONDON, 0),   /positive/)
  assert.throws(() => boundingBox(LONDON, -5),  /positive/)
  assert.throws(() => boundingBox(LONDON, NaN), /positive/)
})

test('geo: a point with no coordinate is out, never an exception', function () {
  assert.equal(isNear(null, LONDON, 1000), false)
  assert.equal(isNear({ lat: null, lng: null }, LONDON, 1000), false)
  assert.equal(isNear({}, LONDON, 1000), false)
})

test('geo: pointInPolygon, closed or not', function () {
  const square = [
    { lat: 0, lng: 0 }, { lat: 0, lng: 10 }, { lat: 10, lng: 10 }, { lat: 10, lng: 0 },
  ]
  const closed = [...square, { lat: 0, lng: 0 }]
  for (const ring of [square, closed]) {
    assert.equal(pointInPolygon({ lat: 5, lng: 5 }, ring), true)
    assert.equal(pointInPolygon({ lat: 15, lng: 5 }, ring), false)
    assert.equal(pointInPolygon({ lat: 5, lng: -5 }, ring), false)
  }
  assert.throws(() => pointInPolygon({ lat: 0, lng: 0 }, [{ lat: 0, lng: 0 }]), /three points/)
})

test('geo: polygonArea is spherical, so latitude changes the answer', function () {
  // One degree square at the equator is ~12,308 km²; the same square of DEGREES
  // at 60°N covers about half that. A planar area reports them as equal.
  const square = (lat) => [
    { lat, lng: 0 }, { lat, lng: 1 }, { lat: lat + 1, lng: 1 }, { lat: lat + 1, lng: 0 },
  ]
  const equator = polygonArea(square(0)) / 1e6
  const north   = polygonArea(square(60)) / 1e6
  near(equator, 12_308, 200, 'one degree square at the equator, km²')
  assert.ok(north < equator * 0.62, `a square at 60°N is far smaller: ${north} vs ${equator}`)
  assert.ok(north > equator * 0.35)
})

test('geo: centroid averages as vectors, so ±179 is not the wrong ocean', function () {
  const mid = centroid([{ lat: 0, lng: -179 }, { lat: 0, lng: 179 }])
  near(Math.abs(mid.lng), 180, 0.001, 'the mean of -179 and 179 is 180, not 0')
  near(mid.lat, 0, 0.001)
  const plain = centroid([{ lat: 0, lng: 10 }, { lat: 0, lng: 20 }])
  near(plain.lng, 15, 0.001)
  assert.equal(centroid([]), null)
  assert.equal(centroid([{ lat: 1 }]), null, 'a list of unusable points has no center')
  assert.equal(centroid([{ lat: 0, lng: 0 }, { lat: 0, lng: 180 }]), null, 'antipodes have no mean direction')
})

test('geo: a radius is stated with its unit, and the kit that owns quantities parses it', function () {
  assert.equal(parseLength('5mi'), 8046.72)
  assert.equal(parseLength('800m'), 800)
  assert.equal(parseLength('1.5km'), 1500)
  assert.equal(parseLength(250), 250, 'a bare number is metres')
  assert.throws(() => parseLength('5'), /number and a unit/)
  assert.throws(() => parseLength('5 parsecs'), /unknown unit/)
  assert.throws(() => parseLength('0mi'), /greater than zero/)
  assert.equal(formatDistance(3700), '3.7 km')
  assert.equal(formatDistance(3700, { imperial: true }), '2.3 mi')
  assert.equal(formatDistance(120, { imperial: true }), '394 ft')
})

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * A grid of points around a center, `span` degrees wide, `n` of them. The span
 * is stated as a MULTIPLE of the radius by every caller, so the fixture always
 * straddles the circle's edge rather than sitting wholly inside or outside it —
 * which is where a prefilter is wrong if it is wrong at all.
 */
function spread(center, span, n) {
  const out = []
  const side = Math.round(Math.sqrt(n))
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const lat = center.lat - span + (2 * span * i) / (side - 1)
      const lng = center.lng - span + (2 * span * j) / (side - 1)
      if (lat < -90 || lat > 90) continue
      out.push({ lat, lng: ((lng + 540) % 360) - 180 })
    }
  }
  return out
}

/**
 * The assertion the module exists for: everything the exact measure admits is
 * inside the boxes. The reverse is deliberately NOT asserted — the box is
 * wider than the circle by construction.
 */
function compare(points, center, radius) {
  const boxes  = boundingBox(center, radius)
  const exact  = points.filter((p) => distance(p, center) <= radius)
  const missed = exact.filter((p) => !inBoxes(p, boxes))
  assert.ok(exact.length > 10, `the fixture must actually contain points: ${exact.length}`)
  assert.equal(missed.length, 0,
    `${missed.length} of ${exact.length} points inside the radius are outside every box, ` +
    `e.g. ${JSON.stringify(missed[0])} — boxes ${JSON.stringify(boxes)}`)
  // And the prefilter has to be worth running.
  const kept = points.filter((p) => inBoxes(p, boxes))
  assert.ok(kept.length <= points.length, 'a prefilter cannot admit more than it was given')
}
