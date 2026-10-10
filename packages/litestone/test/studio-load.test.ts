// Studio's cost on a big database (FJS-2319): what one request may count, what
// the Query Log may record on its own, and how many rows the SQL panel returns.
//
// Spawns the real CLI, since the endpoints live inside cmdStudio's closure.
//
// Run with:  bun test test/studio-load.test.ts

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'

const CLI = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')

const SCHEMA = `
model Event {
  id        Int      @id
  kind      String
  deletedAt DateTime?

  @@softDelete
}

model Tag {
  id    Int    @id
  label String
}
`

const LIVE = 1500, GONE = 40, TAGS = 7

let dir: string
let proc: ReturnType<typeof Bun.spawn>
let base: string

async function cli(args: string[]) {
  const p = Bun.spawn(['bun', CLI, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  await p.exited
}

async function post(path: string, body: unknown = {}) {
  const r = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  return r.json() as Promise<any>
}

const countsLogged = async () =>
  (await post('/api/querylog')).entries.filter((e: any) => e.operation === 'count').length

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studio-load-'))
  writeFileSync(join(dir, 'schema.lite'), SCHEMA)
  writeFileSync(join(dir, 'litestone.config.js'),
    `export default { schema: './schema.lite', migrations: './migrations', db: './test.db' }\n`)
  mkdirSync(join(dir, 'migrations'))
  await cli(['migrate', 'create', 'init'])
  await cli(['migrate', 'apply'])

  const raw = new Database(join(dir, 'test.db'))
  const table = (raw.query(`SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'event%'`).get() as any).name
  const tags  = (raw.query(`SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'tag%'`).get() as any).name
  raw.transaction(() => {
    for (let i = 1; i <= LIVE + GONE; i++)
      raw.run(`INSERT INTO "${table}" (id, kind, deletedAt) VALUES (?, 'x', ?)`, [i, i > LIVE ? '2026-01-01T00:00:00.000Z' : null])
    for (let i = 1; i <= TAGS; i++) raw.run(`INSERT INTO "${tags}" (id, label) VALUES (?, 't')`, [i])
  })()
  raw.close()

  proc = Bun.spawn(['bun', CLI, 'studio', '--port=0', '--no-open'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  const reader = proc.stdout.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && !/localhost:(\d+)/.test(buf)) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
  }
  base = `http://localhost:${buf.match(/localhost:(\d+)/)![1]}`
}, 30_000)

afterAll(async () => {
  try { proc.kill('SIGTERM') } catch {}
  try { await proc.exited } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('Studio load (FJS-2319)', () => {
  test('/api/info counts each table once, excludes soft-deleted rows, and logs nothing', async () => {
    await post('/api/querylog', { clear: true })
    const info = await fetch(`${base}/api/info`).then(r => r.json())
    expect(info.counts.Event).toBe(LIVE)
    expect(info.counts.Tag).toBe(TAGS)
    expect((await post('/api/querylog')).entries).toEqual([])
  })

  test('a Browse page past the first does not recount the table', async () => {
    await post('/api/querylog', { clear: true })
    const first = await post('/api/table', { table: 'Event', pageSize: 10 })
    expect(first.total).toBe(LIVE)
    expect(await countsLogged()).toBe(1)

    const second = await post('/api/table', { table: 'Event', pageSize: 10, cursor: first.nextCursor })
    expect(second.items.length).toBe(10)
    expect(second.total).toBeUndefined()
    expect(await countsLogged()).toBe(1)
  })

  test('the SQL panel stops at a row cap and says so', async () => {
    const big = await post('/api/query', { sql: 'SELECT * FROM event' })
    expect(big.truncated).toBe(true)
    expect(big.rows.length).toBeLessThan(LIVE)
    expect(big.rows.length).toBe(big.cap)

    const small = await post('/api/query', { sql: 'SELECT * FROM tag' })
    expect(small.rows.length).toBe(TAGS)
    expect(small.truncated).toBe(false)

    // a trailing comment must not swallow the wrapper's closing paren
    const commented = await post('/api/query', { sql: 'SELECT * FROM tag -- all of them' })
    expect(commented.error).toBeUndefined()
    expect(commented.rows.length).toBe(TAGS)
  })
})
