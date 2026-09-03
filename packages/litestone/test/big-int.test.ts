// big-int.test.ts — `Int @big`, the column whose values use all 64 bits.
//
// `FJS-643`: SQLite's INTEGER is 64-bit and bun answers a JS `number` on every
// path, so a value past 2^53 was read back as a DIFFERENT number — of a value
// the database was holding correctly. Nothing could see it: both the write and
// the read were self-consistent, and `CAST(v AS TEXT)` was the only way to ask
// what was actually stored.
//
// Every assertion here is against a value that a `number` cannot carry, and the
// control beside most of them is the same operation on a value that fits — a
// mechanism that broke both would otherwise look like a mechanism that broke
// neither.

import { test, expect, describe } from 'bun:test'
import { createClient } from '../src/core/client.js'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'

// 2^53 + 1 — the first integer a JS number cannot represent. `9007199254740993`
// and `9007199254740992` are the same double, which is the whole defect.
const BIG      = '9007199254740993'
const BIGGER   = '9007199254740995'
const INT64MAX = '9223372036854775807'
const SMALL    = 42

const SCHEMA = `
database main { path ":memory:" }

model Post {
  id        Int    @id @default(autoincrement())
  title     String
  snowflake Int    @big
  views     Int    @default(0)
  authorId  Int?
  author    Author? @relation(fields: [authorId], references: [id])
}

model Author {
  id       Int    @id @default(autoincrement())
  name     String
  remoteId Int    @big
  posts    Post[]
}
`

async function client(schema = SCHEMA) {
  return await createClient({ schema, resolveFrom: import.meta.dir })
}

describe('the round trip', () => {
  test('a value past 2^53 comes back as the value that was written', async () => {
    const db = await client()
    const created = await db.post.create({ data: { title: 'a', snowflake: BIG } })
    expect(created.snowflake).toBe(BIG)

    const read = await db.post.findFirst({ where: { title: 'a' } })
    expect(read.snowflake).toBe(BIG)

    // The control: what the column physically holds, asked without going
    // through a JS number at all. Before @big this answered BIG and the two
    // reads above answered ...992.
    const [{ stored }] = await db.asSystem().sql`SELECT CAST(snowflake AS TEXT) AS stored FROM post`
    expect(stored).toBe(BIG)
  })

  test('a value that FITS is unchanged, and is still a string', async () => {
    const db = await client()
    const row = await db.post.create({ data: { title: 'b', snowflake: String(SMALL) } })
    // Digits, not a number — the type of a @big column does not depend on the
    // size of the value in it, or a caller would have to branch on magnitude.
    expect(row.snowflake).toBe('42')
    expect(typeof row.snowflake).toBe('string')
  })

  test('a JS number is accepted below 2^53 and stored exactly', async () => {
    const db = await client()
    const row = await db.post.create({ data: { title: 'c', snowflake: SMALL } })
    expect(row.snowflake).toBe('42')
  })

  test('int64 max survives, which is the widest the column holds', async () => {
    const db = await client()
    const row = await db.post.create({ data: { title: 'd', snowflake: INT64MAX } })
    expect(row.snowflake).toBe(INT64MAX)
    const read = await db.post.findFirst({ where: { title: 'd' } })
    expect(read.snowflake).toBe(INT64MAX)
  })

  test('an update moves the value and reads back exactly', async () => {
    const db = await client()
    const row = await db.post.create({ data: { title: 'e', snowflake: BIG } })
    const up  = await db.post.update({ where: { id: row.id }, data: { snowflake: BIGGER } })
    // RETURNING * is the path here, which is a different statement from the
    // SELECT above and needed the same treatment.
    expect(up.snowflake).toBe(BIGGER)
  })
})

describe('every other column keeps its own type', () => {
  // safeIntegers is all-or-nothing per statement, so a model with one @big
  // column gets BigInts for `id`, `views` and every Boolean's 0/1 too. If the
  // narrowing missed them a caller would get BigInts where it had numbers, and
  // `JSON.stringify` would throw on the first response carrying one.
  test('the id and an ordinary Int are still numbers', async () => {
    const db = await client()
    const row = await db.post.create({ data: { title: 'f', snowflake: BIG, views: 7 } })
    expect(typeof row.id).toBe('number')
    expect(typeof row.views).toBe('number')
    expect(row.views).toBe(7)
  })

  test('the row survives JSON.stringify, which a BigInt does not', async () => {
    const db = await client()
    await db.post.create({ data: { title: 'g', snowflake: BIG } })
    const row = await db.post.findFirst({ where: { title: 'g' } })
    // The reason the value crosses as digits rather than as a BigInt: this is
    // every HTTP response, every WS frame and every before/after audit snapshot.
    expect(() => JSON.stringify(row)).not.toThrow()
    expect(JSON.parse(JSON.stringify(row)).snowflake).toBe(BIG)
  })

  test('a model with no @big column is untouched', async () => {
    const db = await client()
    const a = await db.author.create({ data: { name: 'x', remoteId: BIG } })
    expect(typeof a.id).toBe('number')
    expect(a.remoteId).toBe(BIG)
  })
})

describe('the value is still a number to SQLite', () => {
  // The reason @big keeps INTEGER storage instead of holding digits in a TEXT
  // column: everything below is what a TEXT column would get wrong.
  test('a filter finds the row by its wide value', async () => {
    const db = await client()
    await db.post.create({ data: { title: 'h', snowflake: BIG } })
    const found = await db.post.findFirst({ where: { snowflake: BIG } })
    expect(found?.title).toBe('h')
  })

  test('a range filter compares numerically, not as text', async () => {
    const db = await client()
    await db.post.create({ data: { title: 'small',  snowflake: '100' } })
    await db.post.create({ data: { title: 'big',    snowflake: BIG } })
    await db.post.create({ data: { title: 'bigger', snowflake: BIGGER } })
    const gt = await db.post.findMany({ where: { snowflake: { gt: BIG } } })
    expect(gt.map(r => r.title)).toEqual(['bigger'])
    // As text, '100' sorts after '9007…' — this is the assertion a TEXT column
    // fails.
    const asc = await db.post.findMany({ orderBy: { snowflake: 'asc' } })
    expect(asc.map(r => r.title)).toEqual(['small', 'big', 'bigger'])
  })

  test('an aggregate over a wide column is exact', async () => {
    const db = await client()
    await db.post.create({ data: { title: 'i', snowflake: BIG } })
    await db.post.create({ data: { title: 'j', snowflake: BIGGER } })
    const agg = await db.post.aggregate({ _max: { snowflake: true } })
    expect(agg._max.snowflake).toBe(BIGGER)
  })

  test('a count beside it is a number, not digits', async () => {
    const db = await client()
    await db.post.create({ data: { title: 'k', snowflake: BIG } })
    const n = await db.post.count()
    expect(n).toBe(1)
    expect(typeof n).toBe('number')
  })
})

describe('a wide value crossing a relation', () => {
  test('an include reads the target model’s wide column exactly', async () => {
    const db = await client()
    const a = await db.author.create({ data: { name: 'ada', remoteId: BIG } })
    await db.post.create({ data: { title: 'l', snowflake: BIGGER, authorId: a.id } })

    // The include reads the TARGET's rows, which is a different code path from
    // the model's own read and decides wideness off a different model.
    const post = await db.post.findFirst({ where: { title: 'l' }, include: { author: true } })
    expect(post.author.remoteId).toBe(BIG)
    expect(post.snowflake).toBe(BIGGER)

    const author = await db.author.findFirst({ where: { id: a.id }, include: { posts: true } })
    expect(author.posts[0].snowflake).toBe(BIGGER)
    expect(author.remoteId).toBe(BIG)
  })
})

describe('what the table refuses, through the door the boundary cannot watch', () => {
  // asSystem().sql reaches SQLite past every rule this package owns — the same
  // door a migration, a seed and a raw statement come through. What holds here
  // is STRICT, which litestone already emits on every table, and the reason
  // @big needs no CHECK of its own: @scale's bound is NARROWER than the
  // column's, so only a CHECK can hold it, while @big's bound IS the column's.
  test('past int64, which a loose table would store as REAL 9.22e+18', async () => {
    const db = await client()
    await expect(
      db.asSystem().sql`INSERT INTO post (title, snowflake) VALUES ('m', '9223372036854775808')`
    ).rejects.toThrow(/INTEGER column/)
  })

  test('a non-numeric string, which a loose INTEGER column stores as TEXT', async () => {
    const db = await client()
    await expect(
      db.asSystem().sql`INSERT INTO post (title, snowflake) VALUES ('n', 'abc')`
    ).rejects.toThrow(/INTEGER column/)
  })

  test('a fraction', async () => {
    const db = await client()
    await expect(
      db.asSystem().sql`INSERT INTO post (title, snowflake) VALUES ('o', 1.5)`
    ).rejects.toThrow(/INTEGER column/)
  })

  test('and the control — a wide value through the same door is accepted', async () => {
    const db = await client()
    await db.asSystem().sql`INSERT INTO post (title, snowflake) VALUES ('p', '9007199254740993')`
    const row = await db.post.findFirst({ where: { title: 'p' } })
    expect(row.snowflake).toBe(BIG)
  })

  // The one shape that turned STRICT off is the one shape that earns the CHECK,
  // and a table that has both would emit a constraint whose message can never
  // appear — which is worse than none, because it reads as the thing doing the
  // work.
  test('a STRICT table emits no CHECK, because STRICT already refuses all three', () => {
    const ddl = generateDDL(parse(SCHEMA).schema)
    expect(ddl).toContain('STRICT')
    expect(ddl).not.toContain(`typeof("snowflake")`)
  })

  test('@@noStrict emits it, and it is then the only thing holding the column', async () => {
    const src = `
      database main { path ":memory:" }
      model Loose { id Int @id @default(autoincrement())  v Int @big  @@noStrict }
    `
    const ddl = generateDDL(parse(src).schema)
    expect(ddl).not.toContain(') STRICT')
    expect(ddl).toContain(`CHECK ("v" IS NULL OR typeof("v") = 'integer')`)

    // And it fires, which is the half a DDL assertion cannot say.
    const db = await client(src)
    await expect(
      db.asSystem().sql`INSERT INTO loose (v) VALUES ('9223372036854775808')`
    ).rejects.toThrow(/CHECK/)
    await db.asSystem().sql`INSERT INTO loose (v) VALUES ('9007199254740993')`
    expect((await db.loose.findFirst({})).v).toBe(BIG)
  })
})

describe('what the boundary refuses, and why it is a different sentence', () => {
  test('a fraction is refused by name rather than by the CHECK', async () => {
    const db = await client()
    // The CHECK would refuse this too, naming a physical column and no way to
    // fix it. The boundary says what to send instead.
    const err: any = await db.post.create({ data: { title: 'q', snowflake: 1.5 } }).catch(e => e)
    expect(err.constructor.name).toBe('ValidationError')
    expect(JSON.stringify(err.errors)).toMatch(/string of digits/)
  })

  test('a number past 2^53 is refused, because it is already a guess', async () => {
    const db = await client()
    const err: any = await db.post.create({ data: { title: 'r', snowflake: 9007199254740993 } })
      .catch(e => e)
    expect(err.constructor.name).toBe('ValidationError')
  })

  test('digits past int64 name the range, not the format', async () => {
    const db = await client()
    const err: any = await db.post.create({ data: { title: 's', snowflake: '9223372036854775808' } })
      .catch(e => e)
    expect(err.constructor.name).toBe('ValidationError')
    expect(JSON.stringify(err.errors)).toMatch(/64-bit/)
  })

  test('a non-numeric string', async () => {
    const db = await client()
    const err: any = await db.post.create({ data: { title: 't', snowflake: 'abc' } }).catch(e => e)
    expect(err.constructor.name).toBe('ValidationError')
  })
})

describe('the schema refuses what cannot hold 64 bits', () => {
  // parse() reports rather than throwing, so the assertion is on the message —
  // which is the thing an author reads.
  const refuses = (schema: string, match: RegExp) => {
    const { valid, errors } = parse(schema)
    expect(valid).toBe(false)
    expect(errors.join('\n')).toMatch(match)
  }

  test('@big on a Float', () => {
    refuses(`model A { id Int @id  v Float @big }`, /@big requires an Int field/)
  })

  test('@big on a String', () => {
    refuses(`model A { id Int @id  v String @big }`, /@big requires an Int field/)
  })

  test('@big on an array, which is stored as JSON', () => {
    refuses(`model A { id Int @id  v Int[] @big }`, /@big cannot be an array/)
  })

  test('@big with @scale, which bounds the column for the opposite reason', () => {
    refuses(`model A { id Int @id  v Int @big @scale(2) }`, /@big and @scale together/)
  })

  test('@big with @money', () => {
    refuses(`model A { id Int @id  v Int @big @money(USD) }`, /@big and @money together/)
  })

  test('and the control — @big on an Int parses', () => {
    expect(parse(`model A { id Int @id  v Int @big }`).valid).toBe(true)
  })
})

describe('a wide key', () => {
  // The case that arrives first in the field: a snowflake id, which Discord and
  // Twitter/X passed 2^53 years ago.
  const KEYED = `
    database main { path ":memory:" }
    model Event {
      id   Int    @id @big
      name String
    }
  `

  test('a row keyed past 2^53 is created, found and updated by that key', async () => {
    const db = await client(KEYED)
    const made = await db.event.create({ data: { id: BIG, name: 'one' } })
    expect(made.id).toBe(BIG)

    const found = await db.event.findUnique({ where: { id: BIG } })
    expect(found?.name).toBe('one')

    const up = await db.event.update({ where: { id: BIG }, data: { name: 'two' } })
    expect(up.id).toBe(BIG)
    expect(up.name).toBe('two')

    // The control: the key that would be found if the value had rounded.
    const wrong = await db.event.findUnique({ where: { id: '9007199254740992' } })
    expect(wrong).toBeNull()
  })

  test('and it can be deleted by that key', async () => {
    const db = await client(KEYED)
    await db.event.create({ data: { id: BIG, name: 'gone' } })
    await db.event.delete({ where: { id: BIG } })
    expect(await db.event.count()).toBe(0)
  })
})
