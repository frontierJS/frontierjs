// FJS-1235 — `bun --watch` restarts a process when the schema file changes.
//
// createClient reads the schema with `fs`, which is not an import, so the
// watcher's module graph never held the one file that defines the data and an
// edit to it left the old schema serving, silently. Under a watcher createClient
// registers every file the parse read; outside one it registers nothing.

import { describe, test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

const SRC = resolve(import.meta.dir, '..', 'src', 'index.js')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (fn()) return true; await sleep(50) }
  return fn()
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'litestone-watch-'))
  mkdirSync(join(dir, 'db'))
  writeFileSync(join(dir, 'db', 'schema.lite'),
    'import "./extra.lite"\n\nmodel Note {\n  id Int @id\n}\n')
  writeFileSync(join(dir, 'db', 'extra.lite'), 'model Tag {\n  id Int @id\n}\n')
  writeFileSync(join(dir, 'boots.log'), '')
  writeFileSync(join(dir, 'index.ts'), `
import { appendFileSync } from 'node:fs'
import { createClient } from ${JSON.stringify(SRC)}
await createClient({ path: new URL('./db/schema.lite', import.meta.url).pathname, db: ':memory:' })
appendFileSync(new URL('./boots.log', import.meta.url).pathname, 'boot\\n')
setInterval(() => {}, 1000)
`)
  return dir
}

const boots = (dir: string) => readFileSync(join(dir, 'boots.log'), 'utf8').split('\n').filter(Boolean).length

describe('FJS-1235 — a schema edit restarts a watched process', () => {
  for (const [label, file] of [['the schema', 'schema.lite'], ['a file it imports', 'extra.lite']] as const) {
    test(`an edit to ${label} restarts bun --watch`, async () => {
      const dir  = fixture()
      const proc = Bun.spawn(['bun', '--watch', 'run', 'index.ts'], { cwd: dir, stdout: 'ignore', stderr: 'ignore' })
      try {
        expect(await until(() => boots(dir) === 1)).toBe(true)
        const path = join(dir, 'db', file)
        writeFileSync(path, readFileSync(path, 'utf8') + '\n// edited\n')
        expect(await until(() => boots(dir) >= 2)).toBe(true)
      } finally {
        proc.kill()
        rmSync(dir, { recursive: true, force: true })
      }
    }, 20000)
  }
})
