// Studio over a slow link (FJS-2322): what the server lets a client skip. The
// page and the catalog are compressed and revalidated, and every answer carries
// a revision that moves on a write from Studio, a write from outside, and a
// DDL change, so a panel refetches only when the revision has.
//
// Spawns the real CLI, since the endpoints live inside cmdStudio's closure.
//
// Run with:  bun test test/studio-transport.test.ts

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'

const CLI  = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')
const HTML = readFileSync(resolve(import.meta.dir, '..', 'src', 'tools', 'studio.html'), 'utf8')
const STUDIO_CSS = readFileSync(resolve(import.meta.dir, '..', 'src', 'tools', 'studio.css'), 'utf8')

const SCHEMA = `
model Tag {
  id    Int    @id
  label String
}
`

let dir: string
let proc: ReturnType<typeof Bun.spawn>
let base: string
let raw: Database

async function cli(args: string[]) {
  const p = Bun.spawn(['bun', CLI, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
  await p.exited
}

const get  = (path: string, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { headers: { 'Accept-Encoding': 'gzip', ...headers } })
const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const rev  = async (path = '/api/drift') => (await get(path)).headers.get('x-studio-rev')

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studio-transport-'))
  writeFileSync(join(dir, 'schema.lite'), SCHEMA)
  writeFileSync(join(dir, 'litestone.config.js'),
    `export default { schema: './schema.lite', migrations: './migrations', db: './test.db' }\n`)
  mkdirSync(join(dir, 'migrations'))
  await cli(['migrate', 'create', 'init'])
  await cli(['migrate', 'apply'])
  raw = new Database(join(dir, 'test.db'))

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
  try { raw.close() } catch {}
  try { proc.kill('SIGTERM') } catch {}
  try { await proc.exited } catch {}
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
})

describe('Studio transport (FJS-2322)', () => {
  test('the page is gzipped, tagged, and answered 304 to a matching tag', async () => {
    const first = await get('/')
    expect(first.headers.get('content-encoding')).toBe('gzip')
    expect(first.headers.get('cache-control')).toBe('no-cache')
    const tag = first.headers.get('etag')
    expect(tag).toBeTruthy()
    expect(await first.text()).toContain('<title')

    const again = await get('/', { 'If-None-Match': tag! })
    expect(again.status).toBe(304)
  })

  test('a client that does not ask for gzip gets plain bytes', async () => {
    const r = await fetch(`${base}/`, { headers: { 'Accept-Encoding': 'identity' } })
    expect(r.headers.get('content-encoding')).toBeNull()
  })

  // FJS-2665: a --host Studio with no egress renders unstyled if any asset is remote.
  test('the page names no remote stylesheet or font, and serves its own stylesheet', async () => {
    const page = await (await get('/')).text()
    expect(page).not.toMatch(/<link[^>]+rel="stylesheet"[^>]+href="https?:/)
    expect(page).not.toMatch(/@import\s+url\(\s*['"]?https?:/)
    expect(page).toContain('href="/studio.css"')

    const css = await get('/studio.css')
    expect(css.status).toBe(200)
    expect(css.headers.get('content-type')).toContain('text/css')
    expect(css.headers.get('content-encoding')).toBe('gzip')
    expect(await css.text()).toBe(STUDIO_CSS)
    expect((await get('/studio.css', { 'If-None-Match': css.headers.get('etag')! })).status).toBe(304)
  })

  test('the vendored stylesheet is the one packages/css builds', () => {
    const dist = resolve(import.meta.dir, '..', '..', 'css', 'dist', 'frontier.min.css')
    if (!existsSync(dist)) return   // dist/ is gitignored; `bun run build` in packages/css writes both
    expect(STUDIO_CSS).toBe(readFileSync(dist, 'utf8'))
  })

  test('/api/catalog is gzipped and revalidated', async () => {
    const first = await get('/api/catalog')
    expect(first.headers.get('content-encoding')).toBe('gzip')
    const tag = first.headers.get('etag')
    expect(tag).toBeTruthy()
    expect((await first.json()).catalog.length).toBeGreaterThan(10)
    expect((await get('/api/catalog', { 'If-None-Match': tag! })).status).toBe(304)
  })

  test('the revision holds still across reads', async () => {
    const a = await rev()
    expect(a).toBeTruthy()
    await get('/api/info'); await get('/api/stats'); await get('/api/migrations')
    expect(await rev()).toBe(a)
  })

  test('the revision moves on a write made through Studio', async () => {
    const before = await rev()
    const res = await post('/api/row/create', { table: 'Tag', data: { id: 1, label: 'a' } })
    expect((await res.json()).error).toBeUndefined()
    expect(await rev()).not.toBe(before)
  })

  test('the revision moves on a write made from outside', async () => {
    const before = await rev()
    const t = (raw.query(`SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'tag%'`).get() as any).name
    raw.run(`INSERT INTO "${t}" (id, label) VALUES (2, 'b')`)
    expect(await rev()).not.toBe(before)
  })

  test('the revision moves on a migration file added from outside', async () => {
    const before = await rev()
    await Bun.sleep(20)
    writeFileSync(join(dir, 'migrations', '9999_extra.sql'), '-- nothing\n')
    expect(await rev()).not.toBe(before)
  })

  test('the migration diff follows a DDL change made from outside', async () => {
    const one = await post('/api/migrations').then(r => r.json())
    expect(one.diffs.main.sql).toBeNull()
    raw.run(`CREATE TABLE "Stray" (id INTEGER PRIMARY KEY)`)
    const two = await post('/api/migrations').then(r => r.json())
    expect(JSON.stringify(two.diffs.main)).toContain('Stray')
  })

  test('the drift poll sleeps in a hidden tab and the panels check the revision', () => {
    expect(HTML).toMatch(/function driftLoad\(\)[^}]*document\.hidden/)
    expect(HTML).toContain('visibilitychange')
    expect(HTML).toMatch(/loadIfMoved\('migrations'/)
    expect(HTML).toMatch(/loadIfMoved\('overview'/)
    expect(HTML).toMatch(/loadIfMoved\('perf'/)
    expect(HTML).toMatch(/loadIfMoved\('stats'/)
  })
})
