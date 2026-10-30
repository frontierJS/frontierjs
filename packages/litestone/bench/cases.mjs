// cases.mjs — litestone's REPORTED tier: what a request costs over raw bun:sqlite.
// `bun bench/cases.mjs` runs one round; scripts/bench-round.mjs is the loop.
//
// Each case is timed beside its FLOOR — the same statement through the same
// database handle, with no client in between — in the same process and the same
// round, and declares the ratio it may not exceed. A time is never committed: a
// microsecond is a statement about one machine (IDEAS/performance-regression-watch.md
// § Reported). The ratio is the claim, and scripts/bench-ab.mjs is what compares
// it against the base ref.
//
// The base ref runs THIS file, not its own (scripts/bench-ab.mjs), so an edit
// here that needs a new client API reads as the base failing, and the runner
// says so rather than comparing nothing.

import { readFileSync } from 'node:fs'
import { tokenize }     from '@frontierjs/toolbelt/predicate'
import { createClient } from '../src/index.js'
import { GatePlugin }   from '../src/plugins/gate.js'
import { main }         from '../../../scripts/bench-round.mjs'

const ROWS = 10_000

// Rows are written through the client, so the floor reads the table and the
// indexes the schema declares rather than ones written beside it.
async function users(extra = '', plugins) {
  const db = await createClient({
    schema: `model User { id Int @id; name String; age Int ${extra} }`,
    db: ':memory:', plugins,
  })
  await db.asSystem().user.createMany({ data: Array.from({ length: ROWS }, (_, i) => ({ name: `u${i}`, age: i % 80 })) })
  return db
}

export const cases = [
  {
    name: 'findUnique-pk', ceiling: 6, ops: 20_000,
    async open() {
      const db = await users()
      const raw = db.$rawDbs.main.query('SELECT id, name, age FROM user WHERE id = ?')
      return { db, raw, close: () => db.$close() }
    },
    run:   ({ db }, i)  => db.user.findUnique({ where: { id: (i % ROWS) + 1 } }),
    floor: ({ raw }, i) => raw.get((i % ROWS) + 1),
  },
  {
    name: 'findMany-100', ceiling: 1.75, ops: 2_000,
    async open() {
      const db = await users()
      const raw = db.$rawDbs.main.query('SELECT id, name, age FROM user WHERE age >= ? LIMIT ?')
      return { db, raw, close: () => db.$close() }
    },
    run:   ({ db })  => db.user.findMany({ where: { age: { gte: 40 } }, limit: 100 }),
    floor: ({ raw }) => raw.all(40, 100),
  },
  {
    name: 'findMany-gated', ceiling: 2, ops: 2_000,
    async open() {
      const db = await users('\n @@gate(2.4.4.6)', [new GatePlugin({ getLevel: () => 5 })])
      const raw = db.$rawDbs.main.query('SELECT id, name, age FROM user WHERE age >= ? LIMIT ?')
      return { db: db.$setAuth({ id: 1 }), raw, close: () => db.$close() }
    },
    run:   ({ db })  => db.user.findMany({ where: { age: { gte: 40 } }, limit: 100 }),
    floor: ({ raw }) => raw.all(40, 100),
  },
  {
    name: 'create-1', ceiling: 6, ops: 5_000,
    async open() {
      const db = await users()
      const raw = db.$rawDbs.main.query('INSERT INTO user (name, age) VALUES (?, ?) RETURNING id, name, age')
      return { db, raw, close: () => db.$close() }
    },
    run:   ({ db })  => db.user.create({ data: { name: 'x', age: 1 } }),
    floor: ({ raw }) => raw.get('x', 1),
  },
  {
    // The lexer every schema parse starts with (FJS-112 P4). Its floor is a
    // sticky-regex scan counting the same tokens: no positions, no objects.
    name: 'tokenize-schema', ceiling: 6, ops: 50,
    open() {
      const src = readFileSync(new URL('../test/fixtures/corpus/discourse.lite', import.meta.url), 'utf8')
      return { src, lex: /\s+|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|-?\d[\d.]*|\w+|@@|->|=>|[|&=!<>]=?|[^\s\w]/y }
    },
    run:   ({ src }) => tokenize(src),
    floor: ({ src, lex }) => {
      let n = 0
      lex.lastIndex = 0
      while (lex.test(src)) n++
      return n
    },
  },
]

if (import.meta.main) await main(cases)
