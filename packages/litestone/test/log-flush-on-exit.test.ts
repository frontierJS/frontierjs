// log-flush-on-exit.test.ts — a committed write's `@@trail` line survives the process ending.
//
// `fireLog` defers the append one tick, so a script that ends in `process.exit`
// or dies on a throw right after `await create()` left the row in main and no
// line in the trail (`FJS-1481`). Each case is its own process, because the
// loss is what happens when the process ends.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Database } from 'bun:sqlite'

const INDEX = join(import.meta.dir, '..', 'src', 'index.js')

async function run(ending: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-logexit-'))
  try {
    const script = `
      import { createClient } from ${JSON.stringify(INDEX)}
      const db = await createClient({ resolveFrom: ${JSON.stringify(dir)}, schema: \`
        database main  { path "${dir}/main.db" }
        database audit { path "${dir}/audit/" driver trail }
        model Thing { id String @id @default(uuid())  name String  @@trail(audit) }
      \` })
      await db.asSystem().thing.create({ data: { name: 'x' } })
      ${ending}
    `
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
    const file = join(dir, 'audit', 'AuditTrail.jsonl')
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('the audit line survives the process ending in the same tick', () => {
  test('process.exit right after the write', async () => {
    expect(await run('process.exit(0)')).toBe(1)
  })
  test('an uncaught throw right after the write', async () => {
    expect(await run("throw new Error('boom')")).toBe(1)
  })
  test('db.$close() right after the write', async () => {
    expect(await run('await db.$close()')).toBe(1)
  })
  test('ending naturally still writes exactly one line', async () => {
    expect(await run('')).toBe(1)
  })
})

// A SQL trail's `create` awaits its pipeline, so the jsonl driver's
// synchronous append does not carry over: the row was in main and nothing in
// the audit database (`FJS-3101`).
async function runSql(write: string, ending: string) {
  const dir = mkdtempSync(join(tmpdir(), 'fjs-logexit-sql-'))
  try {
    const script = `
      import { createClient, autoMigrate } from ${JSON.stringify(INDEX)}
      const db = await createClient({ resolveFrom: ${JSON.stringify(dir)}, schema: \`
        database main  { path "${dir}/main.db" }
        database audit { path "${dir}/audit.db" model AuditTrail }
        model AuditTrail { id String @id @default(uuid())  model String  operation String  createdAt DateTime @default(now())  @@db(audit) }
        model Thing { id String @id @default(uuid())  name String  @@trail(audit) }
      \` })
      await autoMigrate(db)
      const sys = db.asSystem()
      ${write}
      ${ending}
    `
    const proc = Bun.spawn(['bun', '-e', script], { stdout: 'ignore', stderr: 'ignore' })
    await proc.exited
    const audit = new Database(join(dir, 'audit.db'), { readonly: true })
    try { return (audit.query('SELECT model, operation FROM audit_trail').all() as any[]) } finally { audit.close() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

describe('a SQL trail line survives the process ending in the same tick', () => {
  const one   = "await sys.thing.create({ data: { name: 'x' } })"
  const three = "await sys.thing.createMany({ data: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] })"
  test('process.exit right after a create', async () => {
    expect(await runSql(one, 'process.exit(0)')).toEqual([{ model: 'Thing', operation: 'create' }])
  })
  test('process.exit right after a createMany', async () => {
    const natural = await runSql(three, '')
    expect(natural.length).toBeGreaterThan(0)
    expect(await runSql(three, 'process.exit(0)')).toEqual(natural)
  })
  test('an uncaught throw right after the write', async () => {
    expect((await runSql(one, "throw new Error('boom')")).length).toBe(1)
  })
  test('db.$close() right after the write', async () => {
    expect((await runSql(one, 'await db.$close()')).length).toBe(1)
  })
  test('ending naturally still writes exactly one row', async () => {
    expect((await runSql(one, '')).length).toBe(1)
  })
})
