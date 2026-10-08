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
    const file = join(dir, 'audit', 'auditTrail.jsonl')
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
