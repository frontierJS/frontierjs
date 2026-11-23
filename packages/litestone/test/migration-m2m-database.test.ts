// FJS-2076 — a migration for one database carries only the implicit m2m join
// tables of the models that database holds. A join table written into the wrong
// database references tables that exist only in main.

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import { createForDatabase, create } from '../src/core/migrations.js'

const SCHEMA = `
model Task {
  id       String    @id @default(uuid())
  messages Message[]
}
model Message {
  id    String @id @default(uuid())
  tasks Task[]
}
model Parcel {
  id String @id @default(uuid())
  @@db(parcels)
}
`

describe('implicit m2m join tables follow their models\' database', () => {
  it('a second database migration holds no join table of main', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-m2m-db-'))
    try {
      const parsed = parse(SCHEMA)
      const out = createForDatabase(new Database(':memory:'), parsed, 'parcels', 'init', dir) as any
      expect(out.created).toBe(true)
      const sql = readdirSync(dir).filter(f => f.endsWith('.sql')).map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
      expect(sql).toContain('CREATE TABLE')
      expect(sql).toContain('"parcel"')
      expect(sql).not.toContain('_message_task')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('the main migration still carries its join table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-m2m-db-'))
    try {
      const out = createForDatabase(new Database(':memory:'), parse(SCHEMA), 'main', 'init', dir) as any
      expect(out.created).toBe(true)
      const sql = readdirSync(dir).filter(f => f.endsWith('.sql')).map(f => readFileSync(join(dir, f), 'utf8')).join('\n')
      expect(sql).toContain('_message_task')
      expect(sql).not.toContain('"parcel"')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

// FJS-4569 — a join table is invisible to introspection, so a self-relation
// added to a model the history already builds compared equal on every
// dimension, and `migrate dev` answered that no migration was needed.
describe('an implicit m2m added to a model that already exists', () => {
  const BEFORE = `
model Person {
  id String @id @default(uuid())
}
`
  const AFTER = `
model Person {
  id       String   @id @default(uuid())
  friends  Person[] @relation("friends")
  friendOf Person[] @relation("friends")
}
`
  const files = (dir: string) => readdirSync(dir).filter(f => f.endsWith('.sql'))

  it('gets a migration that writes its join table, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ls-m2m-added-'))
    try {
      expect((create(null, parse(BEFORE), 'one', dir) as any).created).toBe(true)
      const two = create(null, parse(AFTER), 'two', dir) as any
      expect(two.created).toBe(true)
      expect(two.summary).toContain('_friends')
      const written = files(dir).find(f => f.endsWith('_two.sql'))!
      expect(readFileSync(join(dir, written), 'utf8')).toContain('CREATE TABLE IF NOT EXISTS "_friends"')

      // The written file is what the history builds, so it does not ask again.
      expect((create(null, parse(AFTER), 'three', dir) as any).created).toBe(false)
      expect(files(dir)).toHaveLength(2)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
