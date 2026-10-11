// test/cursor-templates.test.ts
//
// `findManyCursor` refused `withTemplates` and `onlyTemplates` by name
// (`FJS-2654`), though the templates read rule already folded into its WHERE
// through `visibleWhere(…, args)`: its entry in `ARG_NAMES` was the one read
// verb that left the view flags out. A list of templates paged by keyset then
// answered its first page from `findMany` and a 400 on the second — measured in
// maidtech on 116 template rows, the 101st onward lost. Each flag below is
// paired with the default view, so a cursor that answered every row whatever
// it was asked would fail.

import { describe, expect, test } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
  database main { path ":memory:" }

  model Task {
    id         Int     @id
    title      String
    isTemplate Boolean @default(false)
    @@db(main)
    @@hasTemplates
  }
`

async function seeded() {
  const db: any = await createClient({ databases: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  // Odd ids are templates, even ones records: five of each.
  for (let id = 1; id <= 10; id++) await sys.task.create({ data: { id, title: `t${id}`, isTemplate: id % 2 === 1 } })
  return sys
}

// Every id the view answers, walked two at a time to the end.
async function walk(sys: any, flags: Record<string, unknown>) {
  const out: number[] = []
  let cursor: string | undefined
  for (let guard = 0; guard < 20; guard++) {
    const page = await sys.task.findManyCursor({ limit: 2, orderBy: { id: 'asc' }, ...flags, ...(cursor ? { cursor } : {}) })
    out.push(...page.items.map((r: any) => r.id))
    if (!page.hasMore) return out
    cursor = page.nextCursor
  }
  throw new Error('the walk did not end')
}

describe('FJS-2654 — a keyset walk takes the template view its siblings take', () => {
  test('the default view walks the records alone', async () => {
    expect(await walk(await seeded(), {})).toEqual([2, 4, 6, 8, 10])
  })

  test('onlyTemplates walks the templates alone, past its first page', async () => {
    expect(await walk(await seeded(), { onlyTemplates: true })).toEqual([1, 3, 5, 7, 9])
  })

  test('withTemplates walks both', async () => {
    expect(await walk(await seeded(), { withTemplates: true })).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  })
})
