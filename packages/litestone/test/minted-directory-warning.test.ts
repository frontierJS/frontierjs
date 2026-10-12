// FJS-1488 — the "relative `database { path }`" warning is for a RELATIVE path.
// A directory minted for an absolute path is the caller's own statement, and
// `fli test:mutate` mints one per mutant.
import { describe, test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { createClient } from '../src/index.js'

const MINTED = /for a database that was not there/

async function warningsFrom(schema: string, opts: Record<string, unknown> = {}) {
  const warned: string[] = []
  const warn = console.warn
  console.warn = (...a: unknown[]) => { warned.push(a.join(' ')) }
  try {
    const { write, ...rest } = opts
    const db: any = await createClient({ schema, ...rest })
    // a jsonl table makes its directory on the first write
    if (write) await db[write as string].create({ data: { note: 'x' } })
    db.$close()
  } finally { console.warn = warn }
  return warned.filter(w => MINTED.test(w))
}

describe('minted-directory warning', () => {
  test('an absolute sqlite path mints a directory silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      const schema = `database main { path "${join(root, 'nested', 'app.db')}" }\nmodel Thing { id Int @id }`
      expect(await warningsFrom(schema)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('an absolute jsonl path mints a directory silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      const schema = `database main { path ":memory:" }\ndatabase audit { path "${join(root, 'audit')}/" driver jsonl }\n` +
        `model Note { id Int @id @default(autoincrement())  note String  @@db(audit) }`
      expect(await warningsFrom(schema, { write: 'note' })).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  test('a relative sqlite path still warns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'litestone-mint-'))
    try {
      const rel = relative(process.cwd(), join(root, 'nested', 'app.db'))
      const schema = `database main { path "${rel}" }\nmodel Thing { id Int @id }`
      expect((await warningsFrom(schema)).length).toBe(1)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
