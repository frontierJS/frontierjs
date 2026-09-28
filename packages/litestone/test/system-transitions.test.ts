// test/system-transitions.test.ts
//
// `asSystem()` holds the state machine and lifts only authority (`FJS-D502`).
//
// A system principal still makes only declared moves from the row's current
// state, under the compare-and-swap `FJS-D353` takes once-ness from. It lifts a
// move's `@gate` and `@system`, which say WHO may make it, and nothing that says
// WHAT a move is. The one bypass is `sys.sql`, which says it is one. Where a row
// may start is `transition-entry.test.ts`.
//
// Each refusal is paired with the move one step over that succeeds, so a guard
// refusing the whole verb could not pass it.

import { describe, test, expect } from 'bun:test'
import { createClient, GatePlugin, TransitionViolationError, TransitionConflictError } from '../src/index.js'

const SCHEMA = `
enum DocState { draft  review  published  archived }
model User { id Int @id  @@auth }
model Doc {
  id     Int      @id @default(autoincrement())
  title  String
  status DocState @default(draft)
  @@gate("4.4.4.4")
  @@transitions(status,
    submit:  draft  -> review,
    approve: review -> published @gate(5),
    seize:   draft  -> published @system,
    archive: published -> archived
  )
}`

async function env(onEvent?: Record<string, (e: never) => void>) {
  const db = await createClient({
    schema: SCHEMA, db: ':memory:', onEvent,
    plugins: [new GatePlugin({ getLevel: (u: { level?: number } | null) => u?.level ?? 0 })],
  })
  return { db, sys: db.asSystem(), at: (level: number) => db.$setAuth({ id: 1, level }) }
}

describe('asSystem() holds the machine', () => {
  test('a backwards move, a move off a one-way door and a named move from the wrong state are refused', async () => {
    const { db, sys } = await env()
    const doc = await sys.doc.create({ data: { title: 'a' } })
    await sys.doc.transition(doc.id, 'submit')
    await expect(sys.doc.update({ where: { id: doc.id }, data: { status: 'draft' } }))
      .rejects.toBeInstanceOf(TransitionViolationError)
    await expect(sys.doc.transition(doc.id, 'seize'))
      .rejects.toBeInstanceOf(TransitionViolationError)
    await sys.doc.transition(doc.id, 'approve')
    await sys.doc.transition(doc.id, 'archive')
    await expect(sys.doc.update({ where: { id: doc.id }, data: { status: 'published' } }))
      .rejects.toBeInstanceOf(TransitionViolationError)
    expect((await sys.doc.findFirst({ where: { id: doc.id } })).status).toBe('archived')
    db.$close()
  })

  test('a named move already made is a conflict, not a success', async () => {
    const { db, sys } = await env()
    const doc = await sys.doc.create({ data: { title: 'a' } })
    await sys.doc.transition(doc.id, 'submit')
    await expect(sys.doc.transition(doc.id, 'submit')).rejects.toBeInstanceOf(TransitionConflictError)
    db.$close()
  })

  test('sys.sql is the bypass, and it says so by being SQL', async () => {
    const { db, sys } = await env()
    const doc = await sys.doc.create({ data: { title: 'a' } })
    await sys.sql`UPDATE doc SET status = 'archived' WHERE id = ${doc.id}`
    expect((await sys.doc.findFirst({ where: { id: doc.id } })).status).toBe('archived')
    db.$close()
  })
})

describe('asSystem() lifts only authority', () => {
  test('the gate and @system are lifted', async () => {
    const { db, sys, at } = await env()
    const a = await sys.doc.create({ data: { title: 'a' } })
    await expect(at(7).doc.transition(a.id, 'seize')).rejects.toThrow(/@system/)
    expect((await sys.doc.transition(a.id, 'seize')).status).toBe('published')
    const b = await sys.doc.create({ data: { title: 'b' } })
    await sys.doc.transition(b.id, 'submit')
    await expect(at(4).doc.transition(b.id, 'approve')).rejects.toThrow(/level 5/)
    expect((await sys.doc.transition(b.id, 'approve')).status).toBe('published')
    db.$close()
  })

  test('@gate(9) is nobody, the system client included — by name and by column', async () => {
    const db = await createClient({ db: ':memory:', schema: `
enum S { a  b  c }
model M {
  id Int @id @default(autoincrement())
  s  S   @default(a)
  @@transitions(s, never: a -> b @gate(9), go: a -> c)
}` })
    const sys = db.asSystem()
    const m = await sys.m.create({ data: {} })
    await expect(sys.m.transition(m.id, 'never')).rejects.toThrow(/level 9/)
    await expect(sys.m.update({ where: { id: m.id }, data: { s: 'b' } })).rejects.toThrow(/level 9/)
    expect((await sys.m.transition(m.id, 'go')).s).toBe('c')
    db.$close()
  })

  test('a system move is announced by name', async () => {
    const seen: string[] = []
    const { db, sys } = await env({ transition: (e: { transition: string }) => { seen.push(e.transition) } })
    const doc = await sys.doc.create({ data: { title: 'a' } })
    await sys.doc.transition(doc.id, 'submit')
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual(['submit'])
    db.$close()
  })
})
