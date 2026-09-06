// introspect-roundtrip.test.ts — can litestone read back what litestone wrote?
//
// `litestone introspect` is the adoption door: point it at a database you
// already have and get a `.lite` to start from. `fli db:pull` is the same
// function. Its output had been asserted for its whole life with `toContain` —
// six tests, every one of them a substring match — and not one of them ever fed
// the result back to `parse()`. So the emitter produced a file litestone could
// not read, and the tests were green throughout:
//
//   `references: [id] onDelete: CASCADE`   no comma, and SQLite's word for an
//                                          action where the parser wants Prisma's
//   `@@softDelete` + `@@index([deletedAt])`  the same index declared twice —
//                                          refused BY NAME since FJS-480, which
//                                          added the rule and never asked who
//                                          was producing the pair
//   `@default("lower(hex(randomblob(4)))…")` an EXPRESSION emitted as a string
//                                          literal, so every row written after
//                                          it gets 200 characters of SQL instead
//                                          of a uuid — and `ddl.js` doubles the
//                                          quotes inside it, so the text grows a
//                                          level on every pass
//   `@@index([x], where: deletedAt == null && …)`  @@softDelete's own clause,
//                                          which `createIndexes` ANDs back on,
//                                          so the predicate nests one deeper
//                                          each time until it stops being
//                                          readable at all
//
// Four defects, one property. The property is the point of this file: assert the
// FIXPOINT and every emitter defect of this class is caught at once, where a
// substring assertion catches only the one somebody thought of.
//
// ── Why the second pass and not the first ────────────────────────────────────
//
// Pass 1 reads a database built from a hand-written schema, whose model order is
// the order somebody typed. Pass 2 reads a database built from pass 1's output.
// The two differ in ORDER alone, which is not a defect — so the fixed point is
// `lite(2) === lite(3)`, and it is a real assertion rather than a weakened one:
// it fails on anything that changes with each reading, which is exactly the
// class the doubled predicate and the growing quotes belong to.

import { describe, test, expect } from 'bun:test'
import { Database }               from 'bun:sqlite'
import { readFileSync, existsSync } from 'node:fs'
import { join }                   from 'node:path'

import { parse }                      from '../src/core/parser.js'
import { generateDDL }                from '../src/core/ddl.js'
import { splitStatements }            from '../src/core/migrate.js'
import { introspectToLite, generateLiteSchema } from '../src/tools/introspect.js'
import { COMMITTED, FETCHED, SCALE } from './fixtures/corpus/tiers.js'

// ─── the harness ─────────────────────────────────────────────────────────────

// A database built from `.lite` text. Foreign keys off: the corpus schemas are
// conversion output and some carry a relation to a model their source did not
// export, which is a fact about the corpus and not about this emitter.
function build(src: string) {
  const p = parse(src)
  if (!p.schema) return { db: null, errors: p.errors ?? [] }
  const db = new Database(':memory:')
  db.exec('PRAGMA foreign_keys=OFF')
  const failed: string[] = []
  for (const st of splitStatements(generateDDL(p.schema))) {
    try { db.exec(st) } catch (e: any) { failed.push(String(e?.message).slice(0, 90)) }
  }
  return { db, errors: [], failed }
}

// schema text → the database → `.lite` → the database again → `.lite`.
// Both readings, so a caller can assert the fixed point and read pass 1 for the
// defect it is about.
function roundTrip(src: string) {
  const a = build(src)
  if (!a.db) throw new Error(`source did not parse: ${a.errors.slice(0, 2).join(' | ')}`)
  const one = introspectToLite(a.db)

  const b = build(one.lite)
  if (!b.db) throw new Error(
    `introspect wrote a .lite litestone cannot read: ${b.errors.slice(0, 2).join(' | ')}`)
  const two = introspectToLite(b.db)

  const c = build(two.lite)
  if (!c.db) throw new Error(
    `the second pass wrote a .lite litestone cannot read: ${c.errors.slice(0, 2).join(' | ')}`)
  const three = introspectToLite(c.db)

  return { one, two, three, ddlFailures: [...(a.failed ?? []), ...(b.failed ?? []), ...(c.failed ?? [])] }
}

// ─── the property, over input nobody here wrote ──────────────────────────────

// The roster is `fixtures/corpus/tiers.js` and may not be restated here: this
// file held its own copy, and the copy is what made the suite unpassable on a
// fresh clone (`FJS-009`). The tiers are the point — a fetched fixture is absent
// on every clone and present on every machine that has run `fetch.mjs`, so a
// floor built on the two together is a floor only some machines can meet.
const FIXTURES = new URL('./fixtures/', import.meta.url).pathname
const litePath = (tier: string, n: string) => join(FIXTURES, tier, `${n}.lite`)

const REQUIRED = [
  ...COMMITTED.map(n => litePath('corpus', n)),
  ...SCALE.map(n     => litePath('scale',  n)),
]
const CORPUS = [...REQUIRED, ...FETCHED.map(n => litePath('corpus', n))].filter(existsSync)

describe('a generated schema builds the database it was read from', () => {
  // An empty sweep is not a passing one — and the floor is what git carries,
  // derived from the roster rather than written as a number. The literal it
  // replaces was 8, which counted the fetched pair and therefore could not be
  // met by a clone.
  test('every committed fixture is here, and is swept', () => {
    const missing = REQUIRED.filter(p => !existsSync(p))
    expect(missing).toEqual([])
    // The other half, and the one a count cannot ask: a fixture that IS
    // committed and that no list names is swept by nothing. `hrms` was exactly
    // that — in git, absent from this file's own copy of the roster.
    for (const p of REQUIRED) expect(CORPUS).toContain(p)
  })

  // Named rather than silently not run, the way `corpus.test.ts` does it: a
  // fetched fixture missing is a machine with no network, not a defect.
  for (const n of FETCHED) {
    const path = litePath('corpus', n)
    if (!existsSync(path))
      test.skip(`${n}: not fetched — run \`bun test/fixtures/corpus/fetch.mjs\``, () => {})
  }

  for (const path of CORPUS) {
    const name = path.split('/').slice(-1)[0]

    // Three round trips over 534 models is genuinely seconds of work, and the
    // default 5000ms is close enough to it that whether this passes depends on
    // what else the run is doing — it went red when an unrelated file was added
    // beside it, having taken 5432ms.
    test(`${name}: the output parses, and reading it again is a fixed point`, () => {
      const src = readFileSync(path, 'utf8')
      const { two, three } = roundTrip(src)
      // The whole file, not a line count: a converter whose output moves on its
      // own is one nobody can re-run and diff.
      expect(three.lite).toBe(two.lite)
    }, 30000)
  }
})

// ─── the four defects, each on its own ───────────────────────────────────────
//
// The property above catches all four. These name them, so a failure says which
// one came back rather than "the fixed point broke".

describe('a referential action survives the round trip', () => {
  const src = `
model Author {
  id    Int    @id
  name  String
  books Book[]
}
model Book {
  id       Int     @id
  title    String
  author   Author  @relation(fields: [authorId], references: [id], onDelete: Cascade)
  authorId Int
}
`
  test('the comma before onDelete is there', () => {
    const { one } = roundTrip(src)
    expect(one.lite).toContain('references: [id], onDelete: Cascade')
  })

  test('the action is spelled the way the parser reads it, not the way SQLite does', () => {
    const { one } = roundTrip(src)
    // ddl.js writes `SETNULL` out as `SET NULL`; nothing read it back, so every
    // generated relation named an action ON_DELETE_ACTIONS refuses.
    expect(one.lite).not.toContain('CASCADE')
    expect(one.lite).not.toContain('SET NULL')
  })

  for (const [declared, expected] of [['Cascade', 'Cascade'], ['SetNull', 'SetNull'], ['Restrict', 'Restrict']]) {
    test(`onDelete: ${declared} comes back as ${expected}`, () => {
      const one = roundTrip(`
model P { id Int @id  cs C[] }
model C {
  id  Int  @id
  p   P?   @relation(fields: [pId], references: [id], onDelete: ${declared})
  pId Int?
}
`).one
      expect(one.lite).toContain(`onDelete: ${expected}`)
    })
  }
})

describe('@@softDelete does not declare its own index twice', () => {
  const src = `
model Note {
  id        Int       @id
  body      String
  deletedAt DateTime?
  @@softDelete
}
`
  test('the index @@softDelete builds is not restated as @@index', () => {
    const { one } = roundTrip(src)
    expect(one.lite).toContain('@@softDelete')
    // Both are named idx_note_deletedAt, so declaring both is refused by name
    // (FJS-480) — the rule landed and nothing asked who was emitting the pair.
    expect(one.lite).not.toContain('@@index([deletedAt])')
  })

  test('an index on another column keeps its predicate stripped of the soft-delete clause', () => {
    // createIndexes ANDs `"deletedAt" IS NULL` onto every index on the model, so
    // the stored predicate is never the declared one. Emitting it whole means
    // the next migration ANDs it on again, one level deeper each pass.
    const { one, two } = roundTrip(`
model Item {
  id        Int       @id
  active    Boolean   @default(true)
  ownerId   Int
  deletedAt DateTime?
  @@softDelete
  @@index([ownerId], where: active == true)
}
`)
    expect(one.lite).toContain('@@index([ownerId], where: active == true)')
    expect(two.lite).toBe(one.lite)
  })
})

describe('a default is read back as what it is', () => {
  test('a uuid() default is a uuid() default, not 200 characters of SQL', () => {
    const { one, two } = roundTrip(`
model Doc {
  id    String @id @default(uuid())
  title String
}
`)
    expect(one.lite).toContain('@default(uuid())')
    expect(one.lite).not.toContain('randomblob')
    // The quotes inside a SQL expression emitted as a string literal are doubled
    // by ddl.js on the way back out, so the text grew a level on every pass.
    expect(two.lite).toBe(one.lite)
  })

  test('a now() default is a now() default', () => {
    const { one } = roundTrip(`
model Doc { id Int @id  madeAt DateTime @default(now()) }
`)
    expect(one.lite).toContain('@default(now())')
    expect(one.lite).not.toContain('strftime')
  })

  test("a string default keeps its apostrophe rather than growing one", () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'it''s here') STRICT`)
    // SQLite doubles an inner quote to escape it. Stripping the outer pair and
    // leaving the doubling re-doubles it on the way out, once per round trip.
    expect(generateLiteSchema(db)).toContain(`@default("it's here")`)
  })

  test('a SQL expression litestone did not write is handed over, never quoted', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT DEFAULT (upper(hex(randomblob(2))))) STRICT`)
    const { lite, gaps } = introspectToLite(db)
    expect(lite).not.toContain('@default("upper')
    expect(gaps.some(g => g.kind === 'dbgenerated-default' && g.field === 'k')).toBe(true)
  })

  test('a string that merely looks like an expression stays a string', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, k TEXT DEFAULT 'a || b') STRICT`)
    expect(generateLiteSchema(db)).toContain('@default("a || b")')
  })
})

describe('an index direction survives', () => {
  test('@@index carries the direction it was declared with', () => {
    const { one, two } = roundTrip(`
model Row {
  id  Int  @id
  a   Int
  b   Int
  @@index([a, b(sort: Desc)])
}
`)
    expect(one.lite).toContain('@@index([a, b(sort: Desc)])')
    expect(two.lite).toBe(one.lite)
  })

  test('a UNIQUE index cannot hold one, and says so rather than dropping it silently', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT) STRICT`)
    db.exec(`CREATE UNIQUE INDEX t_ab ON t(a, b DESC)`)
    const { gaps } = introspectToLite(db)
    // @@unique takes a plain field list — the direction has nowhere to go.
    expect(gaps.some(g => g.kind === 'index-modifier')).toBe(true)
  })
})

// ─── the output is stable ────────────────────────────────────────────────────

describe('the same database reads the same way twice', () => {
  test('model, enum and relation order do not move', () => {
    // sqlite_master is in CREATION order, so a table a migration rebuilt moves
    // to the end of the file; a relation's position comes from PRAGMA
    // foreign_key_list. Without an order of its own, re-running `fli db:pull`
    // over a database it already read produces an unreadable diff.
    const src = `
model Zebra { id Int @id  name String  legs Leg[] }
model Apple { id Int @id  name String }
model Leg {
  id      Int    @id
  zebra   Zebra  @relation(fields: [zebraId], references: [id])
  zebraId Int
  apple   Apple? @relation(fields: [appleId], references: [id])
  appleId Int?
}
`
    const { one } = roundTrip(src)
    expect(one.lite.indexOf('model Apple')).toBeLessThan(one.lite.indexOf('model Leg'))
    expect(one.lite.indexOf('model Leg')).toBeLessThan(one.lite.indexOf('model Zebra'))
    expect(one.lite.indexOf('  apple ')).toBeLessThan(one.lite.indexOf('  zebra '))
  })
})

// ─── what it could not carry ─────────────────────────────────────────────────

describe('the reading says what it could not express', () => {
  test('a plain database still reports the half a SQLite file cannot hold', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY) STRICT`)
    const { summary, gaps } = introspectToLite(db)
    // Said once, because it is one fact about the SOURCE rather than about a
    // model: no @@gate, no @@allow, no @secret is in a SQLite file.
    expect(gaps.filter(g => g.kind === 'application-attributes')).toHaveLength(1)
    expect(summary.noted).toBeGreaterThanOrEqual(1)
  })

  test('a type SQLite cannot hold is reported where the default is evidence', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (
      id     INTEGER PRIMARY KEY,
      madeAt TEXT    DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      live   INTEGER DEFAULT 1,
      name   TEXT
    ) STRICT`)
    const { gaps } = introspectToLite(db)
    expect(gaps.some(g => g.kind === 'datetime-as-text' && g.field === 'madeAt')).toBe(true)
    expect(gaps.some(g => g.kind === 'boolean-as-int'   && g.field === 'live')).toBe(true)
    // A bare TEXT column is not evidence of anything — one row per TEXT column
    // is one row per column, and a report nobody reads is no report.
    expect(gaps.some(g => g.field === 'name')).toBe(false)
  })

  test('nothing in a schema litestone wrote changed meaning', () => {
    const { one } = roundTrip(readFileSync(join(FIXTURES, 'scale', 'openmrp.lite'), 'utf8'))
    // `lost` and `noted` are expected — SQLite holds no access rules and no
    // DateTime. `changed` would mean the output says something the database
    // does not, which is the tier `--strict` fails on.
    expect(one.summary.changed).toBe(0)
  })
})
