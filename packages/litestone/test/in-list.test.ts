// in-list.test.ts — a long IN list is one bound JSON array, and answers what the bound list did.
//
// `IN (?, …, ?)` is a new statement for every length, and past 65,535 values
// Bun answers *expected 34464 values* (`FJS-620` M5). Past four values a list
// binds as one JSON array instead. The two forms disagree unless the subquery
// casts, because a json_each value takes no column affinity: `"name" IN (1)`
// matched the text `'1'` and the uncast JSON form missed it. So the oracle here
// is SQLite's own bound list, written out by hand, column type by column type —
// never `inList`'s short form, which is the code under test.

import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/index.js'
import { inList } from '../src/core/query.js'
import { matchesQuery } from '@frontierjs/toolbelt/match'

// Six values, so every list here takes the JSON form.
const LISTS: unknown[][] = [
  [1, 2, 3, 4, 10, 99],
  ['1', '2', 'a', '10', 'x y', ''],
  [1, 'a', 2.5, '10', 0.1, 77],
  [true, false, 5, 6, 7, 8],
  [null, 1, 'a', 3, 4, 5],
  [0.30000000000000004, 1 / 3, 1e20, 2.5, 0.1, 9007199254740991],
  ['01', '1.0', '0.30000000000000004', 'a', 'b', 'c'],
]

describe('inList answers what the bound list answers', () => {
  const db = new Database(':memory:')
  db.run('CREATE TABLE t (id INTEGER PRIMARY KEY, i INTEGER, s TEXT, r REAL, a ANY) STRICT')
  db.run('CREATE INDEX t_i ON t(i)')
  db.run('CREATE INDEX t_s ON t(s)')
  const rows = [
    [1, 1, '1', 1, 1], [2, 2, 'a', 2.5, 'a'], [3, null, null, null, null], [4, 10, '10', 0.1, '1'],
    [5, 9007199254740991, 'x y', 1e20, 1.5], [6, 3, '0.30000000000000004', 0.30000000000000004, 0.30000000000000004],
    [7, 4, '01', 1 / 3, 1 / 3], [8, 5, '', 2.5, ''],
  ]
  for (const r of rows) db.query('INSERT INTO t VALUES (?, ?, ?, ?, ?)').run(...(r as any[]))
  const ids = (sql: string, params: unknown[]) => db.query(sql).all(...(params as any[])).map((r: any) => r.id).join()

  // `a` is ANY: no affinity, so the cast would turn 1 into '1' there.
  for (const [col, affinity] of [['id', true], ['i', true], ['s', true], ['r', true], ['a', false]] as const) {
    for (const not of [false, true]) {
      test(`${col} ${not ? 'NOT IN' : 'IN'}`, () => {
        for (const list of LISTS) {
          const bound = ids(`SELECT id FROM t WHERE ${col} ${not ? 'NOT IN' : 'IN'} (${list.map(() => '?').join(', ')}) ORDER BY id`, list)
          const params: unknown[] = []
          const sql = inList(col, list, params, { not, affinity })
          expect(sql).toContain('json_each')
          expect([JSON.stringify(list), ids(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)])
            .toEqual([JSON.stringify(list), bound])
        }
      })
    }
  }

  test('a big integer travels as its digits', () => {
    db.run('INSERT INTO t (id, i) VALUES (9, 9007199254740993)')
    const params: unknown[] = []
    const list = [9007199254740993n, 1n, 2n, 3n, 4n]
    const sql = inList('i', list, params)
    const bound = ids('SELECT id FROM t WHERE i IN (?, ?, ?, ?, ?) ORDER BY id', list)
    expect(bound).toContain('9')
    expect(ids(`SELECT id FROM t WHERE ${sql} ORDER BY id`, params)).toBe(bound)
  })

  test('the index still answers the lookup', () => {
    const params: unknown[] = []
    const plan = db.query(`EXPLAIN QUERY PLAN SELECT * FROM t WHERE ${inList('s', ['a', 'b', 'c', 'd', 'e'], params)}`)
      .all(...(params as any[])).map((r: any) => r.detail).join(' | ')
    expect(plan).toContain('USING INDEX t_s')
  })

  test('a value JSON cannot carry exactly keeps the bound list', () => {
    for (const odd of [new Uint8Array([1]), NaN, Infinity, new Date(0), '\ud800']) {
      const params: unknown[] = []
      expect(inList('s', ['a', 'b', 'c', 'd', odd], params)).toBe('s IN (?, ?, ?, ?, ?)')
      expect(params).toHaveLength(5)
    }
  })
})

describe('through the client', () => {
  async function client() {
    const db: any = await createClient({ db: ':memory:', schema: `
      model Author { id Int @id  name String  posts Post[]  deletedAt DateTime?  @@softDelete(cascade) }
      model Post {
        id       Int      @id
        title    String
        authorId Int
        author   Author   @relation(fields: [authorId], references: [id], onDelete: Cascade)
        tags     String[]
        deletedAt DateTime?
        @@softDelete
      }
    ` })
    const sys = db.asSystem()
    await sys.author.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: String(i % 7) })) })
    await sys.post.createMany({ data: Array.from({ length: 90 }, (_, i) => ({
      id: i + 1, title: `p${i}`, authorId: (i % 30) + 1, tags: [`t${i % 5}`],
    })) })
    return { db, sys }
  }

  test('a long `in` on a String field given numbers answers what each equality answers', async () => {
    const { db, sys } = await client()
    const list = [0, 1, 2, 3, 4, 5]
    const union = new Set<number>()
    for (const v of list) for (const r of await sys.author.findMany({ where: { name: String(v) } })) union.add(r.id)
    const got = (await sys.author.findMany({ where: { name: { in: list } } })).map((r: any) => r.id)
    expect(new Set(got)).toEqual(union)
    const not = (await sys.author.findMany({ where: { name: { notIn: list } } })).map((r: any) => r.id)
    expect(new Set([...got, ...not]).size).toBe(30)
    expect(not.some((id: number) => union.has(id))).toBe(false)
    db.$close()
  })

  test('every list length past four is one statement, and 100,000 values answer', async () => {
    const { db, sys } = await client()
    const seen = new Set<string>()
    db.$tapQuery((q: any) => { if (q?.sql?.includes('json_each')) seen.add(q.sql) })
    for (let n = 5; n <= 64; n++) await sys.author.findMany({ where: { id: { in: Array.from({ length: n }, (_, i) => i + 1) } } })
    expect(seen.size).toBe(1)
    const many = Array.from({ length: 100_000 }, (_, i) => i + 1)
    expect(await sys.author.count({ where: { id: { in: many } } })).toBe(30)
    expect(await sys.post.count({ where: { tags: { hasNone: ['t0', 't1', 't2', 't3', 't4', 'zz'] } } })).toBe(0)
    db.$close()
  })

  test('an include and a cascade over thirty parents reach every child', async () => {
    const { db, sys } = await client()
    const authors = await sys.author.findMany({ include: { posts: true, _count: { select: { posts: true } } } })
    expect(authors.every((a: any) => a.posts.length === 3 && a._count.posts === 3)).toBe(true)
    const posts = await sys.post.findMany({ include: { author: true } })
    expect(posts.every((p: any) => p.author?.id === p.authorId)).toBe(true)

    await sys.author.removeMany({ where: {} })
    expect(await sys.post.count()).toBe(0)
    expect(await sys.post.count({ withDeleted: true } as any)).toBe(90)
    db.$close()
  })
})

// `IN (NULL)` is never true and `NOT IN` drops every NULL row, so a null member
// read as SQL matched nothing under `in` and only the nulls under `notIn` —
// while the JSONL driver and the live-list matcher read it as *is null*.
// Expected ids are written by hand (`FJS-597`), and every store is asked:
// a column, a key inside a typed Json column, a jsonl file and the matcher
// (`FJS-3580`).
describe('a null member is the IS NULL test', () => {
  const CASES: [string, unknown, string][] = [
    ['in [null]',                  { in: [null] },                          '3'],
    ["in [null, '']",              { in: [null, ''] },                      '3,4'],
    ["in [null, 'a']",             { in: [null, 'a'] },                     '1,3'],
    ["in [null, ''] past four",    { in: [null, '', 'x', 'y', 'z', 'w'] },  '3,4'],
    ['bare [null]',                [null],                                  '3'],
    ["bare [null, 'b']",           [null, 'b'],                             '2,3'],
    ['notIn [null]',               { notIn: [null] },                       '1,2,4'],
    ["notIn [null, '']",           { notIn: [null, ''] },                   '1,2'],
    ["notIn [null, ''] past four", { notIn: [null, '', 'x', 'y', 'z', 'w'] }, '1,2'],
    ["notIn ['a']",                { notIn: ['a'] },                        '2,3,4'],
  ]
  const BODIES = ['a', 'b', null, '']
  const ids = (rows: any[]) => rows.map((r: any) => r.n).sort().join()

  for (const [name, where, want] of CASES) {
    test(name, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'lite-null-member-'))
      const db: any = await createClient({ schema: `
        database main { path ":memory:" }
        database logs { path "${join(dir, 'logs')}"  driver jsonl }
        type Box { body String? }
        model Note { n Int @id  body String?  box Json @type(Box) }
        model Line { n Int  body String?  @@db(logs) }
      ` })
      const sys = db.asSystem()
      const rows = BODIES.map((body, i) => ({ n: i + 1, body }))
      await sys.note.createMany({ data: rows.map(r => ({ ...r, box: { body: r.body } })) })
      for (const r of rows) await sys.line.create({ data: r })

      const got = {
        column: ids(await sys.note.findMany({ where: { body: where } })),
        typed:  ids(await sys.note.findMany({ where: { box: { body: where } } })),
        jsonl:  ids(await sys.line.findMany({ where: { body: where } })),
        live:   ids(rows.filter(r => matchesQuery({}, r, { body: where }))),
      }
      expect(got).toEqual({ column: want, typed: want, jsonl: want, live: want })
      db.$close()
      rmSync(dir, { recursive: true, force: true })
    })
  }
})
