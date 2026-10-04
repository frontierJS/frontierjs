// A client built from schema text the app did not write (FJS-1633), and every
// view compiling when a client is built (FJS-1632). Found by the transit
// stressor, whose Source rows each hold a landing schema.
//
// FJS-1633: `database side { path "/abs/elsewhere.db" }` and a model
// `@@db(side)` opened and wrote that file from a client handed `db: ':memory:'`,
// so whoever wrote the row wrote wherever they named. `untrusted: true` holds
// the text to the one `db` it is given. Each refusal sits beside the nearest
// thing that is allowed, so a guard that refused everything fails here too.
//
// FJS-1632: CREATE VIEW resolves no names, so a view over a column that is not
// there built and failed at the first read, naming no view.

import { describe, it, expect } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '../src/index.js'

const BASE = `
claim customerId
enum Status { paid pending }
model Order {
  id         String @id
  customerId String
  status     Status
  amount     Int
  @@allow('read', customerId == auth().customerId)
  @@gate("3.8.8.8")
}
// Lower camel: a PascalCase view is not readable yet (FJS-1631).
view paidByCustomer {
  customerId String
  total      Int
  @@sql("SELECT customerId, SUM(amount) AS total FROM \\"order\\" WHERE status = 'paid' GROUP BY customerId")
  @@gate("4")
}
`

describe('createClient({ untrusted: true })', () => {
  it('builds a schema of models, views, enums and bare claims, and grades with it', async () => {
    const db  = await createClient({ schema: BASE, db: ':memory:', untrusted: true }) as any
    await db.asSystem().order.create({ data: { id: 'o1', customerId: 'c1', status: 'paid', amount: 5 } })
    expect(await db.$setAuth({ id: 'u', customerId: 'c1', isCustomer: true }).order.count()).toBe(1)
    expect((await db.asSystem().paidByCustomer.findMany())[0].total).toBe(5)
  })

  it('refuses a database block, and the file it names is never opened', async () => {
    const dir   = mkdtempSync(join(tmpdir(), 'ls-untrusted-'))
    const other = join(dir, 'elsewhere.db')
    try {
      const noView = BASE.slice(0, BASE.indexOf('// Lower camel'))
      const text = `database side { path "${other}" }\n` + noView.replace('@@gate("3.8.8.8")', '@@gate("3.8.8.8")\n  @@db(side)')
      await expect(createClient({ schema: text, db: ':memory:', untrusted: true })).rejects.toThrow(/`database side` names a file[\s\S]*Order: `@@db`/)
      expect(existsSync(other)).toBe(false)
      // The same text as an ordinary client is what the guard is for.
      await createClient({ schema: text, db: ':memory:' })
      expect(existsSync(other)).toBe(true)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('refuses each word that reaches outside the file, every one in one message', async () => {
    const text = `import "./other.lite"\n` + BASE +
      `model Account {\n  id String @id\n  plan String\n  @@auth\n}\nmodel Remote {\n  id Int @id\n  @@external\n}\n`
    const err = await createClient({ schema: text, db: ':memory:', untrusted: true }).catch(e => e)
    expect(err.message).toMatch(/3 declarations refused/)
    expect(err.message).toMatch(/`import "\.\/other\.lite"`/)
    expect(err.message).toMatch(/Account: `@@auth`/)
    expect(err.message).toMatch(/Remote: `@@external`/)
  })

  it('takes text only: a one-line string ending in .lite is not read from disk', async () => {
    await expect(createClient({ schema: 'db/schema.lite', db: ':memory:', untrusted: true })).rejects.toThrow(/schema\.lite has errors|schema/)
    await expect(createClient({ path: './db/schema.lite', db: ':memory:', untrusted: true } as any)).rejects.toThrow(/takes the schema as text/)
  })

  it('needs the one db it is held to', async () => {
    await expect(createClient({ schema: BASE, untrusted: true })).rejects.toThrow(/needs `db`/)
    await expect(createClient({ schema: BASE, db: ':memory:', databases: ':memory:', untrusted: true } as any)).rejects.toThrow(/needs `db`/)
  })
})

describe('a view that does not compile fails the build, naming it (FJS-1632)', () => {
  it('a column the table does not have', async () => {
    const text = BASE.replace('SELECT customerId, SUM(amount)', 'SELECT customer_id AS customerId, SUM(amount)')
    await expect(createClient({ schema: text, db: ':memory:' })).rejects.toThrow(/view paidByCustomer: .*no such column: customer_id/)
  })

  it('a table that is not there', async () => {
    const text = BASE.replace('FROM \\"order\\"', 'FROM \\"orders\\"')
    await expect(createClient({ schema: text, db: ':memory:' })).rejects.toThrow(/view paidByCustomer: .*no such table: (main\.)?orders/)
  })

  it('the view as written builds', async () => {
    expect(await createClient({ schema: BASE, db: ':memory:' })).toBeTruthy()
  })
})
