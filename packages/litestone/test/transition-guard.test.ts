// test/transition-guard.test.ts
//
// A guard on a move (`FJS-D1286`): `resolve: open -> resolved while: …` refuses
// the MOVE while the predicate fails, reading this row and one hop. It is graded
// only when the write moves the column from `from` to `to`, so a later write to
// a row that already moved is not graded by it — the postUpdate `@@require` an
// app wrote in its place froze a merged pull request (`FJS-4334`).
//
// Each refusal is paired with the same write succeeding once the guard holds.

import { describe, test, expect } from 'bun:test'
import { createClient, parse, GatePlugin, TransitionGuardError, TransitionConflictError } from '../src/index.js'

const SCHEMA = `
enum TicketState { open  resolved  closed }
model User { id Int @id  @@auth }
model Component {
  id          Int      @id @default(autoincrement())
  lastCheckOk Boolean?
  tickets     Ticket[]
}
model Ticket {
  id          Int         @id @default(autoincrement())
  title       String
  state       TicketState @default(open)
  componentId Int
  component   Component   @relation(fields: [componentId], references: [id])
  @@transitions(state,
    resolve: open -> resolved while: component.lastCheckOk != false,
    close:   resolved -> closed unless: title == 'pinned'
  )
}
model Pull {
  id            Int     @id @default(autoincrement())
  isChecksGreen Boolean @default(false)
  merged        Boolean @default(false)
  @@transitions(merged, merge: false -> true @gate(2) while: isChecksGreen == true)
}`

async function env() {
  const db = await createClient({
    schema: SCHEMA, db: ':memory:',
    plugins: [new GatePlugin({ getLevel: (u: { level?: number } | null) => u?.level ?? 0 })],
  })
  return { db, sys: db.asSystem(), at: (level: number) => db.$setAuth({ id: 1, level }) }
}

describe('parse', () => {
  test('while: and unless: are a move\'s guard, after its attributes', () => {
    const r = parse(SCHEMA)
    expect(r.valid).toBe(true)
    const t = r.schema.models.find((m: { name: string }) => m.name === 'Ticket')
      .attributes.find((a: { kind: string }) => a.kind === 'transitions').transitions
    expect(t.resolve.guard.when).toBe('while')
    expect(t.close.guard.when).toBe('unless')
    const p = r.schema.models.find((m: { name: string }) => m.name === 'Pull')
      .attributes.find((a: { kind: string }) => a.kind === 'transitions').transitions
    expect(p.merge.gate).toBe(2)
    expect(p.merge.guard.when).toBe('while')
  })

  test('a guard stated twice, and an attribute after a guard, are parse errors', () => {
    expect(parse(SCHEMA.replace("!= false,", "!= false while: title == 'x',")).errors.join('\n')).toMatch(/guard stated twice/)
    expect(parse(SCHEMA.replace("!= false,", "!= false @gate(3),")).errors.join('\n')).toMatch(/@gate goes before while:/)
  })

  // Checked where @@require's predicate is, when the client compiles policy:
  // SQLite reads an unknown name as a string constant and the guard would
  // compare two literals.
  test('a guard naming no field is refused at createClient', async () => {
    await expect(createClient({ schema: SCHEMA.replace('while: isChecksGreen', 'while: isChecksGrene'), db: ':memory:' }))
      .rejects.toThrow(/'isChecksGrene' is not a field.*@@transitions\(merged\) 'merge' while:/)
  })
})

describe('a guard refuses the move while it fails', () => {
  test('a one-hop guard, through update() and through transition()', async () => {
    const { db, sys } = await env()
    const c = await sys.component.create({ data: { lastCheckOk: false } })
    const t = await sys.ticket.create({ data: { title: 'a', componentId: c.id } })
    await expect(sys.ticket.transition(t.id, 'resolve')).rejects.toBeInstanceOf(TransitionGuardError)
    await expect(sys.ticket.update({ where: { id: t.id }, data: { state: 'resolved' } }))
      .rejects.toThrow(/'resolve' on Ticket\.state is refused while/)
    expect((await sys.ticket.findFirst({ where: { id: t.id } })).state).toBe('open')

    // null is UNKNOWN to the predicate grammar, and a guard refuses on it.
    await sys.component.update({ where: { id: c.id }, data: { lastCheckOk: null } })
    await expect(sys.ticket.transition(t.id, 'resolve')).rejects.toBeInstanceOf(TransitionGuardError)
    await sys.component.update({ where: { id: c.id }, data: { lastCheckOk: true } })
    expect((await sys.ticket.transition(t.id, 'resolve')).state).toBe('resolved')
    db.$close()
  })

  test('unless: refuses while its predicate holds', async () => {
    const { db, sys } = await env()
    const c = await sys.component.create({ data: { lastCheckOk: true } })
    const t = await sys.ticket.create({ data: { title: 'pinned', componentId: c.id } })
    await sys.ticket.transition(t.id, 'resolve')
    await expect(sys.ticket.transition(t.id, 'close')).rejects.toBeInstanceOf(TransitionGuardError)
    await sys.ticket.update({ where: { id: t.id }, data: { title: 'loose' } })
    expect((await sys.ticket.transition(t.id, 'close')).state).toBe('closed')
    db.$close()
  })

  test('the refusal is 409 and not retryable, and names the move', async () => {
    const { db, sys } = await env()
    const p = await sys.pull.create({ data: {} })
    const err = await sys.pull.transition(p.id, 'merge').catch((e: unknown) => e) as TransitionGuardError
    expect(err).toBeInstanceOf(TransitionGuardError)
    expect(err.status).toBe(409)
    expect(err.retryable).toBe(false)
    expect(err.transition).toBe('merge')
    db.$close()
  })
})

describe('a guard grades the move and nothing after it', () => {
  test('a merged pull request takes a later write the guard would refuse', async () => {
    const { db, sys } = await env()
    const p = await sys.pull.create({ data: { isChecksGreen: true } })
    expect((await sys.pull.transition(p.id, 'merge')).merged).toBe(true)
    const after = await sys.pull.update({ where: { id: p.id }, data: { isChecksGreen: false } })
    expect(after.isChecksGreen).toBe(false)
    expect(after.merged).toBe(true)
    db.$close()
  })

  // The swap carries the guard, so one that fails between checkTransitions'
  // read and the statement leaves the row unmoved rather than moved past it.
  test('the move\'s UPDATE carries the guard beside the from-state', async () => {
    const sqls: string[] = []
    const db = await createClient({ schema: SCHEMA, db: ':memory:', onQuery: (e: { sql: string }) => { sqls.push(e.sql) } })
    const sys = db.asSystem()
    const p = await sys.pull.create({ data: { isChecksGreen: true } })
    await sys.pull.transition(p.id, 'merge')
    const upd = sqls.filter(s => /^UPDATE/i.test(s.trim()))
    expect(upd.some(s => /"merged" = \? AND COALESCE\(/.test(s))).toBe(true)
    sqls.length = 0
    await sys.pull.update({ where: { id: p.id }, data: { isChecksGreen: false } })
    expect(sqls.filter(s => /^UPDATE/i.test(s.trim())).some(s => /COALESCE\(/.test(s))).toBe(false)
    db.$close()
  })

  test('a write naming the column at the state it holds is no move, and is not graded', async () => {
    const { db, sys } = await env()
    const p = await sys.pull.create({ data: {} })
    expect((await sys.pull.update({ where: { id: p.id }, data: { merged: false, isChecksGreen: false } })).merged).toBe(false)
    db.$close()
  })
})

describe('who the guard holds', () => {
  test('asSystem() is held to it, as to the machine — and still lifts the gate', async () => {
    const { db, sys, at } = await env()
    const p = await sys.pull.create({ data: { isChecksGreen: true } })
    await expect(at(1).pull.transition(p.id, 'merge')).rejects.toThrow(/requires level 2/)
    await sys.pull.update({ where: { id: p.id }, data: { isChecksGreen: false } })
    await expect(sys.pull.transition(p.id, 'merge')).rejects.toBeInstanceOf(TransitionGuardError)
    db.$close()
  })

  test('a caller below the gate is told the gate, not the guard', async () => {
    const { db, sys, at } = await env()
    const p = await sys.pull.create({ data: {} })
    await expect(at(1).pull.transition(p.id, 'merge')).rejects.toThrow(/requires level 2/)
    await expect(at(2).pull.transition(p.id, 'merge')).rejects.toBeInstanceOf(TransitionGuardError)
    db.$close()
  })
})

describe('transitions(row) reports the guard', () => {
  test("refusedBy: 'guard' while it fails, null once it holds", async () => {
    const { db, sys, at } = await env()
    const p = await sys.pull.create({ data: {} })
    const before = (await at(5).pull.transitions(p.id)).find((m: { name: string }) => m.name === 'merge')
    expect(before).toMatchObject({ allowed: false, refusedBy: 'guard' })
    // The gate is asked first: a caller below it is told that.
    const low = (await at(1).pull.transitions(p.id)).find((m: { name: string }) => m.name === 'merge')
    expect(low).toMatchObject({ allowed: false, refusedBy: 'gate' })
    await sys.pull.update({ where: { id: p.id }, data: { isChecksGreen: true } })
    const after = (await at(5).pull.transitions(p.id)).find((m: { name: string }) => m.name === 'merge')
    expect(after).toMatchObject({ allowed: true, refusedBy: null })
    db.$close()
  })
})

test('a guard is not a conflict', () => {
  expect(TransitionGuardError).not.toBe(TransitionConflictError)
})
