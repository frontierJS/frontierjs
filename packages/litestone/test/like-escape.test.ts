// `contains`, `startsWith` and `endsWith` look for TEXT, not a pattern
// (FJS-1464). A person's `50%` or `snake_case` handed to LIKE raw is a wildcard,
// and `contains: '_'` answered every row.

import { describe, test, expect, beforeAll } from 'bun:test'
import { Database } from 'bun:sqlite'
import { join } from 'path'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { splitStatements } from '../src/core/migrate.js'
import { createClient } from '../src/core/client.js'
import { tempDir } from '../src/tmp-dirs.js'

const TMP = tempDir('litestone-like-escape-')

const SCHEMA = `
  type Meta { label String }
  model Verse {
    id   Int    @id
    ref  String
    body String
    meta Json? @type(Meta)
  }
`

const ROWS = [
  { id: 1, ref: 'John 3:16',  body: 'plain words',      meta: { label: 'plain' } },
  { id: 2, ref: 'j_x',        body: 'snake_case here',  meta: { label: 'snake_case' } },
  { id: 3, ref: '50% off',    body: 'half 50% done',    meta: { label: '50%' } },
  { id: 4, ref: 'back\\slash', body: 'a\\b path',       meta: { label: 'a\\b' } },
  { id: 5, ref: 'Judges 1:1', body: 'genealogy',        meta: { label: 'genealogy' } },
]

let db: any
const ids = async (where: any) => (await db.verse.findMany({ where, orderBy: { id: 'asc' } })).map((r: any) => r.id)

beforeAll(async () => {
  const path = join(TMP, `le-${Math.random().toString(36).slice(2)}.db`)
  const parsed = parse(SCHEMA)
  if (!parsed.valid) throw new Error(parsed.errors.join('\n'))
  const raw = new Database(path)
  for (const stmt of splitStatements(generateDDL(parsed.schema)))
    if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
  raw.close()
  db = await createClient({ parsed, db: path })
  for (const data of ROWS) await db.verse.create({ data })
})

describe('a text operator treats its operand as text, not a pattern', () => {
  test('contains: _ and % match only rows that hold them', async () => {
    expect(await ids({ body: { contains: '_' } })).toEqual([2])
    expect(await ids({ body: { contains: '%' } })).toEqual([3])
    expect(await ids({ body: { contains: 'gene%logy' } })).toEqual([])
  })

  test('startsWith and endsWith', async () => {
    expect(await ids({ ref: { startsWith: 'j_' } })).toEqual([2])
    expect(await ids({ ref: { startsWith: '%' } })).toEqual([])
    expect(await ids({ ref: { startsWith: '50%' } })).toEqual([3])
    expect(await ids({ ref: { endsWith: '_x' } })).toEqual([2])
    expect(await ids({ ref: { endsWith: '%' } })).toEqual([])
  })

  test('a backslash is a backslash', async () => {
    expect(await ids({ body: { contains: '\\' } })).toEqual([4])
    expect(await ids({ ref: { startsWith: 'back\\' } })).toEqual([4])
  })

  test('an ordinary operand still matches as before', async () => {
    expect(await ids({ body: { contains: 'words' } })).toEqual([1])
    expect(await ids({ ref: { startsWith: 'Jo' } })).toEqual([1])
  })

  test('the same on a JSON path', async () => {
    expect(await ids({ meta: { label: { contains: '_' } } })).toEqual([2])
    expect(await ids({ meta: { label: { startsWith: '%' } } })).toEqual([])
    expect(await ids({ meta: { label: { endsWith: '%' } } })).toEqual([3])
    expect(await ids({ meta: { label: { contains: '\\' } } })).toEqual([4])
  })
})
