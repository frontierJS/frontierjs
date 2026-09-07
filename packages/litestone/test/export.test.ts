// export.test.ts — the governed extract.
//
// `FJS-D228` phase 1. The claim under test is not that an export works; it is
// that an export is a PAGINATED SCOPED READ and therefore cannot contain what
// the named principal could not read one row at a time. So every row below is
// a pair: a refusal or a narrowing beside the same call by somebody entitled to
// it, because a mechanism that exported nothing to nobody would satisfy any
// test that only asked about the refusal (`FJS-351`).

import { test, expect, describe } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { createClient } from '../src/core/client.js'
import { runExport, exportableDatasets, columnPlan } from '../src/export.js'

const errs = (src: string) => parse(src).errors
const KEY  = 'a'.repeat(64)

const SCHEMA = `
database main { path ":memory:" }

model Order {
  id        Int      @id @default(autoincrement())
  ref       String
  total     Int
  ownerId   String
  cardTok   String   @secret
  memo      String?  @guarded
  updatedAt DateTime @default(now())
  @@gate("1.4.4.5")
  @@allow('read', auth().isStaff == true)
  @@allow('read', ownerId == auth().id)
  @@export(ndjson, since: updatedAt)
}

model Ledger {
  id   Int    @id @default(autoincrement())
  memo String
  @@gate("5.8.9.9")
  @@export(ndjson)
}

view revenue {
  total Int
  @@sql("SELECT SUM(total) AS total FROM [order]")
  @@gate("5")
  @@export(csv)
}
`

const client = () => createClient({ schema: SCHEMA, encryptionKey: KEY, resolveFrom: import.meta.dir })
const seed = (db: any) => db.asSystem().order.createMany({ data: [
  { ref: 'A', total: 10, ownerId: 'u-a', cardTok: 't1', memo: 'm1' },
  { ref: 'B', total: 20, ownerId: 'u-b', cardTok: 't2', memo: 'm2' },
  { ref: 'C', total: 30, ownerId: 'u-a', cardTok: 't3', memo: 'm3' },
]})

const collect = async (db: any, name: string, opts: any = {}) => {
  const lines: string[] = []
  const manifest = await runExport(db, name, { write: (l: string) => { lines.push(l) }, audit: false, ...opts })
  return { lines, manifest }
}

const staff    = { id: 'u-s', isStaff: true }
const ownerA   = { id: 'u-a', isStaff: false }
const ownerB   = { id: 'u-b', isStaff: false }

// ─── the declaration ──────────────────────────────────────────────────────

describe('what may be declared exportable', () => {
  test('@@export without a @@gate is refused, naming the way to say public', () => {
    const e = errs('model O { id Int @id  @@export(ndjson) }')
    expect(e.length).toBe(1)
    expect(e[0]).toContain('@@export needs a @@gate beside it')
    expect(e[0]).toContain('@@gate("0")')
  })

  test('and the control — the same declaration with a gate parses clean', () => {
    expect(errs('model O { id Int @id  @@gate("4") @@export(ndjson) }')).toEqual([])
  })

  test('the rule fires even where the schema guards nothing else', () => {
    // A bulk read of every row is a different proposition from one row at a
    // time, so this is not conditional on the schema guarding something.
    expect(errs('model O { id Int @id  @@export(csv) }')[0]).toContain('@@export needs a @@gate')
  })

  test('a format this cannot write is refused by name, and the two it can are not', () => {
    expect(errs('model O { id Int @id @@gate("4") @@export(parquet) }')[0]).toContain("format 'parquet' is not one this can write")
    expect(errs('model O { id Int @id @@gate("4") @@export(ndjson) }')).toEqual([])
    expect(errs('model O { id Int @id @@gate("4") @@export(csv) }')).toEqual([])
  })

  test('a cursor naming no column is refused; one naming a real column is not', () => {
    expect(errs('model O { id Int @id  u DateTime @@gate("4") @@export(ndjson, since: nope) }')[0])
      .toContain('names no column this model declares')
    expect(errs('model O { id Int @id  u DateTime @@gate("4") @@export(ndjson, since: u) }')).toEqual([])
  })

  test('a cursor on a @computed field is refused — it is not a column to order by', () => {
    expect(errs('model O { id Int @id  d String @computed @@gate("4") @@export(ndjson, since: d) }')[0])
      .toContain('@computed')
  })

  test('a view is exportable on the same attribute, and it is listed as a view', () => {
    const sets = exportableDatasets(parse(SCHEMA).schema)
    expect(sets.map(s => `${s.name}:${s.kind}`).sort()).toEqual(['Ledger:model', 'Order:model', 'revenue:view'])
  })
})

// ─── the standing ─────────────────────────────────────────────────────────

describe('an export has to be taken as somebody', () => {
  test('naming no standing is refused before anything is read', async () => {
    const db = await client()
    await expect(runExport(db, 'Order', { write: () => {} })).rejects.toThrow(/needs a standing/)
  })

  test('and the two controls — an account, and system, both run', async () => {
    const db = await client(); await seed(db)
    expect((await collect(db, 'Order', { as: staff })).manifest.rows).toBe(3)
    expect((await collect(db, 'Order', { system: true })).manifest.rows).toBe(3)
  })

  test('a dataset that declares no @@export is refused, and lists the ones that do', async () => {
    const db = await client()
    await expect(runExport(db, 'Nope', { system: true, write: () => {} }))
      .rejects.toThrow(/declares no @@export.*Order/s)
  })
})

// ─── the whole claim ──────────────────────────────────────────────────────

describe('the extract is what that principal can read, and nothing else', () => {
  test('a row policy narrows the FILE — three standings, three different extracts', async () => {
    const db = await client(); await seed(db)
    expect((await collect(db, 'Order', { as: staff  })).manifest.rows).toBe(3)
    expect((await collect(db, 'Order', { as: ownerA })).manifest.rows).toBe(2)
    expect((await collect(db, 'Order', { as: ownerB })).manifest.rows).toBe(1)
  })

  test('and it narrows rather than failing — the owner gets THEIR rows, not an error', async () => {
    const db = await client(); await seed(db)
    const { lines } = await collect(db, 'Order', { as: ownerB })
    expect(lines.map(l => JSON.parse(l).ref)).toEqual(['B'])
  })

  test('a gate above the caller refuses the whole export at the first page', async () => {
    // Ledger reads at 5. A member is 4.
    const db = await client()
    await expect(runExport(db, 'Ledger', { as: { id: 'u-m', role: 'member' }, write: () => {} })).rejects.toThrow()
  })

  test('and the control — a caller at the level exports it', async () => {
    const db = await client()
    await db.asSystem().ledger.create({ data: { memo: 'x' } })
    expect((await collect(db, 'Ledger', { as: { id: 'a', isAdmin: true } })).manifest.rows).toBe(1)
  })

  test('paging does not change the answer — a batch smaller than the data', async () => {
    const db = await client(); await seed(db)
    const whole = await collect(db, 'Order', { system: true, batch: 1000 })
    const paged = await collect(db, 'Order', { system: true, batch: 1 })
    expect(paged.manifest.rows).toBe(whole.manifest.rows)
    expect(paged.lines).toEqual(whole.lines)
  })
})

// ─── what is left out ─────────────────────────────────────────────────────

describe('protected columns leave the extract even for a caller who may read them', () => {
  test('a @secret and a @guarded column are omitted, with the reason', async () => {
    const db = await client(); await seed(db)
    const { lines, manifest } = await collect(db, 'Order', { system: true })
    const row = JSON.parse(lines[0])
    expect('cardTok' in row).toBe(false)
    expect('memo'    in row).toBe(false)
    expect(manifest.omitted.filter((o: any) => o.reason === 'protected').map((o: any) => o.name).sort())
      .toEqual(['cardTok', 'memo'])
  })

  test('and the control — includeProtected keeps them AND says so in the manifest', async () => {
    const db = await client(); await seed(db)
    const { lines, manifest } = await collect(db, 'Order', { system: true, includeProtected: true })
    expect('cardTok' in JSON.parse(lines[0])).toBe(true)
    expect(manifest.includeProtected).toBe(true)
    expect(manifest.omitted.some((o: any) => o.reason === 'protected')).toBe(false)
  })

  test('a relation is not a column and is omitted for a different reason', () => {
    const decl = parse(SCHEMA).schema.models.find((m: any) => m.name === 'Order')
    const { columns } = columnPlan(decl, { includeProtected: true })
    expect(columns.map(c => c.name)).toEqual(['id', 'ref', 'total', 'ownerId', 'cardTok', 'memo', 'updatedAt'])
  })

  // `isStoredField` is the one owner of *is this a column* and this module used
  // to keep a second list beside it that knew about relations and `@computed`
  // and nothing else. A `@transient` field is never stored, so it reached every
  // CSV header with an empty value under it and every ndjson row as a null —
  // a column the database does not have, in a file somebody reconciles against
  // (`FJS-983`). Each kind is asked with an ordinary column beside it, because
  // a plan that returned NOTHING would satisfy every absence assertion here.
  test('a field that is not stored is not a column, whichever way it is not stored', () => {
    const src = `
      database main { path ":memory:" }
      model Doc {
        id      String @id @default(cuid())
        title   String
        draft   String   @transient
        seen    String   @computed
        @@gate("0")
        @@export(csv)
      }
    `
    const decl = parse(src).schema.models.find((m: any) => m.name === 'Doc')
    const { columns, omitted } = columnPlan(decl, { includeProtected: true })

    expect(columns.map(c => c.name)).toEqual(['id', 'title'])
    expect(omitted.find((o: any) => o.name === 'draft')?.reason).toBe('transient')
    expect(omitted.find((o: any) => o.name === 'seen')?.reason).toBe('computed')
  })
})

// ─── the manifest ─────────────────────────────────────────────────────────

describe('the manifest says what bounded the extract', () => {
  test('it records the principal, the declared read gate, and whether anything graded it', async () => {
    const db = await client(); await seed(db)
    const { manifest } = await collect(db, 'Order', { as: ownerA })
    expect(manifest.takenAs.principal).toBe('u-a')
    expect(manifest.takenAs.system).toBe(false)
    expect(manifest.takenAs.declaredReadGate).toBe(1)
    expect(manifest.takenAs.reads).toBe('graded')
  })

  test('a system run says so instead of naming a principal', async () => {
    const db = await client(); await seed(db)
    const { manifest } = await collect(db, 'Order', { system: true })
    expect(manifest.takenAs.system).toBe(true)
    expect(manifest.takenAs.principal).toBeNull()
  })

  test('the read policies are recorded as the predicates the schema declares', async () => {
    const db = await client(); await seed(db)
    const { manifest } = await collect(db, 'Order', { system: true })
    expect(manifest.policiesApplied.map((p: any) => p.expr))
      .toEqual(['auth().isStaff == true', 'ownerId == auth().id'])
  })

  test('the cursor is the last value seen, so a second run resumes from it', async () => {
    const db = await client(); await seed(db)
    const first = await collect(db, 'Order', { system: true })
    expect(first.manifest.cursor.column).toBe('updatedAt')
    const again = await collect(db, 'Order', { system: true, since: first.manifest.cursor.after })
    expect(again.manifest.rows).toBe(0)
  })

  test('and the control — a row written after the cursor IS picked up', async () => {
    const db = await client(); await seed(db)
    const first = await collect(db, 'Order', { system: true })
    await new Promise(r => setTimeout(r, 5))
    await db.asSystem().order.create({ data: { ref: 'D', total: 40, ownerId: 'u-a', cardTok: 't4' } })
    const again = await collect(db, 'Order', { system: true, since: first.manifest.cursor.after })
    expect(again.manifest.rows).toBe(1)
    expect(JSON.parse(again.lines[0]).ref).toBe('D')
  })

  test('a dataset with no cursor says so rather than inventing one', async () => {
    const db = await client(); await seed(db)
    const { manifest } = await collect(db, 'revenue', { system: true })
    expect(manifest.cursor).toBeNull()
    await expect(runExport(db, 'revenue', { system: true, since: 'x', write: () => {} }))
      .rejects.toThrow(/declares no @@export\(since:\)/)
  })
})

// ─── formats ──────────────────────────────────────────────────────────────

describe('the two formats', () => {
  test('a view with no key and no cursor still pages — by offset, not by cursor', async () => {
    // findManyCursor rightly refuses a projection it cannot order uniquely.
    const db = await client(); await seed(db)
    const { lines, manifest } = await collect(db, 'revenue', { system: true, batch: 1 })
    expect(manifest.rows).toBe(1)
    expect(lines[0]).toBe('total')
    expect(lines[1]).toBe('60')
  })

  test('CSV quotes a value carrying a comma, a quote or a newline — and only then', async () => {
    const db = await client()
    await db.asSystem().order.createMany({ data: [
      { ref: 'a,b',    total: 1, ownerId: 'u', cardTok: 't' },
      { ref: 'say "x"', total: 2, ownerId: 'u', cardTok: 't' },
      { ref: 'plain',  total: 3, ownerId: 'u', cardTok: 't' },
    ]})
    const { lines } = await collect(db, 'Order', { system: true, format: 'csv' })
    expect(lines[1]).toContain('"a,b"')
    expect(lines[2]).toContain('"say ""x"""')
    expect(lines[3]).toContain(',plain,')
  })

  test('a format the run overrides is used instead of the declared one', async () => {
    const db = await client(); await seed(db)
    const { lines } = await collect(db, 'Order', { system: true, format: 'csv' })
    expect(lines[0].startsWith('id,ref,total')).toBe(true)
  })
})
