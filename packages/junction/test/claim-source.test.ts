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
import type { ServiceContext } from '../src/core/context.ts'
import { $ } from '../index.ts'

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
    @@allow(read, siteId == auth().siteId)
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
      seen.user = ctx.user
      return ($.db as any).shift.findMany({})
    },
  }))
  return { app, seen }
}

// A session carries its id as `id`; the lookup
// must reach it through toDataPrincipal like every other policy read.
const as = (id: string) => ({ user: { id } as unknown as SessionContext })
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

  test('is on ctx.user, where a service and the gate read it', async () => {
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
    expect(rowsOf(await app.service('shifts').find({}, { user: null } as any))).toEqual([])
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

// ─── the wire (FJS-3728) ─────────────────────────────────────────────────────
//
// A broadcast has no request, so the same declaration is read per recipient
// when the frame is graded: no `channels({ claims })` resolver restates it.

describe('a claim the schema reads off a row, on a broadcast', () => {
  test('the employee at the site hears the write and a stranger to it does not', async () => {
    const { createChannelManager } = await import('../src/transport/channels.ts')
    const { setCallDb }            = await import('../src/core/context.ts')
    const db      = await seeded()
    const manager = createChannelManager()
    const listen  = (id: string) => {
      const frames: string[] = []
      const conn = { id, user: { id }, data: {}, socket: { send: (d: string) => { frames.push(d); return 1 }, close() {}, readyState: 1 } }
      manager.channel('shifts').join(conn as never)
      return frames
    }
    const u1 = listen('u1')
    const u2 = listen('u2')

    const ctx = setCallDb({ service: 'shifts', locals: {}, app: {} } as unknown as ServiceContext, db)
    await manager.announce('shifts created', { id: 1, siteId: 7, note: 'site seven' }, ctx, () => [manager.channel('shifts')])

    expect(u1.map(f => JSON.parse(f).event)).toContain('shifts created')
    expect(u2.map(f => JSON.parse(f).event)).not.toContain('shifts created')
  })
})

// ─── the app's resolver, on a broadcast (FJS-4395) ───────────────────────────
//
// A field only `createApp({ principal })` supplies is what a private channel's
// policy reads on Workbench Messages. Its rows answered a member's fetch and
// never reached the member's socket, until the app restated the resolver in
// `channels({ claims })`.

const PRIVATE = `
  claim profile

  model User { id String @id  @@auth }

  model Member {
    id      Int    @id @default(autoincrement())
    userId  String @unique
    profile String
  }

  model Post {
    id      Int    @id @default(autoincrement())
    profile String
    body    String
    @@allow(read, profile == auth().profile)
  }
`

describe("a claim the app's resolver answers, on a broadcast", () => {
  async function privateApp() {
    const { channels } = await import('../src/transport/channels.ts')
    const { setCallDb } = await import('../src/core/context.ts')
    const db: any = await createClient({ db: ':memory:', schema: PRIVATE })
    const sys = db.asSystem()
    await sys.user.create({ data: { id: 'u1' } })
    await sys.user.create({ data: { id: 'u2' } })
    await sys.member.create({ data: { userId: 'u1', profile: 'p-1' } })
    await sys.member.create({ data: { userId: 'u2', profile: 'p-2' } })
    await sys.post.create({ data: { profile: 'p-1', body: 'for p-1' } })
    const profileOf: PrincipalResolver = async function profileOf (_ctx, user) {
      if (!user) return {}
      const row = await ($.db as any).asSystem().member.findFirst({ where: { userId: String(user.id) } })
      return row ? { profile: row.profile } : {}
    }
    const app: any = createApp({ db, principal: profileOf })
    app.services.register(createService({
      name: 'posts',
      model: 'Post',
      async find() { return ($.db as any).post.findMany({}) },
    }))
    app.configure(channels())
    const listen = (id: string) => {
      const frames: string[] = []
      const conn = { id, user: { id }, data: {}, socket: { send: (d: string) => { frames.push(d); return 1 }, close() {}, readyState: 1 } }
      app.channels.channel('posts').join(conn as never)
      return () => frames.map(f => JSON.parse(f)).filter(f => f.event === 'posts created').map(f => f.data.body)
    }
    const ctx = setCallDb({ service: 'posts', locals: {}, app } as unknown as ServiceContext, db)
    return { app, db, listen, ctx }
  }

  test('a fetch and the socket agree: the member hears it, the other member does not', async () => {
    const { app, listen, ctx } = await privateApp()
    const u1 = listen('u1')
    const u2 = listen('u2')

    expect(rowsOf(await app.service('posts').find({}, as('u1'))).map((r: any) => r.body)).toEqual(['for p-1'])
    await app.channels.announce('posts created', { id: 1, profile: 'p-1', body: 'for p-1' }, ctx, () => [app.channels.channel('posts')])

    expect(u1()).toEqual(['for p-1'])
    expect(u2()).toEqual([])
  })

  test('a write outside any service call is graded the same way', async () => {
    const { app, db, listen } = await privateApp()
    const u1 = listen('u1')
    const u2 = listen('u2')

    await app.channels.sendGraded('posts', 'posts created', { id: 1, profile: 'p-1', body: 'for p-1' }, { db, accessor: 'post' })

    expect(u1()).toEqual(['for p-1'])
    expect(u2()).toEqual([])
  })
})

// ─── the caller as a filter value (FJS-D1730, FJS-3725) ─────────────────────
//
// An approver inbox is "submitted and not mine": the filter names the caller's
// own Employee id, which the client never holds. `{ $auth: 'employeeId' }` is
// replaced by the caller's claim before Litestone sees the where.

const INBOX = `
  claim employeeId from Employee(userId)

  model User { id String @id  @@auth }

  model Employee {
    id     Int    @id @default(autoincrement())
    userId String @unique
    user   User   @relation(fields: [userId], references: [id])
  }

  model Expense {
    id            Int    @id @default(autoincrement())
    note          String
    status        String
    submittedById Int
    @@allow(read, auth() != null)
  }
`

describe('a filter naming the caller with { $auth }', () => {
  async function inbox() {
    const db: any = await createClient({ db: ':memory:', schema: INBOX })
    const sys = db.asSystem()
    await sys.user.create({ data: { id: 'u1' } })
    await sys.user.create({ data: { id: 'u2' } })
    await sys.user.create({ data: { id: 'u3' } })
    await sys.employee.create({ data: { userId: 'u1' } })
    await sys.employee.create({ data: { userId: 'u2' } })
    await sys.expense.create({ data: { note: 'by one', status: 'submitted', submittedById: 1 } })
    await sys.expense.create({ data: { note: 'by two', status: 'submitted', submittedById: 2 } })
    await sys.expense.create({ data: { note: 'drafted', status: 'draft', submittedById: 2 } })
    const app: any = createApp({ db })
    app.services.register(createService({ name: 'expenses', model: 'Expense' }))
    return app
  }
  const notesFor = async (app: any, query: object, userId: string) =>
    rowsOf(await app.service('expenses').find(query, as(userId))).map((r: any) => r.note).sort()

  test('is the caller\'s claim, under an operator and inside $or', async () => {
    const app = await inbox()
    const notMine = { $or: [{ status: 'submitted', submittedById: { not: { $auth: 'employeeId' } } }] }
    expect(await notesFor(app, notMine, 'u1')).toEqual(['by two'])
    expect(await notesFor(app, notMine, 'u2')).toEqual(['by one'])
  })

  test('as an equality, it is the caller\'s own rows', async () => {
    const app = await inbox()
    expect(await notesFor(app, { submittedById: { $auth: 'employeeId' } }, 'u2')).toEqual(['by two', 'drafted'])
  })

  test('arrives off the wire as a structure, never as text', async () => {
    const { parseQuery: parseQueryString } = await import('../src/transport/body.ts')
    expect(parseQueryString('submittedById[not][$auth]=employeeId'))
      .toEqual({ submittedById: { not: { $auth: 'employeeId' } } })
  })

  test('a claim the caller does not hold is refused by name', async () => {
    const app = await inbox()
    await expect(notesFor(app, { submittedById: { $auth: 'siteId' } }, 'u1')).rejects.toThrow(/'siteId'/)
  })

  test('a caller with no row behind the claim is refused, never matched against NULL', async () => {
    const app = await inbox()
    await expect(notesFor(app, { submittedById: { $auth: 'employeeId' } }, 'u3')).rejects.toThrow(/'employeeId'/)
  })

  test('a guest is refused by name', async () => {
    const app = await inbox()
    await expect(app.service('expenses').find({ submittedById: { $auth: 'employeeId' } }, { user: null } as any))
      .rejects.toThrow(/has no principal/)
  })

  test('a token that is not one name alone is refused', async () => {
    const app = await inbox()
    await expect(notesFor(app, { submittedById: { $auth: 'employeeId', extra: 1 } }, 'u1')).rejects.toThrow(/names one claim/)
    await expect(notesFor(app, { submittedById: { $auth: ['employeeId'] } }, 'u1')).rejects.toThrow(/names one claim/)
  })

  test('a token a hook adds after the claims is refused, not handed to Litestone as an operator', async () => {
    const db: any = await createClient({ db: ':memory:', schema: INBOX })
    await db.asSystem().user.create({ data: { id: 'u1' } })
    const app: any = createApp({ db })
    app.services.register(createService({
      name: 'expenses', model: 'Expense',
      hooks: { before: { find: [(c: ServiceContext) => { c.query = { submittedById: { $auth: 'employeeId' } } }] } },
    } as never))
    await expect(app.service('expenses').find({}, as('u1'))).rejects.toThrow(/reached the query builder unresolved/)
  })
})
