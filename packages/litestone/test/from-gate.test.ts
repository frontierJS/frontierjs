// A @from value is read off the target's rows, so the target's read gate
// decides whether a caller sees it.
//
// `@from(Run, last: true)` handed a caller below Run's gate the whole run that
// `run.findMany()` refused them, `secret` and all, and `count:`/`max:` answered
// over rows they could not read (found by Transit, 2026-10-03). An `include`
// of the same relation was already refused. The field reads as null now, the
// answer a row policy gives a hidden `last:` row, and naming it in a `where` or
// an `orderBy` is refused as the include is.
//
// Every case is paired with a caller one level up, who must still see it: a
// fix that nulled every @from would satisfy a suite that only asked the
// refusal (`FJS-351`).

import { describe, it, expect } from 'bun:test'
import { createClient, GatePlugin, LEVELS } from '../src/index.js'

const SCHEMA = `
model Source {
  id        Int    @id
  name      String
  runs      Run[]
  lastRun   Run?   @from(Run, last: true, orderBy: id)
  runCount  Int    @from(Run, count: true)
  lastId    Int?   @from(Run, max: id)
  anyFailed Boolean @from(Run, exists: true, where: "status = 'failed'")
  notes     Note[]
  noteCount Int    @from(Note, count: true)
  @@gate("3.5.5.5")
}
model Run {
  id       Int    @id
  sourceId Int
  source   Source @relation(fields: [sourceId], references: [id])
  status   String
  secret   String
  @@gate("4.8.8.8")
}
model Note {
  id       Int    @id
  sourceId Int
  source   Source @relation(fields: [sourceId], references: [id])
  @@gate("3.5.5.5")
}
model Owner {
  id       Int    @id
  sourceId Int
  source   Source @relation(fields: [sourceId], references: [id])
  @@gate("3.5.5.5")
}
`

const gate = new GatePlugin({ getLevel: (auth: { level: number } | null) => auth?.level ?? LEVELS.STRANGER })

async function seeded() {
  const db  = await createClient({ schema: SCHEMA, db: ':memory:', plugins: [gate] })
  const sys = db.asSystem() as any
  await sys.source.create({ data: { id: 1, name: 'orders' } })
  await sys.run.create({ data: { id: 1, sourceId: 1, status: 'failed', secret: 's1' } })
  await sys.run.create({ data: { id: 2, sourceId: 1, status: 'ok', secret: 's2' } })
  await sys.note.create({ data: { id: 1, sourceId: 1 } })
  await sys.owner.create({ data: { id: 1, sourceId: 1 } })
  const as = (level: number) => db.$setAuth({ id: `u${level}`, level }) as any
  return { db, sys, as }
}

describe('@from below the target\'s read gate', () => {
  it('reads as null for every kind, and the gate\'s own model still answers', async () => {
    const { as } = await seeded()
    const s = await as(LEVELS.CREATOR).source.findFirst({ where: { id: 1 } })
    expect(s.name).toBe('orders')
    expect(s.lastRun).toBeNull()
    expect(s.runCount).toBeNull()
    expect(s.lastId).toBeNull()
    expect(s.anyFailed).toBeNull()
    // Note's gate is the caller's own: its count is theirs to read.
    expect(s.noteCount).toBe(1)
  })

  it('answers in full one level up', async () => {
    const { as } = await seeded()
    const s = await as(LEVELS.USER).source.findFirst({ where: { id: 1 } })
    expect(s.lastRun).toMatchObject({ id: 2, status: 'ok' })
    expect(s.runCount).toBe(2)
    expect(s.lastId).toBe(2)
    expect(s.anyFailed).toBe(true)
  })

  it('is null on findMany, on a select naming it, and through an include of the parent', async () => {
    const { as } = await seeded()
    const c = as(LEVELS.CREATOR)
    expect((await c.source.findMany())[0].lastRun).toBeNull()
    expect(await c.source.findFirst({ where: { id: 1 }, select: { id: true, runCount: true, lastRun: true } }))
      .toEqual({ id: 1, runCount: null, lastRun: null })
    const o = await c.owner.findFirst({ where: { id: 1 }, include: { source: true } })
    expect(o.source.name).toBe('orders')
    expect(o.source.lastRun).toBeNull()
    expect(o.source.runCount).toBeNull()

    const u = await as(LEVELS.USER).owner.findFirst({ where: { id: 1 }, include: { source: true } })
    expect(u.source.lastRun.id).toBe(2)
    expect(u.source.runCount).toBe(2)
  })

  it('cannot be asked about through a where or an orderBy', async () => {
    const { as } = await seeded()
    const c = as(LEVELS.CREATOR)
    await expect(c.source.findMany({ where: { runCount: { gt: 1 } } })).rejects.toThrow(/Run\.read.*requires level 4/)
    await expect(c.source.findMany({ where: { OR: [{ name: 'x' }, { anyFailed: true }] } })).rejects.toThrow(/Run\.read/)
    await expect(c.source.findMany({ orderBy: { lastId: 'desc' } })).rejects.toThrow(/Run\.read/)
    // The field one gate down is still filterable, and so is the same field one level up.
    expect(await c.source.findMany({ where: { noteCount: { gt: 0 } } })).toHaveLength(1)
    expect(await as(LEVELS.USER).source.findMany({ where: { runCount: { gt: 1 } } })).toHaveLength(1)
  })

  it('the include of the relation itself is refused, as before', async () => {
    const { as } = await seeded()
    await expect(as(LEVELS.CREATOR).source.findFirst({ where: { id: 1 }, include: { runs: true } })).rejects.toThrow(/Run\.read/)
  })

  it('the system reads everything', async () => {
    const { sys } = await seeded()
    const s = await sys.source.findFirst({ where: { id: 1 } })
    expect(s.lastRun.secret).toBe('s2')
    expect(s.runCount).toBe(2)
  })
})
