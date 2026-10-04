// search-filter-cost.test.ts — what `search()` pays for the filter it applies
// before its LIMIT (FJS-1692).
//
// The filter — soft-delete, the caller's where, the row policy — narrows the
// FTS query so rows the caller cannot read never spend a slot (FJS-262). As
// `rowid IN (SELECT rowid FROM t WHERE …)` SQLite answered it with a LIST
// SUBQUERY: every readable row, each through its policy's correlated hops, and
// re-read under the FTS scan. The rows came back right and every behavioral
// test passed; a two-hop policy over 12k comments cost 300-800 ms a keystroke
// in linear's ⌘K where the match was one row.
//
// So this EXPLAINs the bytes the client sent, with the old shape beside it as
// the control — the plan CAN say LIST SUBQUERY, and the correlated form is what
// keeps it from saying it.

import { describe, it, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'

const SCHEMA = `
model User {
  id String @id
  @@auth
}

model Team {
  id      String  @id
  ownerId String
  issues  Issue[]
  @@allow('read', ownerId == auth().id)
}

model Issue {
  id       String    @id
  teamId   String
  team     Team      @relation(fields: [teamId], references: [id])
  title    String
  comments Comment[]
  @@allow('read', check(team))
}

model Comment {
  id        String    @id
  issueId   String
  issue     Issue     @relation(fields: [issueId], references: [id])
  body      String
  deletedAt DateTime?
  @@allow('read', check(issue))
  @@fts([body])
  @@softDelete
}
`

describe('search() — the pre-LIMIT filter', () => {
  it('is correlated on the hit, never a list of every readable row', async () => {
    const dir  = mkdtempSync(join(tmpdir(), 'litestone-fts-cost-'))
    const file = join(dir, 'db.sqlite')
    try {
      const seen: any[] = []
      const db: any = await createClient({ schema: SCHEMA, db: file, onQuery: (e: any) => seen.push(e) })
      const sys = db.asSystem()
      for (let t = 0; t < 20; t++) await sys.team.create({ data: { id: 't' + t, ownerId: 'u' + (t % 4) } })
      for (let i = 0; i < 200; i++) await sys.issue.create({ data: { id: 'i' + i, teamId: 't' + (i % 20), title: 'x' } })
      for (let c = 0; c < 2000; c++) {
        await sys.comment.create({ data: { id: 'c' + c, issueId: 'i' + (c % 200), body: c === 7 ? 'tachyon relay' : 'filler words here' } })
      }
      // The one match sits under team t7, owned by u3. The pair: u3 finds it, u1 does not.
      expect((await db.$setAuth({ id: 'u3' }).comment.search('tachyon')).map((r: any) => r.id)).toEqual(['c7'])
      seen.length = 0
      expect(await db.$setAuth({ id: 'u1' }).comment.search('tachyon')).toEqual([])

      const q = seen.find(e => e.operation === 'search')
      const raw = new Database(file, { readonly: true })
      try {
        const plan = (sql: string, params: unknown[]) =>
          (raw.prepare('EXPLAIN QUERY PLAN ' + sql).all(...(params as any[])) as any[]).map(r => r.detail).join(' | ')

        const sent = plan(q.sql, q.params)
        expect(sent).toMatch(/SCAN comment_fts VIRTUAL TABLE/)
        expect(sent).toMatch(/SEARCH comment (EXISTS )?USING INTEGER PRIMARY KEY \(rowid=\?\)/)
        expect(sent).not.toContain('LIST SUBQUERY')

        // The control: the same filter as a membership list.
        const filter = q.sql.match(/WHERE "comment"\.rowid = "comment_fts"\.rowid AND \((.*)\)\) ORDER BY rank/s)[1]
        const head   = q.sql.slice(0, q.sql.indexOf(' AND EXISTS'))
        expect(plan(`${head} AND rowid IN (SELECT rowid FROM "comment" WHERE ${filter}) ORDER BY rank LIMIT 20`, q.params))
          .toContain('LIST SUBQUERY')
      } finally { raw.close() }
      await db.$close()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
