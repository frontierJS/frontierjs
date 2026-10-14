// Studio's advisor Fix (FJS-2720): POST /api/perf/advisor/fix writes the index
// into the schema, and for a model an imported fragment declares that is an
// `extend model` block in the app's own file -- the fragment is a package's.
//
// Spawns the real CLI, since the endpoint lives inside cmdStudio's closure.
//
// Run with:  bun test test/studio-advisor-fix.test.ts

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const CLI = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')

const FRAGMENT = `
model Wait {
  id    Int @id
  runId Int
}
`
const ROOT = `import "./fragment.lite"

model Tag {
  id    Int    @id
  label String
}
`

let dir: string
let proc: ReturnType<typeof Bun.spawn>
let base: string

const post = (path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'studio-advisor-fix-'))
  writeFileSync(join(dir, 'fragment.lite'), FRAGMENT)
  writeFileSync(join(dir, 'schema.lite'), ROOT)
  writeFileSync(join(dir, 'litestone.config.js'),
    `export default { schema: './schema.lite', migrations: './migrations', db: './test.db' }\n`)
  mkdirSync(join(dir, 'migrations'))
  for (const args of [['migrate', 'create', 'init'], ['migrate', 'apply']]) {
    const p = Bun.spawn(['bun', CLI, ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' })
    await p.exited
  }

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

describe('advisor fix reaches an imported model (FJS-2720)', () => {
  test('a model the root declares gets the attribute inside its block', async () => {
    const r = await post('/api/perf/advisor/fix', { model: 'Tag', columns: ['label'] })
    expect(r.status).toBe(200)
    expect(readFileSync(join(dir, 'schema.lite'), 'utf8')).toContain('  @@index([label])\n}')
  })

  test('a model an imported fragment declares gets an extend block, and the fragment is untouched', async () => {
    const r = await post('/api/perf/advisor/fix', { model: 'Wait', columns: ['runId'] })
    expect(r.status).toBe(200)
    expect((await r.json()).added).toBe('@@index([runId])')
    expect(readFileSync(join(dir, 'schema.lite'), 'utf8')).toContain('extend model Wait {\n  @@index([runId])\n}')
    expect(readFileSync(join(dir, 'fragment.lite'), 'utf8')).toBe(FRAGMENT)
  })

  test('a second fix for the same imported model lands in the block already there', async () => {
    const r = await post('/api/perf/advisor/fix', { model: 'Wait', columns: ['id', 'runId'] })
    expect(r.status).toBe(200)
    const text = readFileSync(join(dir, 'schema.lite'), 'utf8')
    expect(text.match(/extend model Wait/g)).toHaveLength(1)
  })

  test('a model no file declares is refused by name', async () => {
    const r = await post('/api/perf/advisor/fix', { model: 'Nope', columns: ['x'] })
    expect(r.status).toBe(400)
    expect((await r.json()).error).toContain('Nope')
  })
})
