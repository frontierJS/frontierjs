// test/claim-source.test.ts
//
// `claim siteId from Employee(userId).siteId` through junction's seam: the
// claim is read off the row per REQUEST, merged onto the principal before the
// Data boundary scopes the client, and before the app's own resolver runs.
//
// Against a real Litestone client — what is being proved is that a predicate
// compiled from the schema filters on a value this seam put on the principal a
// moment earlier, and a stub agrees with whatever it was written to agree with.

import { describe, test, expect } from 'bun:test'

import { createClient } from '../../litestone/src/index.js'
import { createApp, createService } from '../index.ts'
import type { PrincipalResolver } from '../index.ts'
import type { SessionContext } from '../src/auth/types.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

const rowsOf = (r: unknown): any[] => (r as { data: any[] }).data

const SCHEMA = `
  claim employeeId from Employee(userId)
  claim siteId     from Employee(userId).siteId

  model User { id String @id  @@auth }

  model Employee {
    id     Int    @id @default(autoincrement())
    userId String @unique
    user   User   @relation(fields: [userId], references: [id])
    siteId Int
  }

  model Shift {
    id     Int    @id @default(autoincrement())
    siteId Int
    note   String
    @@allow('read', siteId == auth().siteId)
  }
`

async function seeded() {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  const sys = db.asSystem()
  await sys.user.create({ data: { id: 'u1' } })
  await sys.user.create({ data: { id: 'u2' } })
  await sys.employee.create({ data: { userId: 'u1', siteId: 7 } })
  await sys.shift.create({ data: { siteId: 7, note: 'site seven' } })
  await sys.shift.create({ data: { siteId: 9, note: 'site nine' } })
  return db
}

async function appWith(db: unknown, principal?: PrincipalResolver) {
  const seen: { user?: any } = {}
  const app = createApp({ db, principal })
  app.services.register(createService({
    name: 'shifts',
    async find(ctx: ServiceContext) {
      seen.user = ctx.auth.user
      return (ctx.locals.db as any).shift.findMany({})
    },
  }))
  return { app, seen }
}

// A session carries its id as `userId`, which is junction's shape; the lookup
// must reach it through toDataPrincipal like every other policy read.
const as = (userId: string) => ({ auth: { user: { userId } as unknown as SessionContext } })
const notes = async (app: any, userId: string) => rowsOf(await app.service('shifts').find({}, as(userId))).map(r => r.note)

describe('a claim the schema reads off a row', () => {
  test('reaches the SQL with no resolver written', async () => {
    const { app } = await appWith(await seeded())
    expect(await notes(app, 'u1')).toEqual(['site seven'])
  })

  test('a caller with no row sees nothing, and is not refused', async () => {
    // A signed-in customer who is not an employee is a legitimate caller.
    const { app } = await appWith(await seeded())
    expect(await notes(app, 'u2')).toEqual([])
  })

  test('is on ctx.auth.user, where a service and the gate read it', async () => {
    const { app, seen } = await appWith(await seeded())
    await app.service('shifts').find({}, as('u1'))
    expect(seen.user.employeeId).toBe(1)
    expect(seen.user.siteId).toBe(7)
  })

  test('is read per REQUEST — the row moving moves the next call', async () => {
    const db = await seeded()
    const { app } = await appWith(db)
    expect(await notes(app, 'u1')).toEqual(['site seven'])
    await db.asSystem().employee.update({ where: { userId: 'u1' }, data: { siteId: 9 } })
    expect(await notes(app, 'u1')).toEqual(['site nine'])
  })

  test('a guest is looked up by nothing', async () => {
    const { app } = await appWith(await seeded())
    expect(rowsOf(await app.service('shifts').find({}, { auth: { user: null } } as any))).toEqual([])
  })
})

describe("beside the app's own resolver", () => {
  test('the resolver is handed a principal already carrying it', async () => {
    let handed: any
    const { app } = await appWith(await seeded(), async (_ctx, user) => { handed = user; return { shiftLead: true } })
    await app.service('shifts').find({}, as('u1'))
    expect(handed.siteId).toBe(7)
  })

  test('a resolver answering a claim the schema reads off a row is refused by name', async () => {
    const { app } = await appWith(await seeded(), async () => ({ siteId: 9 }))
    await expect(app.service('shifts').find({}, as('u1'))).rejects.toThrow(/answered 'siteId', which the schema reads off Employee/)
  })

  test('…and one answering anything else is merged', async () => {
    const { app, seen } = await appWith(await seeded(), async () => ({ shiftLead: true }))
    expect(await notes(app, 'u1')).toEqual(['site seven'])
    expect(seen.user.shiftLead).toBe(true)
  })
})
