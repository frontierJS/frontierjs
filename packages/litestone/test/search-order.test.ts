// FJS-1044 — `orderBy` reaches `search()` now, and is GRADED on the way in.
//
// It was accepted by every caller and honored by none: junction's find builds
// `args.orderBy` and hands it to `table.search(query, args)`, whose destructure
// named eleven options and not that one, so the key fell on the floor and the
// rows came back by BM25 rank under a URL that said otherwise. A dead argument
// one package hands another — `FJS-245`'s shape.
//
// Underneath it was the reason it could happen. `search` is the only read whose
// options are not the first argument, so it cannot go through the generic
// `wrap()` and its guards were a HAND COPY of that list — `checkOrderBy` had
// never been added to the copy, and `select` had already been forgotten there
// once (`FJS-601`). Both wrappers take one sequence now, which is why the rows
// below assert the REFUSALS and not only the ordering: a fix that made the sort
// work and left the key ungraded is the worse half, since a bad sort key
// answers the right rows in the wrong order and nothing about that is visible.
//
// `checkIncludeArgs` was missing from the copy too and that was NOT a hole:
// measured, an unknown relation is refused downstream by `parseArgs` in the
// same words, so adding it here changes no answer. It is in the sequence for
// uniformity and is claimed as nothing more.
//
// Every ordering row is asserted with the RELEVANCE answer beside it. Rank is
// the default and must stay it; an implementation that ordered by the column
// always would satisfy every assertion that only asks about the ordered call.

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Doc {
  id      Int    @id @default(autoincrement())
  title   String
  body    String
  weight  Int    @default(0)
  summary String @computed
  @@fts([title, body])
}
`

// THREE different orders over four rows, and the fixture is the test.
//
//   rank    delta charlie bravo alpha   (term frequency: delta matches most)
//   title   alpha bravo charlie delta   (the exact reverse)
//   weight  charlie alpha delta bravo   (desc — neither of the above)
//   id      bravo alpha delta charlie   (insertion — a fourth, and it matters)
//
// FOUR orders that pairwise differ, and getting there took two passes. The
// first cut had titles ascending WITH the match count, so rank and title were
// one list and every assertion passed against an implementation that still
// dropped `orderBy`. The second had insertion order equal to rank order, so
// *rank is still the default* passed against one that took the ordered path
// always — the rows arrive in id order there, and id order was rank order.
// A fixture whose orders coincide grades nothing and looks exactly like one
// that works.
const ROWS = [
  { title: 'bravo',   body: 'widget widget',                  weight: 1 },
  { title: 'alpha',   body: 'widget',                         weight: 3 },
  { title: 'delta',   body: 'widget widget widget widget',    weight: 2 },
  { title: 'charlie', body: 'widget widget widget',           weight: 4 },
]

const open = async () => {
  const db: any = await createClient({
    db: ':memory:', schema: SCHEMA,
    computed: { Doc: { summary: (r: any) => String(r.title).toUpperCase() } },
  })
  for (const data of ROWS) await db.doc.create({ data })
  return db
}

const refusal = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null }
  catch (e: any) { return String(e.message) }
}

const titles = (rows: any[]) => rows.map(r => r.title)

describe('search() honors a caller order', () => {
  it('sorts by the column, where the same search by relevance does not', async () => {
    const db = await open()

    const byRank = titles(await db.doc.search('widget'))
    const byName = titles(await db.doc.search('widget', { orderBy: { title: 'asc' } }))

    expect(byName).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    // The pair. Rank is still the default, and here it is the exact REVERSE —
    // so an implementation that always sorted by the column passes the row
    // above and fails this one, and one that still drops `orderBy` fails the
    // row above. Asserted as the whole list rather than `not.toEqual`, since
    // *different* is satisfied by any wrong answer.
    expect(byRank).toEqual(['delta', 'charlie', 'bravo', 'alpha'])
    db.$close()
  })

  it('takes a direction, and both directions are asked', async () => {
    const db = await open()
    expect(titles(await db.doc.search('widget', { orderBy: { weight: 'desc' } })))
      .toEqual(['charlie', 'alpha', 'delta', 'bravo'])
    expect(titles(await db.doc.search('widget', { orderBy: { weight: 'asc' } })))
      .toEqual(['bravo', 'delta', 'alpha', 'charlie'])
    db.$close()
  })

  it('PAGES in the caller order rather than paging by rank and sorting the page', async () => {
    // The row this design turns on. Paging stays on the FTS index by relevance
    // and MOVES to the base table under an order — page 2 of a title sort is
    // the third and fourth titles, where paging by rank first would answer the
    // 3rd and 4th best MATCHES sorted between themselves, which is a plausible
    // wrong answer that looks sorted.
    const db = await open()
    const page2 = titles(await db.doc.search('widget', {
      orderBy: { title: 'asc' }, limit: 2, offset: 2,
    }))
    expect(page2).toEqual(['charlie', 'delta'])

    // Paging by rank and sorting the page answers the 3rd and 4th best MATCHES
    // in title order — a plausible wrong answer that LOOKS sorted, and the one
    // an implementation that left the LIMIT on step 1 produces.
    const rankPage2 = titles(await db.doc.search('widget', { limit: 2, offset: 2 }))
    expect(rankPage2).toEqual(['bravo', 'alpha'])
    expect(rankPage2.slice().sort()).toEqual(['alpha', 'bravo'])
    db.$close()
  })

  it('still narrows by where, and still ranks when asked for nothing', async () => {
    // The controls. An order must not replace the filter, and the whole path
    // has to be inert when no order is stated.
    const db = await open()
    expect(titles(await db.doc.search('widget', {
      where: { weight: { gte: 3 } }, orderBy: { title: 'asc' },
    }))).toEqual(['alpha', 'charlie'])

    // Rank is still the DEFAULT, asserted as the whole list. Insertion order is
    // a fourth order for exactly this row: an implementation that took the
    // ordered path always answers in id order here with no ORDER BY, which is
    // a plausible-looking list and is not relevance.
    const plain = await db.doc.search('widget')
    expect(titles(plain)).toEqual(['delta', 'charlie', 'bravo', 'alpha'])
    expect(plain[0]._rank).toBeLessThan(0)
    db.$close()
  })

  it('carries _rank into an ordered answer, which is the row that walks the other way', async () => {
    // Step 3 walks the FTS hits by relevance and the base ROWS under an order,
    // so the per-row extras are looked up rather than carried. A walk that kept
    // the hit loop would put rank back and lose the sort; one that dropped the
    // lookup would sort correctly and hand back rows with no rank.
    const db = await open()
    const rows = await db.doc.search('widget', { orderBy: { title: 'asc' } })
    expect(titles(rows)).toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    for (const r of rows) expect(typeof r._rank).toBe('number')
    db.$close()
  })
})

describe('search() grades the options it takes', () => {
  // The guards were a hand copy of `wrap()`'s list; both go through one
  // sequence now. Each refusal is PAIRED with the legitimate call one character
  // away, or a guard that refused everything would satisfy the refusal alone.

  it('refuses a sort key that is not a column, by name', async () => {
    const db = await open()
    const msg = await refusal(() => db.doc.search('widget', { orderBy: { bogus: 'asc' } }))
    expect(msg).toMatch(/bogus/)
    expect(titles(await db.doc.search('widget', { orderBy: { title: 'asc' } })))
      .toEqual(['alpha', 'bravo', 'charlie', 'delta'])
    db.$close()
  })

  it('refuses a @computed column, which is the key SQLite cannot resolve', async () => {
    // A @computed field is a JS function over a row that SQLite has never heard
    // of, so `buildOrderBy` quotes it, SQLite resolves it against the SELECT
    // aliases, finds nothing, and orders by nothing — the silent no-op this
    // check exists for. It reached every read but this one.
    const db = await open()
    const msg = await refusal(() => db.doc.search('widget', { orderBy: { summary: 'asc' } }))
    expect(msg).toMatch(/summary/)
    db.$close()
  })

  it('refuses a direction that is not one, on the same path as every other read', async () => {
    const db = await open()
    const msg = await refusal(() => db.doc.search('widget', { orderBy: { title: 'sideways' } }))
    expect(msg).toMatch(/asc|desc/)
    db.$close()
  })

  it('and the guards it already had still refuse', async () => {
    // `select`, `where` and the take/skip shape came through the hand copy
    // correctly. They are asserted here so a refactor that drops the sequence
    // from this verb reds more than the one row it added — which is the whole
    // reason the two wrappers share a list rather than being checked against
    // each other.
    const db = await open()
    expect(await refusal(() => db.doc.search('widget', { select: ['id'] }))).toBeTruthy()
    expect(await refusal(() => db.doc.search('widget', { where: { nope: 1 } }))).toBeTruthy()
    expect(await refusal(() => db.doc.search('widget', { take: 2 } as any))).toMatch(/limit/)
    // The control beside all three: the same call with nothing wrong answers.
    expect(titles(await db.doc.search('widget', {
      select: { id: true, title: true }, where: { weight: { gte: 1 } }, limit: 2,
    }))).toEqual(['delta', 'charlie'])
    db.$close()
  })
})
