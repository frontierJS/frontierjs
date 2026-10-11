// FJS-2164: a Bytes column in a trail snapshot is base64, the form the JSON
// Schema already names for Bytes — not an object keyed by byte index.
import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { splitStatements } from '../src/core/migrate.js'
import { createClient } from '../src/core/client.js'

const SCHEMA = `
  database main  { path env("MAIN_DB", "./main.db") }
  database audit { path "./audit/" driver trail }

  model Invoice {
    id    Int    @id
    name  String
    pdf   Bytes?

    @@db(main)
    @@trail(audit)
  }
`

async function makeDb(onLog: (...args: any[]) => any) {
  const r = parse(SCHEMA)
  if (!r.valid) throw new Error(r.errors.join('\n'))
  const dir = mkdtempSync(join(tmpdir(), 'ls-trail-bytes-'))
  const mainPath  = join(dir, 'main.db')
  const auditPath = join(dir, 'audit')
  mkdirSync(auditPath, { recursive: true })
  const raw = new Database(mainPath)
  raw.run('PRAGMA journal_mode = WAL')
  for (const s of splitStatements(generateDDL(r.schema)))
    if (!s.startsWith('PRAGMA')) raw.run(s)
  raw.close()
  return createClient({ parsed: r, databases: { main: { path: mainPath }, audit: { path: auditPath } }, onLog })
}

const flush = () => new Promise<void>(res => setTimeout(res, 20))

describe('@@trail and a Bytes column', () => {
  test('before and after hold the bytes as base64, on create and on every later update', async () => {
    const calls: any[] = []
    const db = await makeDb((entry) => { calls.push(entry) })
    const bytes = new Uint8Array([37, 80, 68, 70, 0, 255, 128])
    const b64 = Buffer.from(bytes).toString('base64')
    const row = await db.asSystem().invoice.create({ data: { name: 'a', pdf: bytes } })
    await db.asSystem().invoice.update({ where: { id: row.id }, data: { name: 'b' } })
    await flush()
    const snaps = calls.filter(e => e.model === 'Invoice' && e.field == null)
    expect(snaps.length).toBe(2)
    expect(JSON.parse(snaps[0].after).pdf).toBe(b64)
    expect(JSON.parse(snaps[1].before).pdf).toBe(b64)
    expect(JSON.parse(snaps[1].after).pdf).toBe(b64)
    db.$close()
  })
})
