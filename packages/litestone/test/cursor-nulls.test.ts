// test/cursor-nulls.test.ts
//
// A window over a NULLABLE sort column (`FJS-780`).
//
// `"col" > NULL` is NULL, which matches nothing. So a cursor minted off a row
// whose sort value is null named a position no comparison could resume from:
// measured on six rows with three nulls, ordered `[{priority:'asc'},{id:'asc'}]`,
// page 1 answered ids 1,2,3 with `hasMore: true` and page 2 answered NOTHING —
// both 200. Half the table was never served and nothing said so. The cursor
// litestone minted was correct; the clause it compiled to could not be
// satisfied.
//
// **Every assertion here is a FULL WALK.** That is not thoroughness, it is the
// only shape that can see this: the bug is rows that are never served, so a
// test that asks for one page and checks its contents passes against it. What
// has to be true is that walking the whole list a page at a time yields every
// row exactly once, in the order a plain `findMany` with the same `orderBy`
// yields them — which is the oracle, since it is what the caller asked for.
//
// Both DIRECTIONS, and both NULL POSITIONS. SQLite puts NULLs first ascending
// and last descending, and `orderBy` can state the other (`nulls: 'last'`), so
// there are four arrangements and each resumes from a different side. Measured
// against real SQLite rather than reasoned about:
//
//   ORDER BY p ASC,  id ASC              → 1/null 2/null 3/5 4/7
//   ORDER BY p DESC, id ASC              → 4/7 3/5 1/null 2/null
//   ORDER BY p ASC NULLS LAST,  id ASC   → 3/5 4/7 1/null 2/null
//   ORDER BY p DESC NULLS FIRST, id ASC  → 1/null 2/null 4/7 3/5

import { describe, test, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  database main { path ":memory:" }

  model Task {
    id       Int    @id @default(autoincrement())
    title    String
    priority Int?
    @@db(main)
  }
`

/** Nulls at both ends of the value range and in the middle of the id range. */
const ROWS = [
  { title: 'a', priority: null },
  { title: 'b', priority: 30   },
  { title: 'c', priority: null },
  { title: 'd', priority: 10   },
  { title: 'e', priority: null },
  { title: 'f', priority: 20   },
  { title: 'g', priority: 10   },   // a tie on the sort column
  { title: 'h', priority: null },
]

async function seeded() {
  const db: any = await createClient({ databases: ':memory:', schema: SCHEMA })
  for (const r of ROWS) await db.asSystem().task.create({ data: r })
  return db
}

/**
 * Walk the whole list `pageSize` at a time and answer every id it served.
 *
 * Duplicates are kept rather than de-duplicated — serving a row twice is the
 * other half of this defect's family and a Set would hide it.
 */
async function walk(db: any, orderBy: unknown, pageSize: number): Promise<number[]> {
  const t: any = db.asSystem().task
  const seen: number[] = []
  let cursor: string | undefined
  for (let guard = 0; guard <= ROWS.length + 2; guard++) {
    const page = await t.findManyCursor({ limit: pageSize, orderBy, cursor })
    seen.push(...page.items.map((r: any) => r.id))
    if (!page.hasMore) return seen
    cursor = page.nextCursor
  }
  throw new Error('the walk did not terminate')
}

/** What the caller asked for, in one query — the oracle. */
const straight = async (db: any, orderBy: unknown): Promise<number[]> =>
  (await db.asSystem().task.findMany({ orderBy })).map((r: any) => r.id)

const ARRANGEMENTS: Array<[string, unknown]> = [
  ['asc, nulls where SQLite puts them (first)',  [{ priority: 'asc'  }, { id: 'asc' }]],
  ['desc, nulls where SQLite puts them (last)',  [{ priority: 'desc' }, { id: 'asc' }]],
  ['asc with nulls stated LAST',                 [{ priority: { dir: 'asc',  nulls: 'last'  } }, { id: 'asc' }]],
  ['desc with nulls stated FIRST',               [{ priority: { dir: 'desc', nulls: 'first' } }, { id: 'asc' }]],
]

describe('a window over a nullable sort column serves every row, once', () => {

  for (const [name, orderBy] of ARRANGEMENTS) {
    // Three page sizes, because where the boundary FALLS is the whole question:
    // 3 lands it inside the nulls, 4 lands it exactly on the last null, and 5
    // lands it after them. A single page size can miss the case that breaks.
    for (const size of [3, 4, 5]) {
      test(`${name} — pages of ${size}`, async () => {
        const db  = await seeded()
        const want = await straight(db, orderBy)
        const got  = await walk(db, orderBy, size)

        expect(got).toEqual(want)                 // order AND membership
        expect(got).toHaveLength(ROWS.length)     // nothing lost
        expect(new Set(got).size).toBe(got.length) // nothing served twice
        db.$close()
      })
    }
  }

  test('a page ending exactly ON a null resumes from the right side', async () => {
    // The specific failure: the cursor's own value is null, so the comparison
    // that used to be emitted — `"priority" > NULL` — matched nothing and the
    // page after it was empty while `hasMore` had said true.
    const db = await seeded()
    const t: any = db.asSystem().task
    const orderBy = [{ priority: 'asc' }, { id: 'asc' }]

    const p1 = await t.findManyCursor({ limit: 4, orderBy })
    expect(p1.items.map((r: any) => r.priority)).toEqual([null, null, null, null])
    expect(p1.hasMore).toBe(true)

    const p2 = await t.findManyCursor({ limit: 4, orderBy, cursor: p1.nextCursor })
    expect(p2.items.length).toBeGreaterThan(0)
    expect(p2.items.every((r: any) => r.priority !== null)).toBe(true)
    db.$close()
  })

  test('an exhausted position is the END, not a restart', async () => {
    // The other way to be wrong, and it is the one the old `null` cursor took:
    // a position nothing can follow compiles to an EMPTY clause, and an empty
    // clause reaches the query as *no cursor at all* — the whole table, from
    // the start, with a 200.
    //
    // Under `nulls: 'last'` the nulls are the tail, so a cursor sitting on the
    // last of them has nothing after it on that field. Minted by hand because
    // a page that knows it is the last hands back no cursor — `hasMore` is
    // false and `nextCursor` is null — so the only way to ask this question is
    // to ask it directly.
    const db = await seeded()
    const t: any = db.asSystem().task
    const orderBy = [{ priority: { dir: 'asc', nulls: 'last' } }, { id: 'asc' }]

    const all = await t.findMany({ orderBy })
    const end = all[all.length - 1]
    expect(end.priority).toBeNull()

    const cursor = Buffer.from(JSON.stringify({ priority: null, id: end.id }))
      .toString('base64url')
    const past = await t.findManyCursor({ limit: 8, orderBy, cursor })

    expect(past.items).toEqual([])
    expect(past.hasMore).toBe(false)
    db.$close()
  })

  test('an exhausted clause is `0`, never the empty string', async () => {
    // The unit behind the row above. `''` is how `buildCursorWhere` says *no
    // cursor was given*, so a position with nothing after it must not produce
    // one — the caller ANDs the answer into its WHERE, and an empty string
    // simply is not there.
    const { buildCursorWhere } = await import('../src/core/query.js')
    const params: unknown[] = []
    // `nullable` is part of the field, not optional decoration: without it the
    // column cannot hold NULL and the plain comparison is the right answer.
    const sql = buildCursorWhere(
      [{ col: 'priority', dir: 'ASC', nulls: 'LAST', nullable: true }],
      { priority: null }, params)

    expect(sql).toBe('0')
    expect(params).toEqual([])
  })

  test('a NOT NULL column compiles the plain comparison — no OR, no index loss', async () => {
    // The reason `nullable` is carried at all. The NULL-aware form costs an
    // `OR`, and an `OR` is what stops SQLite using the index the keyset scan
    // exists for — so the column that cannot have the problem must not pay for
    // it. This is the SQL every ordinary list in the repo compiles.
    const { buildCursorWhere } = await import('../src/core/query.js')
    const params: unknown[] = []
    const sql = buildCursorWhere(
      [{ col: 'createdAt', dir: 'DESC' }, { col: 'id', dir: 'ASC' }],
      { createdAt: '2024-01-01', id: 50 }, params)

    expect(sql).toBe('("createdAt" < ?) OR ("createdAt" = ? AND "id" > ?)')
    expect(params).toEqual(['2024-01-01', '2024-01-01', 50])
  })

  test('a column with no nulls is unchanged — the control', async () => {
    // Every row above passes against an implementation that broke non-null
    // paging too, which would be a worse list than the one being fixed.
    const db = await seeded()
    const orderBy = [{ id: 'desc' }]
    expect(await walk(db, orderBy, 3)).toEqual(await straight(db, orderBy))
    db.$close()
  })
})
