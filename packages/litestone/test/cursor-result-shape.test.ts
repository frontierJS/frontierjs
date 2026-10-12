// test/cursor-result-shape.test.ts
//
// FJS-1813: `findManyCursor` answers `{ items, nextCursor, hasMore }` and the
// hand-written `CursorResult` said `rows`, so a caller following the type read
// `page.rows` and got undefined. `cursorFor` — the one way to mint an edge for a
// row already taken — existed on the table and in neither declaration, so a
// merge of two windows was written against `as any`.

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createClient } from '../src/index.js'
import { parse } from '../src/core/parser.js'
import { generateTypeScript } from '../src/tools/typegen.js'

const SCHEMA = `
  database main { path ":memory:" }
  model Task { id Int @id @default(autoincrement())  title String  @@db(main) }
`

const DTS = readFileSync(resolve(import.meta.dir, '../src/index.d.ts'), 'utf8')

/** The body of `export interface <name> … {` up to its closing brace at column 0. */
const body = (src: string, name: string) =>
  new RegExp(`export interface ${name}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(src)?.[1] ?? ''

describe('findManyCursor result shape is the one declared', () => {
  test('the client answers items, and cursorFor mints the edge of a taken row', async () => {
    const db: any = await createClient({ databases: ':memory:', schema: SCHEMA })
    for (const title of ['a', 'b', 'c']) await db.asSystem().task.create({ data: { title } })
    const page = await db.asSystem().task.findManyCursor({ limit: 2, orderBy: { id: 'asc' } })
    expect(page.rows).toBeUndefined()
    expect(page.items.length).toBe(2)
    const edge = db.asSystem().task.cursorFor(page.items[1], [{ id: 'asc' }])
    expect(edge).toBe(page.nextCursor)
  })

  test('index.d.ts: CursorResult.items, and TableClient declares cursorFor', () => {
    const cr = body(DTS, 'CursorResult')
    expect(cr).toMatch(/\bitems:/)
    expect(cr).not.toMatch(/\brows:/)
    expect(body(DTS, 'TableClient')).toMatch(/\bcursorFor\(/)
  })

  test('typegen: CursorResult.items, and the emitted TableClient declares cursorFor', () => {
    const out = generateTypeScript(parse(SCHEMA).schema)
    expect(body(out, 'CursorResult')).toMatch(/\bitems:/)
    expect(body(out, 'TableClient')).toMatch(/\bcursorFor\(/)
  })
})
