// FJS-611 — a declared state machine has to hold when two callers ask at once.
//
// `@@transitions` reads as if the boundary enforces it, the way a `@@check` or a
// `@@gate` does. The compare-and-swap that makes that true was already here —
// the UPDATE carries `AND status = <from>`, so a racing writer loses. What was
// not here is the difference between the two calls that reach it:
//
//   update({ data: { status } })  carries a column, and carrying the value the
//                                 row ALREADY holds is legitimate, because a
//                                 form round-trips the whole row.
//   transition(id, 'calculate')   asks for a MOVE, and the same row state means
//                                 the opposite: it did not happen here.
//
// transition() desugars into update(), so all that arrived was a column and a
// value, and the early return on `currentValue === newValue` answered the first
// question to both. It took the gate, the capability and `@system` with it.
//
// Every assertion below is a MEASUREMENT of the code as it stood, not a
// description of it: the four-concurrent case already passed (the CAS works),
// the five that follow did not.

import { describe, it, expect } from 'bun:test'
import { createClient, autoMigrate, GatePlugin } from '../src/index.js'

const SCHEMA = `
model Run {
  id     Int      @id @default(autoincrement())
  name   String   @default("r")
  status RunState @default(draft)
  @@transitions(status,
    calculate: draft      -> calculated,
    cancel:    draft      -> cancelled,
    approve:   calculated -> approved @gate(5),
    pay:       approved   -> paid @system)
}
enum RunState { draft calculated cancelled approved paid }
`

const setup = async (level = 4) => {
  const db = await createClient({
    db: ':memory:', schema: SCHEMA,
    plugins: [new GatePlugin({ getLevel: () => level })],
  })
  autoMigrate(db)
  return db
}
const mk = async (db: any) => (await db.asSystem().run.create({ data: {} })).id
const names = (r: PromiseSettledResult<unknown>[]) =>
  r.map(x => x.status === 'fulfilled' ? 'ok' : (x.reason as Error).name)

describe('two callers, one move', () => {
  // The half that already worked, kept as the control: without it a suite that
  // goes green after the fix cannot say which half of the mechanism it proved.
  it('four concurrent identical moves: exactly one wins', async () => {
    const db = await setup()
    const id = await mk(db)
    const r  = await Promise.allSettled([0, 1, 2, 3].map(() => db.run.transition(id, 'calculate')))
    expect(names(r).filter(n => n === 'ok')).toHaveLength(1)
    expect(names(r).filter(n => n === 'TransitionConflictError')).toHaveLength(3)
    expect((await db.run.findUnique({ where: { id } })).status).toBe('calculated')
    await db.$close()
  })

  // The measured defect. Nothing is corrupt either way — the row lands at
  // `calculated` — so the whole of the damage is in the ANSWER: `if (moved)
  // notify()` fires N times, and every worker in a batch believes it wrote the
  // last row.
  it('a move onto the state the row already holds is a conflict, not a success', async () => {
    const db = await setup()
    const id = await mk(db)
    await db.run.transition(id, 'calculate')
    await expect(db.run.transition(id, 'calculate')).rejects.toThrow(/already been made/)
    await db.$close()
  })

  // `$transaction` is the documented mitigation and it made this WORSE, not
  // better: serializing the callers means each one re-reads AFTER the winner
  // committed, which is precisely the state the early return called a no-op.
  // All four succeeded.
  it('inside $transaction too — serializing the callers used to hide it', async () => {
    const db = await setup()
    const id = await mk(db)
    const r  = await Promise.allSettled([0, 1, 2, 3].map(() =>
      db.$transaction(async (tx: any) => tx.run.transition(id, 'calculate'))))
    expect(names(r).filter(n => n === 'ok')).toHaveLength(1)
    await db.$close()
  })
})

describe('the refusal says what to do about it', () => {
  // Two opposite races under one error class, and `retryable` is what separates
  // them — `isStaleWrite()` reads it, so a worker that cannot tell them apart
  // loops for ever against a row that has settled.
  it('the move you asked for was already made — retrying can never work', async () => {
    const db = await setup()
    const id = await mk(db)
    await db.run.transition(id, 'calculate')
    try {
      await db.run.transition(id, 'calculate')
      throw new Error('should have refused')
    } catch (e: any) {
      expect(e.name).toBe('TransitionConflictError')
      expect(e.status).toBe(409)
      expect(e.retryable).toBe(false)
      expect(e.actual).toBe('calculated')
      expect(e.move).toBe('calculate')
      expect(e.expected).toEqual(['draft'])
      // Instance properties do not cross junction's error boundary; `data`
      // does. Without it `actual` is server-side only and a browser cannot tell
      // the two races apart — which is the whole of what was just built.
      // `toConflict()` in sierra reads exactly these.
      expect(e.data).toMatchObject({ model: 'run', field: 'status', actual: 'calculated', move: 'calculate' })
    }
    await db.$close()
  })

  // Two moves raced in one process answer what the same two moves answer in
  // sequence, and that is the assertion: `calculated -> cancelled` is not a
  // declared move, so asking for it is a violation however the row got there.
  //
  // It used to answer `TransitionConflictError` with `retryable: true` — but
  // only because both callers evaluated against `draft` before either
  // committed, so the SAME end state gave two different classes depending on
  // which request won a footrace, and the retry that answer advised failed
  // identically. Writes are serialized now (`FJS-638`), so there is no
  // interleaving left to infer a race from.
  //
  // The signal is not lost, it is relocated to where every other system earns
  // it: a declared precondition. HTTP answers 412 because the caller sent
  // `If-Match`; Hibernate and EF Core throw because a version column
  // mismatched. `transition(id, 'cancel')` states nothing about what the caller
  // read, so the boundary cannot honestly tell *somebody moved it under me*
  // from *I asked for an illegal move* — `@version` is litestone's `If-Match`
  // and is what a screen wanting the first one declares (`FJS-D171`). The
  // engine-detected race survives where it is real: across processes, where the
  // UPDATE's compare-and-swap is the only authority.
  it('two moves raced in one process answer the same as two moves in sequence', async () => {
    const db  = await setup()
    const seq = await mk(db)
    await db.run.transition(seq, 'calculate')
    const sequential = await db.run.transition(seq, 'cancel').catch((e: any) => e)

    const id = await mk(db)
    const r  = await Promise.allSettled([
      db.run.transition(id, 'calculate'),
      db.run.transition(id, 'cancel'),
    ])
    const lost = r.find(x => x.status === 'rejected') as PromiseRejectedResult

    expect((lost.reason as any).name).toBe('TransitionViolationError')
    expect((lost.reason as any).retryable).toBe(false)
    expect((lost.reason as any).name).toBe(sequential.name)
    // One winner, and it is the one that moved the row.
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1)
    expect((await db.asSystem().run.findUnique({ where: { id } })).status).toBe('calculated')
    await db.$close()
  })
})

// The half that is an ACCESS defect rather than an answer one. The early return
// fired before the gate, the capability and `@system`, so a caller who may
// update the model could "make" a move they are refused — as long as the row
// was already at the target. Both succeeded, measured.
describe('the skip took the caller grading with it', () => {
  it('a @gate(5) move is refused at level 4 even where the row is already there', async () => {
    const db = await setup(4)
    const id = await mk(db)
    await db.asSystem().run.update({ where: { id }, data: { status: 'approved' } })
    await expect(db.run.transition(id, 'approve')).rejects.toThrow(/TransitionGateError|not senior|level/i)
    await db.$close()
  })

  it('a @system move is refused for an ordinary caller where the row is already there', async () => {
    const db = await setup(5)
    const id = await mk(db)
    await db.asSystem().run.update({ where: { id }, data: { status: 'paid' } })
    await expect(db.run.transition(id, 'pay')).rejects.toThrow(/is @system/)
    await db.$close()
  })
})

// The negative controls. The fix is a distinction between two callers of one
// code path, so it is only worth anything if the OTHER caller is unchanged —
// and the shape that would break is the commonest write an app makes.
describe('an ordinary update is untouched', () => {
  it('round-tripping the unchanged state column is still a silent no-op', async () => {
    const db = await setup()
    const id = await mk(db)
    await db.run.transition(id, 'calculate')
    const row = await db.run.update({ where: { id }, data: { name: 'renamed', status: 'calculated' } })
    expect(row.name).toBe('renamed')
    expect(row.status).toBe('calculated')
    await db.$close()
  })

  it('and setting the column to a legal next state is still the move', async () => {
    const db = await setup()
    const id = await mk(db)
    const row = await db.run.update({ where: { id }, data: { status: 'calculated' } })
    expect(row.status).toBe('calculated')
    await db.$close()
  })

  it('asSystem() bypasses this like every other rule in this package', async () => {
    const db = await setup()
    const id = await mk(db)
    await db.asSystem().run.transition(id, 'calculate')
    const row = await db.asSystem().run.transition(id, 'calculate')
    expect(row.status).toBe('calculated')
    await db.$close()
  })
})
