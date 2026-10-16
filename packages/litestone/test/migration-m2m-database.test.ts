// FJS-2076 — a migration for one database carries only the implicit m2m join
// tables of the models that database holds. A join table written into the wrong
// database references tables that exist only in main.

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import { createForDatabase } from '../src/core/migrations.js'

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
