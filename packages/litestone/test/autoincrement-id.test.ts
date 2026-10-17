// A lone `Int @id` emits AUTOINCREMENT (FJS-D887, FJS-2432), so a hard-deleted
// highest id is never handed to the next create and a permalink never changes
// meaning. Asserted by running a create/delete/create, not by reading the DDL.

import { describe, it, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { createClient } from '../src/core/client.js'

const ddl = (src: string) => generateDDL(parse(src).schema)

describe('Int @id never reuses a deleted id', () => {
  for (const [label, src] of [
    ['a bare `Int @id`',            `model M { id Int @id  x String }`],
    ['`@default(autoincrement())`', `model M { id Int @id @default(autoincrement())  x String }`],
  ] as [string, string][]) {
    it(`${label}: delete the highest, the next create takes a new id`, async () => {
      const db = await createClient({ schema: src, db: ':memory:' })
      try {
        const a = await db.m.create({ data: { x: 'a' } })
        await db.m.delete({ where: { id: a.id } })
        const b = await db.m.create({ data: { x: 'b' } })
        expect(b.id).toBeGreaterThan(a.id)
      } finally { await db.$close() }
    })
    it(`${label}: emits INTEGER PRIMARY KEY AUTOINCREMENT`, () => {
      expect(ddl(src)).toContain('PRIMARY KEY AUTOINCREMENT')
    })
  }

  it('a composite key and a String @id take no AUTOINCREMENT', () => {
    expect(ddl(`model M { a Int  b Int  @@id([a, b]) }`)).not.toContain('AUTOINCREMENT')
    expect(ddl(`model M { id String @id @default(uuid()) }`)).not.toContain('AUTOINCREMENT')
  })
})
