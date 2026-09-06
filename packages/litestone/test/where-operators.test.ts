// test/where-operators.test.ts
//
// An operator that does not exist is the CALLER's mistake.
//
// The loop in `buildWhere` states this rule itself — "an operator the column
// cannot answer is a caller error, and junction maps the name to a 400. A 500
// would say the server broke" — and then refuses an operator that does not
// exist AT ALL with a bare `Error`, twelve lines below the comment. So the
// array-operator and text-operator refusals answered 400 and the unknown one
// answered 500, for the same class of wrong input.
//
// Measured over HTTP before the fix: `?status[nope]=1` was a 500 on a fully
// modelled service, not only on a modelless one. The relation path had the same
// bare throw. `FJS-776` graded the relation KEY and left both operators.
//
// Every refusal here is paired with the same call using a REAL operator
// (`FJS-351`): a compiler that refused every operator would satisfy any test
// that only asked about the refusal.

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../src/index.js'
import { ValidationError }        from '../src/core/validate.js'

const SCHEMA = `
  model Author { id Int @id  name String  books Book[] }
  model Book   { id Int @id  title String  tags String[]  meta Json?  authorId Int
                 author Author @relation(fields: [authorId], references: [id]) }
`

async function db() {
  const c: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = c.asSystem()
  await sys.author.create({ data: { id: 1, name: 'A' } })
  await sys.book.create({ data: { id: 1, title: 'B', tags: ['x'], authorId: 1 } })
  return sys
}

const refusal = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null } catch (e) { return e as Error }
}

describe('an unknown where operator is a ValidationError', () => {

  test('on a scalar column', async () => {
    const sys = await db()
    const err = await refusal(() => sys.book.findMany({ where: { title: { nope: 1 } } }))
    expect(err).toBeInstanceOf(ValidationError)
    expect(err!.message).toMatch(/nope/)
    expect(err!.message).toMatch(/title/)
  })

  test('…and a real operator on the same column still answers', async () => {
    const sys = await db()
    expect(await sys.book.findMany({ where: { title: { contains: 'B' } } })).toHaveLength(1)
  })

  test('on a relation filter', async () => {
    const sys = await db()
    const err = await refusal(() => sys.author.findMany({ where: { books: { nope: { title: 'B' } } } }))
    expect(err).toBeInstanceOf(ValidationError)
    expect(err!.message).toMatch(/nope/)
  })

  test('…and a real relation operator on the same relation still answers', async () => {
    const sys = await db()
    expect(await sys.author.findMany({ where: { books: { some: { title: 'B' } } } })).toHaveLength(1)
  })

  test('the path names the field, so a form marks the box', async () => {
    // What makes it a 400 with a field attached rather than a 400 with a
    // sentence: junction reads `path` into the field errors.
    const sys = await db()
    const err = await refusal(() => sys.book.findMany({ where: { title: { nope: 1 } } })) as any
    expect(err.errors?.[0]?.path).toEqual(['where', 'title'])
  })

  test('an untyped Json column keeps its own diagnosis', async () => {
    // The message that says the operator was really a path into a document with
    // no declared shape (`FJS-206`). It rides the same throw, so changing the
    // class must not lose it.
    const sys = await db()
    const err = await refusal(() => sys.book.findMany({ where: { meta: { tier: 3 } } }))
    expect(err).toBeInstanceOf(ValidationError)
    expect(err!.message).toMatch(/untyped Json column/)
    expect(err!.message).toMatch(/@type/)
  })

  test('the two refusals that were ALREADY ValidationErrors still are', async () => {
    // The controls the fix had to match rather than change.
    const sys = await db()
    expect(await refusal(() => sys.book.findMany({ where: { title: { has: 'x' } } })))
      .toBeInstanceOf(ValidationError)
    expect(await refusal(() => sys.book.findMany({ where: { meta: { contains: 'x' } } })))
      .toBeInstanceOf(ValidationError)
  })
})

// ─── the list the message quotes ──────────────────────────────────────────

describe('WHERE_OPS is the switch it claims to be', () => {

  // The refusal now NAMES the valid operators, off `WHERE_OPS` — a set that
  // already existed for the typed-JSON walk, which cannot tell a sub-key from
  // an operator without it. That makes it two readers of one list, so it has to
  // stay equal to the cases `buildWhere` actually answers: an operator added to
  // the switch and not to the set is a filter reported as a missing field
  // (`FJS-206`'s shape) AND a refusal message that omits a real answer.
  test('every case in buildWhere is in the set, and nothing else is', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(new URL('../src/core/query.js', import.meta.url), 'utf8')

    // The switch inside buildWhere's operator loop, between the two markers the
    // file already has: the TEXT_OPS guard above it and the default below.
    const body  = src.slice(src.indexOf('const refusal = TEXT_OP_REFUSALS'), src.indexOf('Unknown where operator'))
    const cases = new Set([...body.matchAll(/case '([a-zA-Z]+)':/g)].map(m => m[1]!))

    const declared = new Set<string>()
    for (const name of ['JSON_LEAF_OPS', 'ARRAY_OPS', 'TEXT_OPS'] as const) {
      const decl = src.slice(src.indexOf(`const ${name} = new Set([`))
      const list = decl.slice(0, decl.indexOf('])'))
      for (const m of list.matchAll(/'([a-zA-Z]+)'/g)) declared.add(m[1]!)
    }
    declared.add('equals')

    expect(cases.size).toBeGreaterThan(10)
    expect([...cases].sort()).toEqual([...declared].sort())
  })
})
