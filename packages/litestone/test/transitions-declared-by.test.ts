// test/transitions-declared-by.test.ts
//
// A state machine whose moves are ROWS a tenant wrote (`FJS-D365`, `FJS-2263`):
// `@@transitions(stateId, declaredBy: WorkflowTransition, scope: teamId)`.
//
// Two teams share one table of states and disagree about the moves, so every
// refusal below is paired with the other team making the same kind of move —
// a guard that refused everything would pass a test asking only about refusal.

import { describe, test, expect } from 'bun:test'
import { createClient, parse, GatePlugin, generateJsonSchema,
         TransitionViolationError, TransitionGateError, ValidationError } from '../src/index.js'

const DECL = `
model WorkflowTransition {
  id     Int     @id @default(autoincrement())
  teamId String
  fromId String?
  toId   String
  gate   Int?
}`

const SCHEMA = `
model User { id Int @id  @@auth }
${DECL}
model Issue {
  id      Int    @id @default(autoincrement())
  teamId  String
  title   String
  stateId String
  @@gate(4.4.4.4)
  @@transitions(stateId, declaredBy: WorkflowTransition, scope: teamId)
}`

async function env() {
  const db = await createClient({
    schema: SCHEMA, db: ':memory:',
    plugins: [new GatePlugin({ getLevel: (u: { level?: number } | null) => u?.level ?? 0 })],
  })
  const sys = db.asSystem()
  // ENG: triage is the entry, then todo, doing, done; reopening is a lead's.
  // SEC: two entries, and todo goes straight to done.
  for (const [teamId, fromId, toId, gate] of [
    ['eng', null,    'triage', null],
    ['eng', 'triage', 'todo',  null],
    ['eng', 'todo',  'doing',  null],
    ['eng', 'doing', 'done',   null],
    ['eng', 'done',  'todo',   5],
    ['sec', null,    'todo',   null],
    ['sec', null,    'triage', null],
    ['sec', 'todo',  'done',   null],
  ] as const) await sys.workflowTransition.create({ data: { teamId, fromId, toId, gate } })
  return { db, sys, user: db.$setAuth({ id: 1, level: 4 }), lead: db.$setAuth({ id: 2, level: 5 }) }
}

describe('the declaration parses, and its declarer is graded', () => {
  test('a declared machine parses with no moves in the file and no @default', () => {
    const r = parse(SCHEMA)
    expect(r.errors).toEqual([])
    const attr = r.schema.models.find((m: any) => m.name === 'Issue').attributes.find((a: any) => a.kind === 'transitions')
    expect(attr).toMatchObject({ field: 'stateId', declaredBy: 'WorkflowTransition', scope: 'teamId' })
  })

  test('a declarer missing its shape is refused by the column it lacks', () => {
    const errors = parse(SCHEMA.replace('  toId   String\n', '')).errors.join('\n')
    expect(errors).toContain("'WorkflowTransition' has no 'toId' column")
    expect(parse(SCHEMA.replace('fromId String?', 'fromId String')).errors.join('\n'))
      .toContain("'WorkflowTransition.fromId' is String and has to be String?")
  })

  test('the scope must name a column on both models', () => {
    expect(parse(SCHEMA.replace('scope: teamId', 'scope: groupId')).errors.join('\n'))
      .toContain("this model has no field 'groupId'")
  })

  test('a @default beside a declared machine is refused, since the entry rows are the default', () => {
    expect(parse(SCHEMA.replace('stateId String\n', 'stateId String @default("triage")\n')).errors.join('\n'))
      .toContain('the entries declared in WorkflowTransition are where a row starts')
  })

  test('an unknown argument is refused by name', () => {
    expect(parse(SCHEMA.replace('scope: teamId', 'scope: teamId, max: 3')).errors.join('\n'))
      .toContain("unknown argument 'max'")
  })
})

describe('a move is a row in the team\'s table', () => {
  test('each team makes its own moves and is refused the other\'s', async () => {
    const { user } = await env()
    const eng = await user.issue.create({ data: { teamId: 'eng', title: 'a', stateId: 'triage' } })
    const sec = await user.issue.create({ data: { teamId: 'sec', title: 'b', stateId: 'todo' } })

    const skip = await user.issue.update({ where: { id: eng.id }, data: { stateId: 'done' } }).catch(e => e)
    expect(skip).toBeInstanceOf(TransitionViolationError)
    expect(skip.message).toContain("'todo'")
    expect((await user.issue.update({ where: { id: eng.id }, data: { stateId: 'todo' } })).stateId).toBe('todo')

    // SEC goes todo -> done; ENG at todo may not.
    expect((await user.issue.update({ where: { id: sec.id }, data: { stateId: 'done' } })).stateId).toBe('done')
    await expect(user.issue.update({ where: { id: eng.id }, data: { stateId: 'done' } }))
      .rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('a move\'s gate is a row\'s gate column', async () => {
    const { user, lead, sys } = await env()
    const row = await user.issue.create({ data: { teamId: 'eng', title: 'a' } })
    for (const to of ['todo', 'doing', 'done'])
      await user.issue.update({ where: { id: row.id }, data: { stateId: to } })
    await expect(user.issue.update({ where: { id: row.id }, data: { stateId: 'todo' } }))
      .rejects.toBeInstanceOf(TransitionGateError)
    expect((await lead.issue.update({ where: { id: row.id }, data: { stateId: 'todo' } })).stateId).toBe('todo')
    // The machine is integrity: asSystem() lifts the gate and not the moves.
    await expect(sys.issue.update({ where: { id: row.id }, data: { stateId: 'triage' } }))
      .rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('a move removed from the table is refused at once, with no migration', async () => {
    const { user, sys } = await env()
    const row = await user.issue.create({ data: { teamId: 'eng', title: 'a' } })
    await sys.workflowTransition.deleteMany({ where: { teamId: 'eng', fromId: 'triage', toId: 'todo' } })
    await expect(user.issue.update({ where: { id: row.id }, data: { stateId: 'todo' } }))
      .rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('transition(id, to) makes a declared move by its target', async () => {
    const { user } = await env()
    const row = await user.issue.create({ data: { teamId: 'eng', title: 'a' } })
    expect((await user.issue.transition(row.id, 'todo')).stateId).toBe('todo')
    await expect(user.issue.transition(row.id, 'done')).rejects.toBeInstanceOf(TransitionViolationError)
  })

  test('updateMany may not name the column, as for a machine in the file', async () => {
    const { user } = await env()
    await user.issue.create({ data: { teamId: 'eng', title: 'a' } })
    await expect(user.issue.updateMany({ where: {}, data: { stateId: 'todo' } })).rejects.toThrow(/stateId/)
  })
})

describe('a row starts at one of its team\'s entries', () => {
  test('a create naming no state lands on the team\'s one entry', async () => {
    const { user } = await env()
    expect((await user.issue.create({ data: { teamId: 'eng', title: 'a' } })).stateId).toBe('triage')
  })

  test('a create naming a state that is not an entry is refused, and naming an entry lands', async () => {
    const { user, sys } = await env()
    const err = await user.issue.create({ data: { teamId: 'eng', title: 'a', stateId: 'done' } }).catch(e => e)
    expect(err).toBeInstanceOf(TransitionViolationError)
    expect(err.message).toContain("'triage'")
    await expect(sys.issue.create({ data: { teamId: 'eng', title: 'a', stateId: 'done' } }))
      .rejects.toBeInstanceOf(TransitionViolationError)
    expect((await user.issue.create({ data: { teamId: 'sec', title: 'b', stateId: 'triage' } })).stateId).toBe('triage')
  })

  test('a team with two entries must be told which, and a team with none has no create', async () => {
    const { user } = await env()
    const two = await user.issue.create({ data: { teamId: 'sec', title: 'a' } }).catch(e => e)
    expect(two).toBeInstanceOf(ValidationError)
    expect(two.message).toContain("'todo'")
    const none = await user.issue.create({ data: { teamId: 'ops', title: 'a' } }).catch(e => e)
    expect(none).toBeInstanceOf(ValidationError)
  })
})

describe('what is derived from it', () => {
  test('transitions(row) reads the team\'s moves, gate included', async () => {
    const { user, lead } = await env()
    const row = await user.issue.create({ data: { teamId: 'eng', title: 'a' } })
    expect((await user.issue.transitions(row.id)).map((m: any) => [m.to, m.allowed]))
      .toEqual([['todo', true]])
    for (const to of ['todo', 'doing', 'done'])
      await user.issue.update({ where: { id: row.id }, data: { stateId: to } })
    expect(await user.issue.transitions(row.id)).toEqual([
      { name: 'todo', field: 'stateId', from: 'done', to: 'todo', gate: 5, system: false, allowed: false, refusedBy: 'gate' },
    ])
    expect((await lead.issue.transitions(row.id))[0].allowed).toBe(true)
  })

  test('the JSON Schema does not require the column, since an entry fills it', () => {
    const def = generateJsonSchema(parse(SCHEMA).schema).$defs.Issue
    expect(def.required).not.toContain('stateId')
    expect(def.required).toContain('teamId')
  })
})
