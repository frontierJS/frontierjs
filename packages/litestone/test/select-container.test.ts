// FJS-828 — a `select` that is not an object projected no columns and said so
// nowhere.
//
// `parseSelectArg` walks the value's own entries looking for field names. Given
// `['id', 'title']` it finds the keys `0` and `1`, matches neither, and emits
// `SELECT "_no_cols_"` — so the read succeeded, answered `{}`, and every reader
// downstream saw a row that exists and is empty. The object form has refused an
// unknown column BY NAME since FJS-601; the wrong CONTAINER walked past that
// check entirely, and so did every `create`, which is in neither wrapper list.
//
// A list IS accepted since FJS-D2332, as the object spelled shorter: toolbelt's
// `parseSelectPaths` turns it into that object before any check, so an unknown
// name in a list is refused by the object form's own check.
//
// Every refusal below is asserted BESIDE the object one character away that
// still answers, because a check that refused both containers is
// indistinguishable from one that works when only the refusal is asked about
// (FJS-351).

import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'

const SCHEMA = `
model Note {
  id    Int    @id @default(autoincrement())
  title String
  body  String
  @@fts([title, body])
  @@label(title)
}
`

const open = async () => {
  const db: any = await createClient({ db: ':memory:', schema: SCHEMA })
  await db.note.create({ data: { title: 'alpha', body: 'x' } })
  await db.note.create({ data: { title: 'beta',  body: 'y' } })
  return db
}

const refusal = async (fn: () => Promise<unknown>) => {
  try { await fn(); return null }
  catch (e: any) { return String(e.message) }
}

describe('FJS-828 — the select container', () => {
  it('an object still projects the columns it names', async () => {
    const db = await open()
    expect(await db.note.findFirst({ select: { id: true, title: true } }))
      .toEqual({ id: 1, title: 'alpha' })
    db.$close()
  })

  it('an absent select still answers the whole row', async () => {
    const db = await open()
    expect(await db.note.findFirst()).toEqual({ id: 1, title: 'alpha', body: 'x' })
    db.$close()
  })

  it('a string, a number and `true` are refused the same way', async () => {
    const db = await open()
    for (const bad of ['id', 5, true]) {
      expect(await refusal(() => db.note.findFirst({ select: bad }))).toContain('must be an object or a list')
    }
    expect(await refusal(() => db.note.findFirst({ select: [5] }))).toContain('as strings')
    db.$close()
  })

  // The verbs are wrapped in three different places — the read list, the write
  // list, and `create`'s own wrapper — so one covered verb says nothing about
  // the next.
  it('every verb that shapes a row refuses a bad container, and takes a list', async () => {
    const db = await open()
    const bad: Record<string, () => Promise<unknown>> = {
      findMany:   () => db.note.findMany({ select: 'id' }),
      findUnique: () => db.note.findUnique({ where: { id: 1 }, select: 'id' }),
      search:     () => db.note.search('alpha', { select: 'id' }),
      create:     () => db.note.create({ data: { title: 'c', body: 'z' }, select: 'id' }),
      update:     () => db.note.update({ where: { id: 1 }, data: { title: 'd' }, select: 'id' }),
    }
    for (const [verb, run] of Object.entries(bad)) {
      expect(await refusal(run), verb).toContain('must be an object')
    }
    expect(await db.note.findMany({ select: ['id'] })).toEqual([{ id: 1 }, { id: 2 }])
    expect(await db.note.findUnique({ where: { id: 1 }, select: ['id'] })).toEqual({ id: 1 })
    expect(await db.note.search('alpha', { select: ['id'], withRank: false })).toEqual([{ id: 1 }])
    expect(await db.note.create({ data: { title: 'c', body: 'z' }, select: ['id'] })).toEqual({ id: 3 })
    expect(await db.note.update({ where: { id: 1 }, data: { title: 'd' }, select: ['title'] })).toEqual({ title: 'd' })
    expect(await refusal(() => db.note.search('alpha', { select: ['nope'] }))).toContain(`Unknown field 'nope'`)
    expect(await refusal(() => db.note.create({ data: { title: 'e', body: 'z' }, select: ['nope'] })))
      .toContain(`Unknown field 'nope'`)
    db.$close()
  })

  // `search` reached none of this: it validated neither the container nor the
  // keys, so FJS-601's refusal covered every read but that one.
  it('search refuses an unknown column by name too', async () => {
    const db = await open()
    expect(await refusal(() => db.note.search('alpha', { select: { nope: true } })))
      .toContain(`Unknown field 'nope'`)
    expect(await db.note.search('alpha', { select: { id: true }, withRank: false })).toEqual([{ id: 1 }])
    db.$close()
  })

  // create is in neither wrapper list, so it had never had either half.
  it('create refuses an unknown column by name too', async () => {
    const db = await open()
    expect(await refusal(() => db.note.create({ data: { title: 'c', body: 'z' }, select: { nope: true } })))
      .toContain(`Unknown field 'nope'`)
    expect(await db.note.create({ data: { title: 'd', body: 'z' }, select: { id: true } }))
      .toEqual({ id: 3 })   // 3, not 4 — the refused create above never wrote
    db.$close()
  })

  // `select: false` is the documented write spelling for *do not hand me the
  // row*, and it is the one non-object that stays legal. On a READ it means
  // nothing — it answered the whole row through the `!select` fast path, which
  // is the same silent wrong answer one value over.
  it('select: false is a write spelling and is refused on a read', async () => {
    const db = await open()
    expect(await db.note.create({ data: { title: 'e', body: 'z' }, select: false })).toBe(null)
    expect(await db.note.update({ where: { id: 1 }, data: { title: 'f' }, select: false })).toBe(null)
    const msg = await refusal(() => db.note.findFirst({ select: false }))
    expect(msg).toContain('must be an object')
    db.$close()
  })

  it('the write refusal names select: false and the read refusal does not', async () => {
    const db = await open()
    expect(await refusal(() => db.note.update({ where: { id: 1 }, data: {}, select: 'id' })))
      .toContain('select: false')
    expect(await refusal(() => db.note.findMany({ select: 'id' })))
      .not.toContain('select: false')
    db.$close()
  })
})

// FJS-D2332 — the list is the object spelled shorter, so each list below is
// read beside the object it stands for, and the two must answer the same rows.
describe('FJS-D2332 — a select list', () => {
  const PATHS = `
model Event {
  id    Int    @id @default(autoincrement())
  title String
  types TicketType[]
}
model TicketType {
  id      Int    @id @default(autoincrement())
  name    String
  eventId Int
  event   Event  @relation(fields: [eventId], references: [id])
  tickets Ticket[]
}
model Member {
  id      Int    @id @default(autoincrement())
  name    String
  email   String
  tickets Ticket[]
}
model Ticket {
  id           Int        @id @default(autoincrement())
  code         String
  memberId     Int
  member       Member     @relation(fields: [memberId], references: [id])
  ticketTypeId Int
  ticketType   TicketType @relation(fields: [ticketTypeId], references: [id])
}
`
  const openPaths = async () => {
    const db: any = await createClient({ db: ':memory:', schema: PATHS })
    await db.event.create({ data: { title: 'Gala' } })
    await db.ticketType.create({ data: { name: 'VIP', eventId: 1 } })
    await db.member.create({ data: { name: 'Ann', email: 'ann@x.test' } })
    await db.ticket.create({ data: { code: 'T1', memberId: 1, ticketTypeId: 1 } })
    await db.ticket.create({ data: { code: 'T2', memberId: 1, ticketTypeId: 1 } })
    return db
  }

  const same = async (db: any, model: string, list: string[], object: Record<string, unknown>) => {
    const fromList   = await db[model].findMany({ select: list })
    const fromObject = await db[model].findMany({ select: object })
    expect(fromList).toEqual(fromObject)
    return fromList
  }

  it('a column list answers what the object answers', async () => {
    const db = await openPaths()
    expect(await same(db, 'ticket', ['id', 'code'], { id: true, code: true }))
      .toEqual([{ id: 1, code: 'T1' }, { id: 2, code: 'T2' }])
    db.$close()
  })

  it('a one-hop path is the relation\'s select', async () => {
    const db = await openPaths()
    const rows = await same(db, 'ticket', ['code', 'member:name'],
      { code: true, member: { select: { name: true } } })
    expect(rows[0]).toEqual({ code: 'T1', member: { name: 'Ann' } })
    db.$close()
  })

  it('a three-hop path nests select at every hop, so the middle hops answer only the path', async () => {
    const db = await openPaths()
    const rows = await same(db, 'member', ['id', 'tickets.ticketType.event:title'],
      { id: true, tickets: { select: { ticketType: { select: { event: { select: { title: true } } } } } } })
    expect(rows).toEqual([{ id: 1, tickets: [
      { ticketType: { event: { title: 'Gala' } } },
      { ticketType: { event: { title: 'Gala' } } },
    ] }])
    db.$close()
  })

  it('entries sharing a prefix merge onto one relation', async () => {
    const db = await openPaths()
    const rows = await same(db, 'ticket', ['member:name', 'member:email', 'ticketType.event:title'],
      { member: { select: { name: true, email: true } }, ticketType: { select: { event: { select: { title: true } } } } })
    expect(rows[0]).toEqual({ member: { name: 'Ann', email: 'ann@x.test' }, ticketType: { event: { title: 'Gala' } } })
    db.$close()
  })

  it('an unknown column and an unknown path segment are each refused by name', async () => {
    const db = await openPaths()
    expect(await refusal(() => db.ticket.findMany({ select: ['id', 'cdoe'] })))
      .toContain(`Unknown field 'cdoe'`)
    expect(await refusal(() => db.member.findMany({ select: ['tickets.tikcetType.event:title'] })))
      .toContain(`Unknown field 'tikcetType' in select for Ticket`)
    expect(await refusal(() => db.ticket.findMany({ select: ['member:nmae'] })))
      .toContain(`Unknown field 'nmae' in select for Member`)
    expect(await refusal(() => db.ticket.findMany({ select: ['code.x:y'] })))
      .toContain(`'code' on Ticket.findMany is not a relation`)
    // the object one hop down was the same silent empty row, and is refused too
    expect(await refusal(() => db.ticket.findMany({ select: { member: { select: { nmae: true } } } })))
      .toContain(`Unknown field 'nmae' in select for Member`)
    expect(await refusal(() => db.ticket.findMany({ select: { code: { select: { x: true } } } })))
      .toContain(`'code' on Ticket.findMany is not a relation`)
    db.$close()
  })

  it('a list inside an include is read the same way', async () => {
    const db = await openPaths()
    expect(await db.member.findFirst({ include: { tickets: { select: ['code', 'ticketType:name'] } } }))
      .toEqual({ id: 1, name: 'Ann', email: 'ann@x.test', tickets: [
        { code: 'T1', ticketType: { name: 'VIP' } }, { code: 'T2', ticketType: { name: 'VIP' } },
      ] })
    db.$close()
  })
})
