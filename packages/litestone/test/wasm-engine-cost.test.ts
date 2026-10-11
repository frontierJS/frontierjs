// wasm-engine-cost.test.ts — what the browser engine spends per row and per file
// (`FJS-2321`).
//
// Every `sqlite3_column_name` is a call across the wasm boundary that decodes a
// string, so naming each cell of a 2,000 x 10 result is 20,000 decodes of the
// same ten strings. And a single-threaded worker with two connections per file,
// each holding a 32 MB page cache, reserves 64 MB of wasm heap on a phone while
// every write empties the reader's cache anyway.

import { test, expect, describe } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createClient } from '../src/core/client.js'
import { parse } from '../src/core/parser.js'
import { setEngine, clearEngine, currentEngine } from '../src/core/engine.js'
import { createSqliteWasmEngine } from '../src/engines/sqlite-wasm.js'
import bunEngine from '../src/engines/bun-sqlite.js'

const WASM = join(import.meta.dir, '../node_modules/@sqlite.org/sqlite-wasm/dist/node.mjs')

describe('column names on the sqlite-wasm engine', () => {
  async function counted(fn: (raw: any, calls: () => number) => void) {
    let names = 0
    const engine = await createSqliteWasmEngine({
      load: async () => {
        const init = (await import(WASM)).default
        return {
          default: async () => {
            const s = await init()
            s.installOpfsSAHPoolVfs ??= async () => ({})
            const real = s.capi.sqlite3_column_name
            s.capi.sqlite3_column_name = (...a: any[]) => { names++; return real(...a) }
            return s
          },
        }
      },
    })
    const raw = engine.open(':memory:')
    try { fn(raw, () => names) } finally { raw.close() }
  }

  test.skipIf(!existsSync(WASM))('a result names its columns once, not once per cell', async () => {
    await counted((raw, calls) => {
      raw.run('CREATE TABLE t (a, b, c, d, e)')
      for (let i = 0; i < 200; i++) raw.run('INSERT INTO t VALUES (?, ?, ?, ?, ?)', i, i, i, i, i)
      const q = raw.prepare('SELECT * FROM t')
      const before = calls()
      const rows = q.all()
      expect(rows).toHaveLength(200)
      expect(rows[7]).toEqual({ a: 7, b: 7, c: 7, d: 7, e: 7 })
      expect(calls() - before).toBeLessThanOrEqual(5)

      const w = raw.prepare('SELECT * FROM t')
      w.safeIntegers(true)
      const wb = calls()
      expect(w.all()[3]).toEqual({ a: 3n, b: 3n, c: 3n, d: 3n, e: 3n })
      expect(calls() - wb).toBeLessThanOrEqual(5)
    })
  })

  test.skipIf(!existsSync(WASM))('a statement re-prepared by a schema change names the new columns', async () => {
    await counted((raw) => {
      raw.run('CREATE TABLE t (a)')
      raw.run('INSERT INTO t VALUES (1)')
      const q = raw.prepare('SELECT * FROM t')
      expect(q.all()).toEqual([{ a: 1 }])
      raw.run('ALTER TABLE t ADD COLUMN b DEFAULT 2')
      expect(q.all()).toEqual([{ a: 1, b: 2 }])
      raw.run('ALTER TABLE t RENAME COLUMN b TO c')
      expect(q.get()).toEqual({ a: 1, c: 2 })
    })
  })
})

describe('a single-connection engine', () => {
  const SCHEMA = 'model Note { id Int @id @default(autoincrement())  body String }'

  async function withEngine(single: boolean, fn: (opens: string[], file: string, handles: any[]) => Promise<void>) {
    const before = currentEngine()
    const dir = mkdtempSync(join(tmpdir(), 'fjs-2321-'))
    const opens: string[] = []
    const handles: any[] = []
    clearEngine()
    setEngine({
      ...bunEngine,
      ...(single ? { singleConnection: true } : {}),
      open(path: string, o: any = {}) {
        opens.push(o.readonly ? 'read' : 'write')
        const h = bunEngine.open(path, o)
        handles.push(h)
        return h
      },
    })
    try { await fn(opens, join(dir, 'x.db'), handles) } finally {
      clearEngine(); if (before) setEngine(before)
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test('opens a file once, and caches nearer 4 MB than 32', async () => {
    await withEngine(true, async (opens, file, handles) => {
      const db = await createClient({ parsed: parse(SCHEMA), db: file })
      await db.note.create({ data: { body: 'hi' } })
      expect((await db.note.findMany()).map((n: any) => n.body)).toEqual(['hi'])
      expect(opens).toEqual(['write'])
      expect(handles[0].query('PRAGMA cache_size').get().cache_size).toBe(-4096)
      await db.$close?.()
    })
  })

  test('an engine that says nothing still gets a reader of its own', async () => {
    await withEngine(false, async (opens, file) => {
      const db = await createClient({ parsed: parse(SCHEMA), db: file })
      expect(opens).toEqual(['write', 'read'])
      await db.$close?.()
    })
  })
})
