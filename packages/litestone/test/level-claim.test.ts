// `auth().level` — the gate's grade, readable by a row policy (`FJS-D296`).
//
// The claim is carried by no principal: both policy compilers ask the gate
// plugin's own cache for `getLevel(auth, model)`, so a policy and a `@@gate`
// cannot disagree about who an administrator is. Each block below pairs the
// caller the rule admits with one it refuses, because a policy that admits
// everybody and a policy that is not applied look the same from one side.
import { describe, it, expect } from 'bun:test'
import { createClient, GatePlugin, LEVELS } from '../src/index.js'

const OWNER_OR_ADMIN = `
model Note {
  id      String @id
  ownerId String
  body    String?
  @@allow('read',   ownerId == auth().id || auth().level >= 5)
  @@allow('create', ownerId == auth().id || auth().level >= 5)
}
`

// The app's own mapping — `role` means nothing to the shipped resolver.
const byRole = (user: any) =>
  !user ? LEVELS.STRANGER : user.role === 'boss' ? LEVELS.ADMINISTRATOR : LEVELS.USER

async function seeded(schema = OWNER_OR_ADMIN, getLevel: any = byRole) {
  const db = await createClient({ schema, db: ':memory:', plugins: [new GatePlugin({ getLevel })] })
  for (const r of [{ id: 'n1', ownerId: 'u1' }, { id: 'n2', ownerId: 'u2' }])
    await db.asSystem().note.create({ data: r })
  return db
}

const ids = (rows: any[]) => rows.map(r => r.id).sort()

describe('auth().level in a row policy', () => {
  it('reads the level the app grades a caller at, through a query', async () => {
    const db = await seeded()
    expect(ids(await db.$setAuth({ id: 'u1' }).note.findMany())).toEqual(['n1'])
    expect(ids(await db.$setAuth({ id: 'u9', role: 'boss' }).note.findMany())).toEqual(['n1', 'n2'])
    expect(ids(await db.$setAuth(null).note.findMany())).toEqual([])
    db.$close()
  })

  it('answers a broadcast the same way — $readAs grades through the same cache', async () => {
    const db  = await seeded()
    const row = { id: 'n2', ownerId: 'u2' }
    expect(await db.$readAs('note', row, { id: 'u1' })).toBeNull()
    expect(await db.$readAs('note', row, { id: 'u9', role: 'boss' })).toEqual(row)
    db.$close()
  })

  it('grades a create in the JS half with the same level', async () => {
    const db = await seeded()
    await expect(db.$setAuth({ id: 'u1' }).note.create({ data: { id: 'x1', ownerId: 'u2' } })).rejects.toThrow()
    const made = await db.$setAuth({ id: 'u9', role: 'boss' }).note.create({ data: { id: 'x2', ownerId: 'u2' } })
    expect(made.id).toBe('x2')
    db.$close()
  })

  it('is not read off the principal, so a caller cannot state their own', async () => {
    const db = await seeded()
    expect(ids(await db.$setAuth({ id: 'u1', level: 7 }).note.findMany())).toEqual(['n1'])
    db.$close()
  })

  it('is the level for the model whose policy is being asked', async () => {
    const schema = `
model Team {
  id      String @id
  ownerId String
  @@allow('read', ownerId == auth().id || auth().level >= 5)
}
model Note {
  id      String @id
  ownerId String
  teamId  String
  team    Team   @relation(fields: [teamId], references: [id])
  @@allow('read', check(team))
}
`
    // An administrator of teams and nothing else: the delegated Team policy
    // must see the Team grade, not the Note one it was reached from.
    const perModel = (user: any, model: string) =>
      user?.role === 'teamAdmin' && model === 'Team' ? LEVELS.ADMINISTRATOR : LEVELS.USER
    const db  = await createClient({ schema, db: ':memory:', plugins: [new GatePlugin({ getLevel: perModel })] })
    const sys = db.asSystem()
    await sys.team.create({ data: { id: 't1', ownerId: 'u2' } })
    await sys.note.create({ data: { id: 'n1', ownerId: 'u2', teamId: 't1' } })
    expect(ids(await db.$setAuth({ id: 'u1', role: 'teamAdmin' }).note.findMany())).toEqual(['n1'])
    expect(ids(await db.$setAuth({ id: 'u1' }).note.findMany())).toEqual([])
    db.$close()
  })

  it('installs the gate when a schema reads it and declares no @@gate', async () => {
    // No plugin passed and no @@gate: without the auto-install the level is
    // absent for every caller and the administrator reads nothing.
    const db = await createClient({ schema: OWNER_OR_ADMIN, db: ':memory:' })
    await db.asSystem().note.create({ data: { id: 'n2', ownerId: 'u2' } })
    expect(ids(await db.$setAuth({ id: 'u9', isAdmin: true }).note.findMany())).toEqual(['n2'])
    expect(ids(await db.$setAuth({ id: 'u1' }).note.findMany())).toEqual([])
    db.$close()
  })

  it('refuses a principal model with its own level column', async () => {
    const schema = `
model User {
  id    String @id
  level Int
  @@auth
}
${OWNER_OR_ADMIN}`
    await expect(createClient({ schema, db: ':memory:' })).rejects.toThrow(/declares a field named 'level'/)
  })
})

describe('getLevel is synchronous', () => {
  it('refuses a Promise by name, at the first grade', async () => {
    const db = await seeded(OWNER_OR_ADMIN, async () => LEVELS.USER)
    await expect(db.$setAuth({ id: 'u1' }).note.findMany()).rejects.toThrow(/getLevel returned a Promise for "Note"/)
    db.$close()
  })
})

// ─── $levelOf ────────────────────────────────────────────────────────────────
//
// The same grade, asked from outside — the seam Junction's method gate reads
// (`FJS-1161`), so a level compared at the API boundary is the one the Data
// boundary would have used. Each claim pairs the app's own mapping with the
// shipped grader's answer for the same caller, because a seam that answered
// `gradeStanding` all along passes any test written against a session-shaped
// principal.
describe('$levelOf', () => {
  it('answers the app mapping for the principal the client is scoped to', async () => {
    const db = await seeded()
    // The shipped grader reads `role` for PRESENCE and answers USER(4) for
    // both of these; the app's mapping is what separates them.
    expect(db.$setAuth({ id: 'u9', role: 'boss' }).$levelOf('note')).toBe(LEVELS.ADMINISTRATOR)
    expect(db.$setAuth({ id: 'u1', role: 'clerk' }).$levelOf('note')).toBe(LEVELS.USER)
    expect(db.$setAuth(null).$levelOf('note')).toBe(LEVELS.STRANGER)
    db.$close()
  })

  it('grades a stated principal instead, which is how a broadcast recipient is asked', async () => {
    const db = await seeded()
    const asClerk = db.$setAuth({ id: 'u1', role: 'clerk' })
    expect(asClerk.$levelOf('note', { id: 'u9', role: 'boss' })).toBe(LEVELS.ADMINISTRATOR)
    expect(asClerk.$levelOf('note', null)).toBe(LEVELS.STRANGER)
    // Stated is not the same as omitted: `null` is a stranger, absent is me.
    expect(asClerk.$levelOf('note')).toBe(LEVELS.USER)
    db.$close()
  })

  it('is per model, and an accessor naming none grades with a null model', async () => {
    const perModel = (user: any, model: string) =>
      user?.role === 'boss' && model === 'Note' ? LEVELS.ADMINISTRATOR : LEVELS.READER
    const db = await seeded(OWNER_OR_ADMIN, perModel)
    const boss = db.$setAuth({ id: 'u9', role: 'boss' })
    expect(boss.$levelOf('note')).toBe(LEVELS.ADMINISTRATOR)
    // A modelless service asking about its own caller — and a name no model
    // answers to — are the same question, and neither may invent a model.
    expect(boss.$levelOf('reports')).toBe(LEVELS.READER)
    expect(boss.$levelOf()).toBe(LEVELS.READER)
    db.$close()
  })

  it('answers SYSTEM for a system client and the same number on every flavor', async () => {
    const db = await seeded()
    expect(db.asSystem().$levelOf('note')).toBe(8)
    // The subject decides, never which flavor was asked.
    const who = { id: 'u9', role: 'boss' }
    expect(db.asSystem().$levelOf('note', who)).toBe(LEVELS.ADMINISTRATOR)
    expect(db.$levelOf('note', who)).toBe(LEVELS.ADMINISTRATOR)
    expect(db.$setAuth({ id: 'u1' }).$levelOf('note', who)).toBe(LEVELS.ADMINISTRATOR)
    db.$close()
  })

  it('answers null where there is no mapping to ask', async () => {
    // No @@gate and nothing reading `auth().level`, so no plugin is installed:
    // *I cannot grade* rather than a level nobody declared.
    const db = await createClient({ schema: 'model Note { id String @id }', db: ':memory:' })
    expect(db.$levelOf('note')).toBeNull()
    expect(db.$setAuth({ id: 'u1', isAdmin: true }).$levelOf('note')).toBeNull()
    db.$close()
  })
})
