// `litestone validate` — which stored rows would this schema refuse?
//
// A validator that leaves no CHECK behind is enforced at the client boundary
// and nowhere else, so it governs the next write and says nothing about the
// rows already down. Change the rule and those rows do not become invalid
// loudly; they become invalid silently, and the first anyone hears of it is a
// caller editing an old row and being refused over a column they never sent.
//
// Two shapes the walk has to separate, because they need different answers:
//
//   1. a row that no longer satisfies the schema — it reads fine, and its next
//      UPDATE is refused
//   2. a MODEL nothing can be written to at all — the drift is in a rule every
//      row breaks, so this is a deploy that half-landed rather than bad data
//
// The migration differ cannot see either: a `Json` column is TEXT before and
// after, and `@length`/`@email`/`@type` emit no constraint. That blindness is
// the reason the command exists, and `a validator with no CHECK is invisible to
// the migrator` below is what pins it.

import { describe, it, expect, afterAll } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '../src/index.js'
import { validateRows } from '../src/validate-rows.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'lite-validate-'))
  dirs.push(d)
  return join(d, 'a.db')
}
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

/** Write rows under `before`, then ask `after` what it makes of them. */
const drift = async (before: string, after: string, seed: (db: any) => Promise<void>) => {
  const db   = tmp()
  const one  = await createClient({ schema: before, db })
  await seed(one)
  await one.$close()

  const two  = await createClient({ schema: after, db })
  const rows = await validateRows(two)
  await two.$close()
  return rows
}

// ─── the row that gets stuck ──────────────────────────────────────────────────

describe('a stored row the schema would now refuse', () => {
  it('names the row, the column and the rule — a typed JSON member that grew', async () => {
    const report = await drift(
      `type Addr { city String }
       model Place { id Int @id  addr Json @type(Addr) }`,
      `type Addr { city String  zip String }
       model Place { id Int @id  addr Json @type(Addr) }`,
      db => db.place.create({ data: { id: 1, addr: { city: 'Reno' } } }),
    )

    expect(report.ok).toBe(false)
    expect(report.findings).toHaveLength(1)

    const [f] = report.findings
    expect(f.model).toBe('Place')
    expect(f.id).toBe(1)
    expect(f.errors[0].path).toEqual(['addr', 'zip'])
    expect(f.errors[0].message).toContain('required')
  })

  it('the row still READS, which is why nothing else reports it', async () => {
    const db  = tmp()
    const one = await createClient({
      schema: `type Addr { city String }\nmodel Place { id Int @id  addr Json @type(Addr) }`, db })
    await one.place.create({ data: { id: 1, addr: { city: 'Reno' } } })
    await one.$close()

    const two = await createClient({
      schema: `type Addr { city String  zip String }\nmodel Place { id Int @id  addr Json @type(Addr) }`, db })

    // Reads clean …
    expect(await two.place.findUnique({ where: { id: 1 } })).toEqual({ id: 1, addr: { city: 'Reno' } })
    // … and cannot be written, over a column the caller never sent.
    expect(two.place.update({ where: { id: 1 }, data: { addr: { city: 'Sparks' } } }))
      .rejects.toThrow(/zip/)
    await two.$close()
  })

  it('covers every validator that leaves no CHECK, not just typed JSON', async () => {
    const report = await drift(
      `model User { id Int @id  email String  handle String  tags String[] }`,
      `model User {
         id Int @id
         email String @email
         handle String @length(3, 20)
         tags String[] @maxItems(2)
       }`,
      db => db.user.create({ data: { id: 1, email: 'nope', handle: 'x', tags: ['a', 'b', 'c'] } }),
    )

    expect(report.ok).toBe(false)
    const [f] = report.findings
    expect(f.errors.map((e: any) => e.path[0]).sort()).toEqual(['email', 'handle', 'tags'])
  })

  it('a validator with no CHECK is invisible to the migrator, which is why this walk exists', async () => {
    const db  = tmp()
    const one = await createClient({ schema: `model User { id Int @id  email String }`, db })
    await one.user.create({ data: { id: 1, email: 'nope' } })
    await one.$close()

    const { autoMigrate } = await import('../src/index.js')
    const two = await createClient({ schema: `model User { id Int @id  email String @email }`, db })
    const res = await autoMigrate(two)

    // The differ is right: the column did not move. It is the ROWS that did.
    expect(res.main.state).toBe('in-sync')
    expect((await validateRows(two)).findings).toHaveLength(1)
    await two.$close()
  })
})

// ─── the model nothing can be written to ──────────────────────────────────────

describe('a model every row of which is refused', () => {
  it('is reported as the model rather than as N rows', async () => {
    const report = await drift(
      `type Addr { city String }
       model Place { id Int @id  addr Json @type(Addr) }`,
      `type Addr { city String  zip String }
       model Place { id Int @id  addr Json @type(Addr) }`,
      async db => {
        for (const id of [1, 2, 3]) await db.place.create({ data: { id, addr: { city: 'Reno' } } })
      },
    )

    // The rows are still listed — *fix the schema* and *fix these rows* are
    // both answers, and a count with nothing to look at is not one.
    expect(report.findings).toHaveLength(3)
    expect(report.models).toHaveLength(1)
    expect(report.models[0]).toMatchObject({ model: 'Place', rows: 3, failing: 3 })
    expect(report.ok).toBe(false)
  })

  it('an empty model says nothing — no rows is not a clean bill', async () => {
    const report = await drift(
      `model Place { id Int @id  code String }`,
      `model Place { id Int @id  code String @length(3, 5) }`,
      async () => {},
    )
    expect(report.ok).toBe(true)
    expect(report.models).toHaveLength(0)
    expect(report.checked.find((c: any) => c.model === 'Place')).toMatchObject({ rows: 0 })
  })
})

// ─── what it must not do ──────────────────────────────────────────────────────

describe('the walk itself', () => {
  it('reads as SYSTEM, or a gated model reports zero rows and passes', async () => {
    const schema = `model Vault { id Int @id  code String  @@gate("8") }`
    const db  = tmp()
    const one = await createClient({ schema, db })
    await one.asSystem().vault.create({ data: { id: 1, code: 'x' } })
    await one.$close()

    const two    = await createClient({ schema: schema.replace('code String', 'code String @length(3, 5)'), db })
    const report = await validateRows(two)
    await two.$close()

    // The row is there and it is wrong. A caller-scoped read would answer [],
    // which is the same shape as a clean model and would pass.
    expect(report.checked.find((c: any) => c.model === 'Vault')).toMatchObject({ rows: 1 })
    expect(report.ok).toBe(false)
  })

  it('a clean database is ok, and says what it looked at', async () => {
    const db = tmp()
    const c  = await createClient({ schema: `model User { id Int @id  email String @email }`, db })
    await c.user.create({ data: { id: 1, email: 'a@b.test' } })

    const report = await validateRows(c)
    await c.$close()

    expect(report.ok).toBe(true)
    expect(report.findings).toHaveLength(0)
    expect(report.checked).toEqual([{ model: 'User', rows: 1, failing: 0 }])
  })

  it('takes `models` to narrow the walk', async () => {
    const db = tmp()
    const c  = await createClient({
      schema: `model A { id Int @id  v String @length(3, 5) }\nmodel B { id Int @id  v String }`, db })
    c.$rawDbs.main.exec(`INSERT INTO "a" ("id","v") VALUES (1,'x')`)

    expect((await validateRows(c, { models: ['B'] })).ok).toBe(true)
    expect((await validateRows(c, { models: ['A'] })).ok).toBe(false)
    await c.$close()
  })

  it('a model on a jsonl driver is skipped by name — there is no schema to hold it to', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lite-validate-jsonl-'))
    dirs.push(dir)
    const c = await createClient({
      schema: `database main { path "${join(dir, 'm.db')}" }
               database logs { path "${join(dir, 'logs')}"  driver jsonl }
               model User { id Int @id  email String @email }
               model Hit  { path String  @@db(logs) }`,
    })
    const report = await validateRows(c)
    await c.$close()

    expect(report.skipped).toEqual([{ model: 'Hit', reason: 'jsonl driver — no migrations and no schema to hold a row to' }])
    expect(report.checked.map((r: any) => r.model)).toEqual(['User'])
  })
})
