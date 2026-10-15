// test/exclude-scope.test.ts
//
// FJS-D474: a schema-level `scope <name>(<field>)` and the
// `@@exclude(<scope>, range: [a, b])` each member model states. The first half
// proves a declaration cannot name nothing (FJS-1527); the second that every
// write landing or moving a row is graded against every member at the
// outermost commit, under the Data boundary (FJS-1528).

import { describe, test, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'

const SHIFT = `
  model Shift {
    id         Int      @id
    employeeId Int
    startsAt   DateTime
    endsAt     DateTime
    @@exclude(person, range: [startsAt, endsAt])
  }`

const LEAVE = `
  model LeaveRequest {
    id         Int     @id
    employeeId Int
    fromDate   String  @date
    toDate     String? @date
    @@exclude(person, range: [fromDate, toDate])
  }`

function errorsOf(src: string): string[] {
  const r = parse(src)
  return r.errors
}

describe('scope + @@exclude — FJS-1527', () => {
  test('a scope cited by two models parses, and the declaration survives onto the schema', () => {
    const r = parse(`scope person(employeeId)\n${SHIFT}\n${LEAVE}`)
    expect(r.errors).toEqual([])
    expect(r.schema.scopes).toEqual([{ name: 'person', fields: ['employeeId'] }])
    const shift = r.schema.models.find((m: any) => m.name === 'Shift')
    expect(shift.attributes.find((a: any) => a.kind === 'exclude'))
      .toEqual({ kind: 'exclude', scope: 'person', range: ['startsAt', 'endsAt'] })
  })

  test('an @@exclude naming no declared scope is refused by name', () => {
    const errs = errorsOf(SHIFT)
    expect(errs.some(e => e.includes("@@exclude(person") && e.includes("no scope 'person'"))).toBe(true)
  })

  test('a scope declared twice is refused', () => {
    const errs = errorsOf(`scope person(employeeId)\nscope person(userId)\n${SHIFT}`)
    expect(errs.some(e => e.includes("scope 'person' is declared twice"))).toBe(true)
  })

  test("a member model lacking the scope's field is refused", () => {
    const errs = errorsOf(`scope person(staffId)\n${SHIFT}`)
    expect(errs.some(e => e.includes("Model 'Shift'") && e.includes("'staffId'"))).toBe(true)
  })

  test('a range field the model lacks is refused', () => {
    const errs = errorsOf(`scope person(employeeId)\n${SHIFT.replace('endsAt]', 'finishesAt]')}`)
    expect(errs.some(e => e.includes("Model 'Shift'") && e.includes("'finishesAt'"))).toBe(true)
  })

  test('a range pair of two different kinds is refused', () => {
    const errs = errorsOf(`scope person(employeeId)\n${SHIFT.replace('endsAt     DateTime', 'endsAt     Int')}`)
    expect(errs.some(e => e.includes("Model 'Shift'") && e.includes('same kind'))).toBe(true)
  })

  test('a String range with no @date/@datetime is refused — text does not order as a range', () => {
    const errs = errorsOf(`scope person(employeeId)\n${LEAVE.replaceAll(' @date', '')}`)
    expect(errs.some(e => e.includes("Model 'LeaveRequest'") && e.includes('fromDate'))).toBe(true)
  })

  test('a range naming one field twice is refused', () => {
    const errs = errorsOf(`scope person(employeeId)\n${SHIFT.replace('[startsAt, endsAt]', '[startsAt, startsAt]')}`)
    expect(errs.some(e => e.includes("Model 'Shift'") && e.includes('two different fields'))).toBe(true)
  })

  test('a range that is not a pair is refused at parse', () => {
    const errs = errorsOf(`scope person(employeeId)\n${SHIFT.replace('[startsAt, endsAt]', '[startsAt]')}`)
    expect(errs.some(e => e.includes('@@exclude') && e.includes('two fields'))).toBe(true)
  })

  test('an @@exclude with no range is refused at parse', () => {
    const errs = errorsOf(`scope person(employeeId)\n${SHIFT.replace(', range: [startsAt, endsAt]', '')}`)
    expect(errs.some(e => e.includes('@@exclude') && e.includes('range'))).toBe(true)
  })

  test('an unknown argument is refused by name', () => {
    const errs = errorsOf(`scope person(employeeId)\n${SHIFT.replace('range:', 'span:')}`)
    expect(errs.some(e => e.includes("unknown argument 'span'"))).toBe(true)
  })

  test('a scope field that is a relation or an array is refused — a lock key is one value', () => {
    const errs = errorsOf(`scope person(tags)\n${SHIFT.replace('employeeId Int', 'employeeId Int\n    tags String[]')}`)
    expect(errs.some(e => e.includes("Model 'Shift'") && e.includes("'tags'"))).toBe(true)
  })

  test('a scope no model cites is a warning — it serializes nothing', () => {
    const r = parse(`scope person(employeeId)\nscope site(siteId)\n${SHIFT}`)
    expect(r.errors).toEqual([])
    expect(r.warnings).toContain(`scope 'site' is cited by no @@exclude — it serializes nothing`)
  })

  test('a declared @@exclude parses with no warning — the write path enforces it', () => {
    const r = parse(`scope person(employeeId)\n${SHIFT}`)
    expect(r.warnings.filter((w: string) => w.includes('@@exclude'))).toEqual([])
  })

  test('a scope mixing a numeric range with a time range is refused — they share no point', () => {
    const SLOT = `
  model Slot {
    id         Int @id
    employeeId Int
    fromHour   Int
    toHour     Int
    @@exclude(person, range: [fromHour, toHour])
  }`
    const errs = errorsOf(`scope person(employeeId)\n${SHIFT}\n${SLOT}`)
    expect(errs.some(e => e.includes("scope 'person' mixes") && e.includes('Slot') && e.includes('Shift'))).toBe(true)
  })

  test('a scope survives an import', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const { parseFile } = await import('../src/core/parser.js')
    const dir = mkdtempSync(join(tmpdir(), 'exclude-scope-'))
    writeFileSync(join(dir, 'scopes.lite'), 'scope person(employeeId)\n')
    writeFileSync(join(dir, 'schema.lite'), `import "./scopes.lite"\n${SHIFT}`)
    const r = parseFile(join(dir, 'schema.lite'))
    expect(r.errors).toEqual([])
    expect(r.schema.scopes).toEqual([{ name: 'person', fields: ['employeeId'] }])
  })
})

// ─── the write path — FJS-1528 ────────────────────────────────────────────────

const WRITE_SCHEMA = `
  claim id
  scope person(employeeId)

  model Shift {
    id         Int       @id @default(autoincrement())
    employeeId Int
    startsAt   DateTime
    endsAt     DateTime?
    note       String?
    deletedAt  DateTime?
    @@softDelete
    @@exclude(person, range: [startsAt, endsAt])
    @@allow('all', true)
  }

  model LeaveRequest {
    id         Int     @id @default(autoincrement())
    employeeId Int
    fromDate   String  @date
    toDate     String  @date
    @@exclude(person, range: [fromDate, toDate])
    @@allow('create', true)
    @@allow('read', employeeId == auth().id)
  }
`

async function open() {
  const { createClient } = await import('../src/index.js')
  return (await createClient({ db: ':memory:', schema: WRITE_SCHEMA })) as any
}

const at = (h: number, day = 2) => `2026-10-0${day}T${String(h).padStart(2, '0')}:00:00.000Z`

async function refusal(p: Promise<unknown>) {
  try { await p } catch (e: any) { return e }
  return null
}

describe('@@exclude on the write path — FJS-1528', () => {
  test('a create overlapping another row on the same key is refused with a 409, and lands nothing', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(17) } })
    const e = await refusal(sys.shift.create({ data: { employeeId: 1, startsAt: at(16), endsAt: at(20) } }))
    expect(e?.name).toBe('OverlapConflictError')
    expect(e.status).toBe(409)
    expect(e.errors[0].path).toEqual(['startsAt'])
    expect(await sys.shift.count()).toBe(1)
    db.$close()
  })

  test('touching ends do not overlap — a range is [start, end)', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(17) } })
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(17), endsAt: at(21) } })
    expect(await sys.shift.count()).toBe(2)
    db.$close()
  })

  test('another key is another scope — two people may work the same hours', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(17) } })
    await sys.shift.create({ data: { employeeId: 2, startsAt: at(9), endsAt: at(17) } })
    expect(await sys.shift.count()).toBe(2)
    db.$close()
  })

  test('a shift on a day of leave is refused across models, and the day after the leave ends is not', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.leaveRequest.create({ data: { employeeId: 1, fromDate: '2026-10-01', toDate: '2026-10-03' } })
    const e = await refusal(sys.shift.create({ data: { employeeId: 1, startsAt: at(9, 2), endsAt: at(17, 2) } }))
    expect(e?.name).toBe('OverlapConflictError')
    expect(e.with.model).toBe('LeaveRequest')
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(9, 3), endsAt: at(17, 3) } })
    db.$close()
  })

  test('leave overlapping a shift is refused the other way round — one declaration, both write paths', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(9, 2), endsAt: at(17, 2) } })
    const e = await refusal(sys.leaveRequest.create({ data: { employeeId: 1, fromDate: '2026-10-02', toDate: '2026-10-04' } }))
    expect(e?.name).toBe('OverlapConflictError')
    expect(e.model).toBe('LeaveRequest')
    db.$close()
  })

  test('the grade reads under the Data boundary — a caller who cannot read the leave is still refused by it', async () => {
    const db = await open()
    await db.asSystem().leaveRequest.create({ data: { employeeId: 1, fromDate: '2026-10-01', toDate: '2026-10-03' } })
    const manager = db.$setAuth({ id: 99 })
    expect(await manager.leaveRequest.findMany()).toEqual([])
    const e = await refusal(manager.shift.create({ data: { employeeId: 1, startsAt: at(9, 2), endsAt: at(17, 2) } }))
    expect(e?.name).toBe('OverlapConflictError')
    db.$close()
  })

  test('an update moving a row into another is refused, and the row keeps its range', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(12) } })
    const b = await sys.shift.create({ data: { employeeId: 1, startsAt: at(13), endsAt: at(17) } })
    expect((await refusal(sys.shift.update({ where: { id: b.id }, data: { startsAt: at(11) } })))?.name).toBe('OverlapConflictError')
    expect((await refusal(sys.shift.update({ where: { id: b.id }, data: { startsAt: at(11) }, select: false })))?.name).toBe('OverlapConflictError')
    expect((await sys.shift.findUnique({ where: { id: b.id } })).startsAt).toBe(at(13))
    db.$close()
  })

  test('an update moving a row to another key is graded under the new key', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.shift.create({ data: { employeeId: 2, startsAt: at(9), endsAt: at(17) } })
    const b = await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(17) } })
    expect((await refusal(sys.shift.update({ where: { id: b.id }, data: { employeeId: 2 } })))?.name).toBe('OverlapConflictError')
    db.$close()
  })

  test('an updateMany sliding rows into each other is refused whole', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(12) } })
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(13), endsAt: at(17) } })
    const e = await refusal(sys.shift.updateMany({ where: { employeeId: 1 }, data: { endsAt: at(18) } }))
    expect(e?.name).toBe('OverlapConflictError')
    expect((await sys.shift.findMany({ orderBy: { id: 'asc' } })).map((r: any) => r.endsAt)).toEqual([at(12), at(17)])
    db.$close()
  })

  test('createMany is graded as one unit', async () => {
    const db = await open()
    const sys = db.asSystem()
    const e = await refusal(sys.shift.createMany({ data: [
      { employeeId: 1, startsAt: at(9), endsAt: at(12) },
      { employeeId: 1, startsAt: at(11), endsAt: at(14) },
    ] }))
    expect(e?.name).toBe('OverlapConflictError')
    expect(await sys.shift.count()).toBe(0)
    db.$close()
  })

  test('inside $transaction the grade is at the outer commit, and a refusal rolls back the whole unit', async () => {
    const db = await open()
    const e = await refusal(db.$transaction(async (tx: any) => {
      const sys = tx.asSystem()
      await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(12) } })
      await sys.shift.create({ data: { employeeId: 1, startsAt: at(10), endsAt: at(14) } })
    }))
    expect(e?.name).toBe('OverlapConflictError')
    expect(await db.asSystem().shift.count()).toBe(0)
    db.$close()
  })

  test('two concurrent creates for one person land exactly one', async () => {
    const db = await open()
    const sys = db.asSystem()
    const results = await Promise.allSettled([
      sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(17) } }),
      sys.shift.create({ data: { employeeId: 1, startsAt: at(10), endsAt: at(18) } }),
    ])
    expect(results.filter(r => r.status === 'fulfilled').length).toBe(1)
    expect(await sys.shift.count()).toBe(1)
    db.$close()
  })

  test('an open end is still going — a clock-in with no clock-out excludes everything after it', async () => {
    const db = await open()
    const sys = db.asSystem()
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(9) } })
    expect((await refusal(sys.shift.create({ data: { employeeId: 1, startsAt: at(20, 5), endsAt: at(21, 5) } })))?.name).toBe('OverlapConflictError')
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(6), endsAt: at(9) } })
    db.$close()
  })

  test('a soft-deleted row occupies nothing, and restoring it into an overlap is refused', async () => {
    const db = await open()
    const sys = db.asSystem()
    const a = await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(17) } })
    await sys.shift.remove({ where: { id: a.id } })
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(10), endsAt: at(18) } })
    expect((await refusal(sys.shift.restore({ where: { id: a.id } })))?.name).toBe('OverlapConflictError')
    db.$close()
  })

  test('an end before its start is refused — it would otherwise overlap nothing in silence', async () => {
    const db = await open()
    const e = await refusal(db.asSystem().shift.create({ data: { employeeId: 1, startsAt: at(17), endsAt: at(9) } }))
    expect(e?.name).toBe('OverlapConflictError')
    expect(e.message).toContain('not a range')
    db.$close()
  })

  test('a delete is never graded — removing one of two rows that already overlap succeeds', async () => {
    const db = await open()
    const raw = db.asSystem().sql
    await raw`INSERT INTO "shift" ("employeeId", "startsAt", "endsAt") VALUES (1, ${at(9)}, ${at(17)}), (1, ${at(10)}, ${at(18)})`
    const sys = db.asSystem()
    const [first] = await sys.shift.findMany({ orderBy: { id: 'asc' } })
    await sys.shift.delete({ where: { id: first.id } })
    expect(await sys.shift.count()).toBe(1)
    db.$close()
  })

  test('an update naming neither the key nor the range is not graded', async () => {
    const db = await open()
    const raw = db.asSystem().sql
    await raw`INSERT INTO "shift" ("employeeId", "startsAt", "endsAt") VALUES (1, ${at(9)}, ${at(17)}), (1, ${at(10)}, ${at(18)})`
    const sys = db.asSystem()
    const [first] = await sys.shift.findMany({ orderBy: { id: 'asc' } })
    await sys.shift.update({ where: { id: first.id }, data: { note: 'swapped' } })
    db.$close()
  })
})

// ─── where: — FJS-1569 ────────────────────────────────────────────────────────
//
// A cancelled shift or a refused leave request holds no time. Without `where:`
// every row in the scope counted, so the one cancellation a rota exists to
// absorb refused the next write under that person for good.

const WHERE_SCHEMA = `
  scope person(employeeId)

  enum ShiftStatus { draft published cancelled }
  enum LeaveStatus { requested approved refused }

  model Shift {
    id         Int         @id @default(autoincrement())
    employeeId Int
    startsAt   DateTime
    endsAt     DateTime
    status     ShiftStatus @default(draft) @map("shift_status")
    @@exclude(person, range: [startsAt, endsAt], where: status != "cancelled")
    @@allow('all', true)
  }

  model LeaveRequest {
    id         Int         @id @default(autoincrement())
    employeeId Int
    startsAt   DateTime
    endsAt     DateTime
    status     LeaveStatus @default(requested)
    @@exclude(person, range: [startsAt, endsAt], where: status == "approved")
    @@allow('all', true)
  }
`

async function openWhere() {
  const { createClient } = await import('../src/index.js')
  return (await createClient({ db: ':memory:', schema: WHERE_SCHEMA })) as any
}

describe('@@exclude(…, where:) — FJS-1569', () => {
  test('parses, and refuses what a partial @@unique refuses', () => {
    expect(parse(WHERE_SCHEMA).errors).toEqual([])
    const bad = (where: string) => errorsOf(`scope person(employeeId)
      model Shift {
        id Int @id
        employeeId Int
        startsAt DateTime
        endsAt DateTime
        status String
        @@exclude(person, range: [startsAt, endsAt], where: ${where})
      }`).join('\n')
    expect(bad('nope == "x"')).toContain(`'nope'`)
    expect(bad('status == auth().id')).toContain('auth()')
    expect(bad('"status != cancelled"')).toContain('not SQL')
  })

  test('a row outside the predicate holds no time — a cancelled shift frees its hours', async () => {
    const db = await openWhere()
    const sys = db.asSystem()
    const a = await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(17) } })
    expect((await refusal(sys.shift.create({ data: { employeeId: 1, startsAt: at(10), endsAt: at(12) } })))?.name)
      .toBe('OverlapConflictError')
    await sys.shift.update({ where: { id: a.id }, data: { status: 'cancelled' } })
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(10), endsAt: at(12) } })
    expect(await sys.shift.count()).toBe(2)
    db.$close()
  })

  test('an update moving a row INTO the predicate is graded — un-cancelling into an overlap is refused', async () => {
    const db = await openWhere()
    const sys = db.asSystem()
    const a = await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(17), status: 'cancelled' } })
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(10), endsAt: at(12) } })
    const e = await refusal(sys.shift.update({ where: { id: a.id }, data: { status: 'published' } }))
    expect(e?.name).toBe('OverlapConflictError')
    expect((await sys.shift.findUnique({ where: { id: a.id } })).status).toBe('cancelled')
    db.$close()
  })

  test('across models — requested leave holds nothing, approving it over a shift is refused', async () => {
    const db = await openWhere()
    const sys = db.asSystem()
    const leave = await sys.leaveRequest.create({ data: { employeeId: 1, startsAt: at(0), endsAt: at(0, 3) } })
    await sys.shift.create({ data: { employeeId: 1, startsAt: at(9), endsAt: at(17) } })
    const e = await refusal(sys.leaveRequest.update({ where: { id: leave.id }, data: { status: 'approved' } }))
    expect(e?.name).toBe('OverlapConflictError')
    expect(e.with.model).toBe('Shift')
    db.$close()
  })
})

// ─── a wall-clock range under a two-field scope — FJS-2781 ───────────────────

const CLOCK = `
  claim id
  scope personDay(personId, dayId)

  model Slot {
    id       Int    @id @default(autoincrement())
    personId Int
    dayId    Int
    opensAt  String @time(seconds: true)
    shutsAt  String @time(seconds: true)
    @@exclude(personDay, range: [opensAt, shutsAt])
    @@allow('all', true)
  }
`

describe('a two-field scope over an @time range — FJS-2781', () => {
  test('parses: the scope keeps its fields as a list', () => {
    const r = parse(CLOCK)
    expect(r.errors).toEqual([])
    expect(r.schema.scopes).toEqual([{ name: 'personDay', fields: ['personId', 'dayId'] }])
  })

  test('a member lacking one of the scope fields is refused by name', () => {
    const errs = errorsOf(CLOCK.replace('    dayId    Int\n', ''))
    expect(errs.some(e => e.includes("Model 'Slot'") && e.includes("'dayId'"))).toBe(true)
  })

  test('a String range with no format at all still names @time among what orders', () => {
    const errs = errorsOf(CLOCK.replaceAll(' @time(seconds: true)', ''))
    expect(errs.some(e => e.includes('@time'))).toBe(true)
  })

  test('a clock range shares no point with an instant — mixing them in one scope is refused', () => {
    const errs = errorsOf(`${CLOCK}\nmodel Shift {\n  id Int @id\n  personId Int\n  dayId Int\n  startsAt DateTime\n  endsAt DateTime\n  @@exclude(personDay, range: [startsAt, endsAt])\n}`)
    expect(errs.some(e => e.includes("scope 'personDay'") && e.includes('clock'))).toBe(true)
  })

  test('the same hours on another day are not an overlap; on the same day they are', async () => {
    const { createClient } = await import('../src/index.js')
    const db = (await createClient({ db: ':memory:', schema: CLOCK })) as any
    const sys = db.asSystem()
    await sys.slot.create({ data: { personId: 1, dayId: 1, opensAt: '09:00', shutsAt: '12:00' } })
    await sys.slot.create({ data: { personId: 1, dayId: 2, opensAt: '09:00', shutsAt: '12:00' } })
    await sys.slot.create({ data: { personId: 2, dayId: 1, opensAt: '09:00', shutsAt: '12:00' } })
    const e = await refusal(sys.slot.create({ data: { personId: 1, dayId: 1, opensAt: '11:00', shutsAt: '13:00' } }))
    expect(e?.name).toBe('OverlapConflictError')
    expect(await sys.slot.count()).toBe(3)
    db.$close()
  })

  test('touching ends do not overlap, and 9:00 orders before 10:00 as a time, not as text', async () => {
    const { createClient } = await import('../src/index.js')
    const db = (await createClient({ db: ':memory:', schema: CLOCK })) as any
    const sys = db.asSystem()
    await sys.slot.create({ data: { personId: 1, dayId: 1, opensAt: '09:00', shutsAt: '12:00' } })
    await sys.slot.create({ data: { personId: 1, dayId: 1, opensAt: '12:00', shutsAt: '12:00:30' } })
    const e = await refusal(sys.slot.create({ data: { personId: 1, dayId: 1, opensAt: '12:00:15', shutsAt: '13:00' } }))
    expect(e?.name).toBe('OverlapConflictError')
    db.$close()
  })

  test('an update moving a row to another day is graded under the new key', async () => {
    const { createClient } = await import('../src/index.js')
    const db = (await createClient({ db: ':memory:', schema: CLOCK })) as any
    const sys = db.asSystem()
    await sys.slot.create({ data: { personId: 1, dayId: 1, opensAt: '09:00', shutsAt: '12:00' } })
    const b = await sys.slot.create({ data: { personId: 1, dayId: 2, opensAt: '10:00', shutsAt: '11:00' } })
    const e = await refusal(sys.slot.update({ where: { id: b.id }, data: { dayId: 1 } }))
    expect(e?.name).toBe('OverlapConflictError')
    db.$close()
  })
})
