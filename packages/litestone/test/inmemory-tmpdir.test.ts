// inmemory-tmpdir.test.ts — FJS-3329: an in-memory client owns the temp dir it
// made for a jsonl/trail database, and $close removes it.

import { describe, test, expect } from 'bun:test'
import { existsSync } from 'fs'
import { createClient } from '../src/index.js'

const SCHEMA = `
  database main  { path ":memory:" }
  database audit { path "./audit/" driver trail }
  model Thing { id String @id @default(uuid())  name String  @@trail(audit) }
`

const tick = () => new Promise((r) => setImmediate(r))

describe('an in-memory client with a trail database', () => {
  test('$close removes the directory createClient made for it', async () => {
    const db: any = await createClient({ schema: SCHEMA, databases: ':memory:' })
    const dir: string = db.$databases.audit.path ?? db.$databases.audit.absPath
    await db.asSystem().thing.create({ data: { name: 'x' } })
    await tick()
    expect(dir).toContain('litestone-audit-')
    expect(existsSync(dir)).toBe(true)
    await db.$close()
    expect(existsSync(dir)).toBe(false)
  })

  test('a file-backed client leaves its trail directory alone', async () => {
    const { mkdtempSync, rmSync } = await import('fs')
    const { tmpdir } = await import('os')
    const { join } = await import('path')
    const root = mkdtempSync(join(tmpdir(), 'fjs-3329-'))
    try {
      const db: any = await createClient({
        schema: `
          database main  { path ":memory:" }
          database audit { path "${root}/audit/" driver trail }
          model Thing { id String @id @default(uuid())  name String  @@trail(audit) }
        `,
        resolveFrom: root,
      })
      await db.asSystem().thing.create({ data: { name: 'x' } })
      await tick()
      await db.$close()
      expect(existsSync(join(root, 'audit'))).toBe(true)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
