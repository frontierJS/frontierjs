// test/commitments-files.test.ts
//
// A commitment hook found by its file: any `*.commitments.ts` under
// `createApp({ root })` default-exports `{ 'Model.move': defineCommitment(…) }`
// (`FJS-D1141`). `commitments({ hooks })` stays beside it for a caller with no
// app tree, and both feed one registry.

import { describe, it, expect, afterEach, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { createClient } from '../../litestone/src/index.js'
import { createApp } from '../index.ts'
import { defineCommitment, fireDue } from '../src/plugins/commitments/index.ts'

const COMMITMENTS = resolve(import.meta.dir, '../src/plugins/commitments/index.ts')

const SCHEMA = `
database main { path "./app.db" }

enum OrderStatus { pending paid cancelled }

model Order {
  id        Int         @id @default(autoincrement())
  status    OrderStatus @default(pending)
  createdAt DateTime    @default(now())
  @@transitions(status,
    pay:     pending -> paid,
    abandon: pending -> cancelled @system)
  @@commitment(abandon, on: createdAt + 14d)
  @@db(main)
}
`
const DAY = 86_400_000
const T0  = Date.parse('2026-01-01T00:00:00.000Z')

const roots: string[] = []
const closers: Array<() => unknown> = []
afterEach(async () => { for (const c of closers.splice(0)) await c() })
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

/** A root holding the given files, and an app over it with a clock the test advances. */
async function build(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'fjs-commitments-'))
  roots.push(root)
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  let t = T0
  const db = await createClient({ databases: ':memory:', schema: SCHEMA, now: () => new Date(t) }) as any
  closers.push(() => db.$close())
  const app = createApp({ db, root, config: { port: 0 } } as any) as any
  return { app, db, advance: (ms: number) => { t += ms } }
}

const hookFile = (key: string, note: string) => `
import { defineCommitment } from '${COMMITMENTS}'
export const seen: string[] = ((globalThis as any).__seen ??= [])
export default { '${key}': defineCommitment({ after: () => { seen.push('${note}') } }) }
`

describe('a *.commitments.ts under the app root', () => {
  it('is found anywhere under the root and run by the fire', async () => {
    ;(globalThis as any).__seen = []
    const { app, db, advance } = await build({ 'domain/orders/abandon.commitments.ts': hookFile('Order.abandon', 'file') })
    await app._startForTest()
    await db.order.create({ data: {} })
    advance(14 * DAY)
    expect(await fireDue(app)).toEqual({ due: 1, fired: 1, lapsed: 0 })
    expect((globalThis as any).__seen).toEqual(['file'])
  })

  it('a key naming no @@commitment is refused at boot, naming it', async () => {
    const { app } = await build({ 'a.commitments.ts': hookFile('Order.lapse', 'x') })
    await expect(fireDue(app)).rejects.toThrow(/'Order\.lapse' \(a\.commitments\.ts\), which no @@commitment declares/)
  })

  it('a key claimed by two files is refused naming both', async () => {
    const { app } = await build({
      'a/one.commitments.ts': hookFile('Order.abandon', 'one'),
      'b/two.commitments.ts': hookFile('Order.abandon', 'two'),
    })
    await expect(fireDue(app)).rejects.toThrow(/'Order\.abandon'.*one\.commitments\.ts.*two\.commitments\.ts/s)
  })

  it('a key claimed by a file and by the hooks map is refused', async () => {
    const { app } = await build({ 'one.commitments.ts': hookFile('Order.abandon', 'one') })
    await expect(fireDue(app, { hooks: { 'Order.abandon': defineCommitment({ after: () => {} }) } }))
      .rejects.toThrow(/'Order\.abandon'.*one\.commitments\.ts.*hooks/s)
  })

  it('a default export that is not a map is refused naming the file', async () => {
    const { app } = await build({ 'bad.commitments.ts': 'export default 42\n' })
    await expect(fireDue(app)).rejects.toThrow(/bad\.commitments\.ts/)
  })

  it('an empty hooks map beside a file still runs the file', async () => {
    ;(globalThis as any).__seen = []
    const { app, db, advance } = await build({ 'one.commitments.ts': hookFile('Order.abandon', 'file') })
    await app._startForTest()
    await db.order.create({ data: {} })
    advance(14 * DAY)
    await fireDue(app, { hooks: {} })
    expect((globalThis as any).__seen).toEqual(['file'])
  })

  it('node_modules under the root is not scanned', async () => {
    const { app } = await build({ 'node_modules/x/y.commitments.ts': 'export default 42\n' })
    await app._startForTest()
    expect(await fireDue(app)).toEqual({ due: 0, fired: 0, lapsed: 0 })
  })
})
