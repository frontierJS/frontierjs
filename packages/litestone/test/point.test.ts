// `@point(lat, lng)` — where a row IS, declared on the field that holds it.
//
// Ruled in `IDEAS/geo.md` (`FJS-D316`, `FJS-D317`): a point is one Json value
// the caller writes and reads whole, with two VIRTUAL generated columns
// extracting the coordinate so a b-tree can prune on it. What is asserted here
// is the half that only a real database can answer — the emitted DDL is EXECUTED
// and offered rows, because every failure in this feature is a row that reads as
// *this has no location* rather than an error.
//
// The two that would otherwise pass silently, and are why the file exists:
//
//   1. A CHECK fails only on FALSE, so the natural spelling of the shape test
//      evaluates to NULL for an object with no `lat` and ACCEPTS it. Every
//      wrong-shaped row below is offered, not just the out-of-range one.
//   2. A WHERE that repeats `json_extract(...)` reads as a full SCAN even with
//      the index present — SQLite matches the COLUMN, not the expression — so
//      the plan is asserted rather than assumed.
//
// Every refusal is paired with the acceptance of a schema one attribute
// different (`FJS-351`).

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { parse, pointColumns, pointColumnNames } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'

const refuses = (schema: string, pattern: RegExp) => {
  const p = parse(schema)
  expect(p.valid).toBe(false)
  expect(p.errors.join('\n')).toMatch(pattern)
}
const accepts = (schema: string) => {
  const p = parse(schema)
  expect({ valid: p.valid, errors: p.errors }).toEqual({ valid: true, errors: [] })
  return p
}

const JOB = `model Job {
  id      Int     @id @default(autoincrement())
  address String
  site    Json?   @point(lat, lng)
}`

const openDb = (schema = JOB) => {
  const db = new Database(':memory:')
  db.run(generateDDL(accepts(schema).schema))
  return db
}

describe('the declaration', () => {
  it('accepts a point on a Json field', () => {
    accepts(JOB)
  })

  it('derives its column names from the field and the keys it was given', () => {
    expect(pointColumns('site', { lat: 'lat', lng: 'lng' })).toEqual(['siteLat', 'siteLng'])
    expect(pointColumns('depot', { lat: 'latitude', lng: 'longitude' }))
      .toEqual(['depotLatitude', 'depotLongitude'])
    expect(pointColumnNames('site', { lat: 'lat', lng: 'lng' })).toEqual({ lat: 'siteLat', lng: 'siteLng' })
  })

  it('takes the keys the app spells, not a convention', () => {
    const p = accepts(`model J { id Int @id\n  site Json @point(latitude, longitude) }`)
    const ddl = generateDDL(p.schema)
    expect(ddl).toContain(`"siteLatitude" REAL GENERATED ALWAYS AS (json_extract("site", '$.latitude')) VIRTUAL`)
  })

  it('allows several points on one model, because a crew has a depot and a last position', () => {
    const p = accepts(`model Crew {
      id       Int   @id
      depot    Json? @point(lat, lng)
      lastSeen Json? @point(lat, lng)
    }`)
    const ddl = generateDDL(p.schema)
    for (const col of ['depotLat', 'depotLng', 'lastSeenLat', 'lastSeenLng']) expect(ddl).toContain(`"${col}"`)
    expect(ddl).toContain('"idx_crew_depot"')
    expect(ddl).toContain('"idx_crew_lastSeen"')
  })
})

describe('what cannot be declared', () => {
  it('refuses a non-Json field, and accepts the same field as Json', () => {
    refuses(`model J { id Int @id\n  site String @point(lat, lng) }`, /@point requires a Json field, got String/)
    accepts(`model J { id Int @id\n  site Json @point(lat, lng) }`)
  })

  it('refuses one key named twice', () => {
    refuses(`model J { id Int @id\n  site Json @point(lat, lat) }`, /names one key twice/)
  })

  it('refuses a field whose bytes are not readable as JSON', () => {
    // json_extract over ciphertext answers NULL for every row, so the point
    // would be absent everywhere rather than refused once.
    refuses(`model J { id Int @id\n  site Json @encrypted @point(lat, lng) }`, /@point cannot be combined with @encrypted/)
    refuses(`model J { id Int @id\n  site Json @secret @point(lat, lng) }`,    /@point cannot be combined with @secret/)
  })

  it('refuses a field with no column to extract from', () => {
    refuses(`model J { id Int @id\n  site Json @computed @point(lat, lng) }`,  /@point needs a stored column and @computed is not one/)
    refuses(`model J { id Int @id\n  site Json @transient @point(lat, lng) }`, /@point needs a stored column and @transient is not one/)
  })

  it('refuses a derived column name the model already uses', () => {
    refuses(`model J { id Int @id\n  siteLat Float?\n  site Json @point(lat, lng) }`,
      /would derive a column 'siteLat'.*already declares a field with that name/s)
    accepts(`model J { id Int @id\n  siteHeight Float?\n  site Json @point(lat, lng) }`)
  })

  it('refuses keys a declared type does not carry, or carries as the wrong kind', () => {
    refuses(`type G { x Float\n  y Float }\nmodel J { id Int @id\n  site Json @type(G) @point(lat, lng) }`,
      /@point names 'lat', which type 'G' does not declare/)
    refuses(`type G { lat String\n  lng Float }\nmodel J { id Int @id\n  site Json @type(G) @point(lat, lng) }`,
      /declares as String — a coordinate is a number/)
    accepts(`type G { lat Float\n  lng Float\n  accuracy Float }\nmodel J { id Int @id\n  site Json @type(G) @point(lat, lng) }`)
  })
})

describe('the emitted table, executed', () => {
  it('extracts the coordinate into two VIRTUAL columns', () => {
    const db = openDb()
    db.prepare(`INSERT INTO job (address, site) VALUES (?, ?)`)
      .run('12 Elm', JSON.stringify({ lat: 40.71, lng: -100.23 }))
    expect(db.query(`SELECT siteLat, siteLng FROM job`).get())
      .toEqual({ siteLat: 40.71, siteLng: -100.23 })
  })

  it('keeps the columns honest when the JSON is updated in place', () => {
    const db = openDb()
    db.prepare(`INSERT INTO job (address, site) VALUES (?, ?)`).run('x', JSON.stringify({ lat: 1, lng: 2 }))
    db.run(`UPDATE job SET site = json_set(site, '$.lat', 41.0)`)
    expect((db.query(`SELECT siteLat FROM job`).get() as any).siteLat).toBe(41)
  })

  it('stores nothing for the generated columns — VIRTUAL, so the index holds the numbers', () => {
    const db = openDb()
    const cols = db.query(`SELECT name, hidden FROM pragma_table_xinfo('job')`).all() as any[]
    const lat = cols.find((c) => c.name === 'siteLat')
    // 2 is VIRTUAL in table_xinfo; 3 would be STORED.
    expect(lat.hidden).toBe(2)
  })

  const ROWS: Array<[string, string | null, boolean]> = [
    ['a point',            JSON.stringify({ lat: 40.71, lng: -100.23 }), true],
    ['no point at all',    null,                                          true],
    ['extra keys',         JSON.stringify({ lat: 1, lng: 2, acc: 5 }),    true],
    ['half set',           JSON.stringify({ lat: 40.71 }),                false],
    ['empty object',       '{}',                                          false],
    ['the wrong keys',     JSON.stringify({ latitude: 1, longitude: 2 }), false],
    ['a scalar',           '"hello"',                                     false],
    ['numbers as strings', JSON.stringify({ lat: '40.7', lng: '-100' }),  false],
    ['out of range',       JSON.stringify({ lat: 91, lng: 0 }),           false],
    ['malformed JSON',     '{oops',                                       false],
  ]

  for (const [label, value, ok] of ROWS) {
    it(`${ok ? 'stores' : 'refuses'} ${label}`, () => {
      const db = openDb()
      const write = () => db.prepare(`INSERT INTO job (address, site) VALUES (?, ?)`).run('x', value)
      if (ok) { write(); expect(db.query(`SELECT count(*) c FROM job`).get()).toEqual({ c: 1 }) }
      else expect(write).toThrow()
    })
  }

  it('refuses the wrong shape at the DATABASE, which is what asSystem() cannot drop', () => {
    // The naive spelling of this CHECK — without coalesce() — accepts every row
    // in this list, because a CHECK that evaluates to NULL passes. If this test
    // ever goes green with all four, the constraint has stopped constraining.
    const db = openDb()
    const bad = ['{}', JSON.stringify({ lat: 1 }), JSON.stringify({ latitude: 1, longitude: 2 }), '"hello"']
    for (const v of bad)
      expect(() => db.prepare(`INSERT INTO job (address, site) VALUES ('x', ?)`).run(v)).toThrow()
  })
})

describe('the index', () => {
  it('is earned by the declaration, without anybody writing @@index', () => {
    expect(generateDDL(accepts(JOB).schema))
      .toContain(`CREATE INDEX IF NOT EXISTS "idx_job_site" ON "job" ("siteLat", "siteLng")`)
  })

  it('is USED by a query that names the columns', () => {
    const db = openDb()
    const plan = db.query(
      `EXPLAIN QUERY PLAN SELECT id FROM job WHERE siteLat BETWEEN ? AND ? AND siteLng BETWEEN ? AND ?`)
      .all(1, 2, 1, 2).map((r: any) => r.detail).join(' ')
    expect(plan).toContain('USING INDEX idx_job_site')
  })

  it('is NOT used by a query that repeats the extraction — the reason the columns exist', () => {
    const db = openDb()
    const plan = db.query(
      `EXPLAIN QUERY PLAN SELECT id FROM job WHERE json_extract(site,'$.lat') BETWEEN ? AND ?`)
      .all(1, 2).map((r: any) => r.detail).join(' ')
    expect(plan).toContain('SCAN')
    expect(plan).not.toContain('USING INDEX')
  })

  it('is partial on a soft-deleting model, like every other index there', () => {
    const p = accepts(`model Job {
      id        Int      @id
      site      Json?    @point(lat, lng)
      deletedAt DateTime?
      @@softDelete
    }`)
    expect(generateDDL(p.schema)).toMatch(/"idx_job_site".*WHERE "deletedAt" IS NULL/)
  })
})

// ── the query half ──────────────────────────────────────────────────────────
//
// `near` is the one filter a point answers, and the gate on shipping it is that
// it is compared against a BRUTE-FORCE scan of the same rows — at the equator,
// across ±180° and at a pole. A prefilter that drops a row returns fewer rows
// with a 200, which is the failure this whole feature was designed around, and
// no test that only offers it the easy case can see it.

import { createClient, autoMigrate } from '../src/index.js'
import { distance } from '@frontierjs/toolbelt/geo'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GEO_SCHEMA = `model Place {
  id    Int    @id @default(autoincrement())
  name  String
  site  Json?  @point(lat, lng)
}`

const tmpRoot = mkdtempSync(join(tmpdir(), 'ls-point-'))
let dbSeq = 0

async function placesDb(rows: Array<{ name: string, site: any }>) {
  const db = await createClient({ schema: GEO_SCHEMA, db: join(tmpRoot, `p${dbSeq++}.db`) })
  await autoMigrate(db)
  for (const r of rows) await db.place.create({ data: r })
  return db
}

const LONDON = { lat: 51.5074, lng: -0.1278 }

describe('near', () => {
  it('filters by an exact radius, not by the box it pruned with', async () => {
    const db = await placesDb([
      { name: 'Westminster', site: { lat: 51.4995, lng: -0.1248 } },   // ~1 km
      { name: 'Camden',      site: { lat: 51.5390, lng: -0.1426 } },   // ~3.7 km
      { name: 'Croydon',     site: { lat: 51.3762, lng: -0.0982 } },   // ~15 km
      { name: 'Paris',       site: { lat: 48.8566, lng: 2.3522 } },    // ~343 km
      { name: 'nowhere',     site: null },
    ])
    // Sorted, because an unordered read comes back in INDEX order — ascending
    // latitude — which is itself evidence the index is being used, and is not
    // what this test is about.
    const within = async (r: string) =>
      (await db.place.findMany({ where: { site: { near: { ...LONDON, within: r } } } }))
        .map((p: any) => p.name).sort()

    expect(await within('2km')).toEqual(['Westminster'])
    expect(await within('5mi')).toEqual(['Camden', 'Westminster'])
    expect(await within('20km')).toEqual(['Camden', 'Croydon', 'Westminster'])
    // A row with no location is never near anything.
    expect(await within('400km')).not.toContain('nowhere')
  })

  it('orders nearest first, and the order is the QUERY\'s so a second page is right', async () => {
    const db = await placesDb([
      { name: 'Croydon',     site: { lat: 51.3762, lng: -0.0982 } },
      { name: 'Paris',       site: { lat: 48.8566, lng: 2.3522 } },
      { name: 'Westminster', site: { lat: 51.4995, lng: -0.1248 } },
      { name: 'Camden',      site: { lat: 51.5390, lng: -0.1426 } },
    ])
    const page = async (offset: number, limit: number) =>
      (await db.place.findMany({ orderBy: { site: { near: LONDON } }, offset, limit }))
        .map((p: any) => p.name)

    expect(await page(0, 2)).toEqual(['Westminster', 'Camden'])
    expect(await page(2, 2)).toEqual(['Croydon', 'Paris'])
    expect(await page(0, 4)).toEqual(['Westminster', 'Camden', 'Croydon', 'Paris'])
  })

  it('reads the point back as the value that was written', async () => {
    const db = await placesDb([{ name: 'Camden', site: { lat: 51.539, lng: -0.1426 } }])
    const row = await db.place.findFirst({ where: { name: 'Camden' } })
    expect(row.site).toEqual({ lat: 51.539, lng: -0.1426 })
  })

  it('finds the rows that have no location', async () => {
    const db = await placesDb([
      { name: 'here',    site: { lat: 1, lng: 2 } },
      { name: 'nowhere', site: null },
    ])
    expect((await db.place.findMany({ where: { site: null } })).map((p: any) => p.name)).toEqual(['nowhere'])
  })
})

describe('near, graded against a brute-force scan', () => {
  // The three places a bounding box is wrong if it is wrong at all. Each fixture
  // straddles the circle's edge, so a prefilter that clips it is visible.
  const CASES: Array<[string, { lat: number, lng: number }, number]> = [
    ['at the equator',    { lat: 0.5,  lng: 0.5 },   30_000],
    ['across ±180',       { lat: 10,   lng: 179.9 }, 60_000],
    ['near a pole',       { lat: 89.4, lng: 20 },    80_000],
    ['at mid latitude',   { lat: 51.5, lng: -0.12 }, 25_000],
  ]

  for (const [label, center, metres] of CASES) {
    it(label, async () => {
      const span = (metres / 6_371_008.8) * (180 / Math.PI) * 2.5
      const rows: Array<{ name: string, site: any }> = []
      const side = 12
      for (let i = 0; i < side; i++) {
        for (let j = 0; j < side; j++) {
          const lat = center.lat - span + (2 * span * i) / (side - 1)
          const lng = center.lng - span + (2 * span * j) / (side - 1)
          if (lat < -90 || lat > 90) continue
          rows.push({ name: `${i}-${j}`, site: { lat, lng: ((lng + 540) % 360) - 180 } })
        }
      }
      const db = await placesDb(rows)
      const sql = (await db.place.findMany({
        where: { site: { near: { ...center, within: `${metres}m` } } },
      })).map((p: any) => p.name).sort()
      const brute = rows.filter(r => distance(r.site, center) <= metres).map(r => r.name).sort()

      expect(brute.length).toBeGreaterThan(8)   // the fixture must actually straddle the edge
      expect(sql).toEqual(brute)
    })
  }
})

// ── off the wire ────────────────────────────────────────────────────────────
//
// A URL carries text, and `@frontierjs/toolbelt/query` turns a coordinate back
// into a number only when it ROUND-TRIPS (`String(Number(v)) === v`) — which is
// the right rule with no model in the room, and which `51.507400` fails. That
// spelling is not exotic: it is what `toFixed(6)` writes, and what almost every
// GPS reading in a URL looks like. The kit's own stated answer for that case is
// that the model has the last word, and `@point(lat, lng)` IS the model saying
// these two keys are Floats — so the reading is here.

describe('a center off a query string', () => {
  const asWire = (o: any) => JSON.parse(JSON.stringify(o, (_k, v) =>
    typeof v === 'number' ? v.toFixed(6) : v))

  it('reads a fixed-precision coordinate as the Float the column is', async () => {
    const db = await placesDb([
      { name: 'Westminster', site: { lat: 51.4995, lng: -0.1248 } },
      { name: 'Edinburgh',   site: { lat: 55.9533, lng: -3.1883 } },
    ])
    const near = { ...asWire(LONDON), within: '5mi' }
    expect(near.lat).toBe('51.507400')            // the pinning: it really is text

    const rows = await db.place.findMany({ where: { site: { near } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Westminster'])
  })

  it('orders by a text center the same way it filters by one', async () => {
    const db = await placesDb([
      { name: 'Edinburgh',   site: { lat: 55.9533, lng: -3.1883 } },
      { name: 'Westminster', site: { lat: 51.4995, lng: -0.1248 } },
      { name: 'Camden',      site: { lat: 51.5390, lng: -0.1426 } },
    ])
    const rows = await db.place.findMany({ orderBy: { site: { near: asWire(LONDON) } } })
    expect(rows.map((r: any) => r.name)).toEqual(['Westminster', 'Camden', 'Edinburgh'])
  })

  it('does not read an empty coordinate as the Gulf of Guinea', async () => {
    // `?site[near][lat]=` arrives as '' and `Number('')` is 0, so the one
    // coercion that must NOT happen is the one a bare `Number()` would make.
    const db = await placesDb([{ name: 'a', site: { lat: 0, lng: 0 } }])
    await expect(db.place.findMany({
      where: { site: { near: { lat: '', lng: '', within: '5mi' } } },
    })).rejects.toThrow(/numeric lat and lng/)
  })
})

describe('what a point refuses', () => {
  const refusesQuery = async (query: any, pattern: RegExp) => {
    const db = await placesDb([{ name: 'a', site: { lat: 1, lng: 2 } }])
    await expect(db.place.findMany(query)).rejects.toThrow(pattern)
  }

  it('refuses every filter but near, because JSON compares as text', async () => {
    await refusesQuery({ where: { site: { equals: 'x' } } },   /"equals" cannot be asked of "site"/)
    await refusesQuery({ where: { site: { contains: 'x' } } }, /"contains" cannot be asked of "site"/)
    await refusesQuery({ where: { site: { gt: 5 } } },         /"gt" cannot be asked of "site"/)
  })

  it('refuses a bare comparison, and says what to ask instead', async () => {
    await refusesQuery({ where: { site: 'x' } }, /is a @point and cannot be compared to a value/)
  })

  it('refuses a malformed near', async () => {
    await refusesQuery({ where: { site: { near: { lat: 1, lng: 2 } } } },  /needs a radius/)
    await refusesQuery({ where: { site: { near: { lat: 1, within: '5mi' } } } }, /numeric lat and lng/)
    await refusesQuery({ where: { site: { near: { lat: 'north', lng: 2, within: '5mi' } } } }, /numeric lat and lng/)
    await refusesQuery({ where: { site: { near: 'over there' } } },        /takes \{ lat, lng, within \}/)
    await refusesQuery({ where: { site: { near: { lat: 1, lng: 2, within: '5 parsecs' } } } }, /unknown unit/)
    await refusesQuery({ where: { site: { near: { lat: 1, lng: 2, within: '5' } } } }, /number and a unit/)
  })

  it('refuses sorting the document, and points at the shape that works', async () => {
    await refusesQuery({ orderBy: { site: 'asc' } }, /Cannot orderBy 'site'/)
    await refusesQuery({ orderBy: { site: { near: { lat: 'x', lng: 2 } } } }, /needs a numeric lat and lng/)
  })
})

// ── paging a distance order ─────────────────────────────────────────────────
//
// A nearest-first list is exactly the screen that scrolls, so the cursor is the
// half of `FJS-D321` that decides whether the ordering is worth having. Two
// defects lived here and both answered 200:
//
//   - `normalizeOrderBy` dropped a near order, so the page resumed from the
//     TIEBREAK alone — each page was an id-window re-sorted, and on seven rows
//     the nearest one arrived on page two;
//   - the distance expression is NULL for a row with no location and SQLite
//     sorts a NULL first ascending, so the nearest place to London was the row
//     with no coordinate at all.

describe('a distance order paginates', () => {
  const SCRAMBLED = [
    { name: 'Edinburgh',   site: { lat: 55.9533, lng: -3.1883 } },
    { name: 'Camden',      site: { lat: 51.5390, lng: -0.1426 } },
    { name: 'Brighton',    site: { lat: 50.8225, lng: -0.1372 } },
    { name: 'Westminster', site: { lat: 51.4995, lng: -0.1248 } },
    { name: 'Nowhere',     site: null },
    { name: 'Reading',     site: { lat: 51.4543, lng: -0.9781 } },
    { name: 'Croydon',     site: { lat: 51.3762, lng: -0.0982 } },
  ]
  const nearest = { site: { near: LONDON } }

  it('puts a row with no location last, not first', async () => {
    const db = await placesDb(SCRAMBLED)
    const rows = await db.place.findMany({ orderBy: nearest })
    expect(rows[rows.length - 1].name).toBe('Nowhere')
    expect(rows[0].name).toBe('Westminster')
  })

  it('walks the whole list in the order the unpaginated read gives', async () => {
    // The gate. Insertion order is deliberately not distance order, so a cursor
    // paging by the tiebreak alone cannot accidentally agree.
    const db = await placesDb(SCRAMBLED)
    const want = (await db.place.findMany({ orderBy: nearest })).map((r: any) => r.name)

    const got: string[] = []
    let cursor: string | null = null
    for (let i = 0; i < 20; i++) {
      const page: any = await db.place.findManyCursor({
        limit: 2, orderBy: nearest, ...(cursor ? { cursor } : {}),
      })
      got.push(...page.items.map((r: any) => r.name))
      if (!page.hasMore) break
      cursor = page.nextCursor
    }
    expect(got).toEqual(want)
    expect(got.length).toBe(SCRAMBLED.length)   // no row served twice, none lost
  })

  it('compares the cursor with the same expression it orders by', async () => {
    // The cursor carries the POINT and not a distance, and that is what makes
    // the tie exact: a number computed here differs from SQLite's haversine in
    // the last bits, and one ulp serves the cursor's own row a second time.
    // Measured before the fix: page two opened with the row page one ended on.
    const db = await placesDb(SCRAMBLED)
    const p1: any = await db.place.findManyCursor({ limit: 2, orderBy: nearest })
    const token = JSON.parse(Buffer.from(p1.nextCursor, 'base64url').toString('utf8'))
    expect(token.site).toEqual({ at: [LONDON.lat, LONDON.lng], p: [51.5390, -0.1426] })

    const p2: any = await db.place.findManyCursor({ limit: 2, orderBy: nearest, cursor: p1.nextCursor })
    expect(p2.items.map((r: any) => r.name)).toEqual(['Croydon', 'Reading'])
  })

  it('refuses a cursor minted around a different center', async () => {
    // A distance order means nothing without one, so a caller who moved the map
    // between pages is resuming into an ordering that never existed.
    const db = await placesDb(SCRAMBLED)
    const p1: any = await db.place.findManyCursor({ limit: 2, orderBy: nearest })
    await expect(db.place.findManyCursor({
      limit: 2, cursor: p1.nextCursor,
      orderBy: { site: { near: { lat: 53.4808, lng: -2.2426 } } },
    })).rejects.toThrow(/resumes only from its own center/)
  })

  it('round-trips through the window junction actually mints', async () => {
    // Junction's `find` walks an ordinary page in `orderTotal`'s ordering and
    // mints the first window's edge off its last row, so that ordering is the
    // SCAN's and not a description of it. Collapsed to `{ site: 'asc' }` it
    // names the one spelling a point refuses: the ordinary page 400s and the
    // window is never minted.
    const db = await placesDb(SCRAMBLED)
    const ordered: any = db.place.orderTotal(nearest)
    expect(ordered[0].site.near).toEqual(LONDON)

    const rows: any = await db.place.findMany({ orderBy: ordered, limit: 3 })
    expect(rows.map((r: any) => r.name)).toEqual(['Westminster', 'Camden', 'Croydon'])

    const edge = db.place.cursorFor(rows[rows.length - 1], ordered)
    const next: any = await db.place.findManyCursor({ limit: 3, orderBy: ordered, cursor: edge })
    expect(next.items.map((r: any) => r.name)).toEqual(['Reading', 'Brighton', 'Edinburgh'])
  })

  it('pages furthest-first too', async () => {
    const db = await placesDb(SCRAMBLED)
    const p1: any = await db.place.findManyCursor({ limit: 2, orderBy: { site: { near: LONDON, dir: 'desc' } } })
    expect(p1.items.map((r: any) => r.name)).toEqual(['Edinburgh', 'Brighton'])
    const p2: any = await db.place.findManyCursor({
      limit: 2, orderBy: { site: { near: LONDON, dir: 'desc' } }, cursor: p1.nextCursor,
    })
    expect(p2.items.map((r: any) => r.name)).toEqual(['Reading', 'Croydon'])
  })
})
