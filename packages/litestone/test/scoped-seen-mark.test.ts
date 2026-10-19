// FJS-2006 — a per-viewer "seen" mark is `@scoped`: a row keyed by (viewer, row)
// that a list filters and counts by and that goes with either side.
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { createClient } from '../src/core/client.js'

const SCHEMA = `
model User { id Int @id; name String; @@auth }
model Message { id Int @id; body String; readAt DateTime? @scoped }`

describe('FJS-2006 — a seen mark per viewer', () => {
  let db: any, a: any, b: any, m: any[]
  beforeEach(async () => {
    db = await createClient({ schema: SCHEMA, db: ':memory:' })
    a = await db.user.create({ data: { name: 'Ann' } })
    b = await db.user.create({ data: { name: 'Bob' } })
    m = []
    for (const t of ['one', 'two', 'three']) m.push(await db.message.create({ data: { body: t } }))
  })
  afterEach(() => db.$close())

  test('opening marks it read for the opener only', async () => {
    const at = new Date().toISOString()
    await db.$setAuth(a).message.update({ where: { id: m[0].id }, data: { mine: { readAt: at } } })
    expect((await db.$setAuth(a).message.findFirst({ where: { id: m[0].id } })).mine.readAt).toBe(at)
    expect((await db.$setAuth(b).message.findFirst({ where: { id: m[0].id } })).mine.readAt).toBeNull()
  })

  test('a list filters and counts unread per viewer', async () => {
    await db.$setAuth(a).message.update({ where: { id: m[0].id }, data: { mine: { readAt: new Date().toISOString() } } })
    const unreadA = await db.$setAuth(a).message.findMany({ where: { mine: { readAt: null } } })
    expect(unreadA.map((r: any) => r.body).sort()).toEqual(['three', 'two'])
    expect(await db.$setAuth(a).message.count({ where: { mine: { readAt: null } } })).toBe(2)
    expect(await db.$setAuth(b).message.count({ where: { mine: { readAt: null } } })).toBe(3)
    expect(await db.$setAuth(a).message.count({ where: { mine: { readAt: { not: null } } } })).toBe(1)
  })

  test('deleting the row clears its marks; deleting the viewer clears theirs', async () => {
    const at = new Date().toISOString()
    for (const v of [a, b]) await db.$setAuth(v).message.update({ where: { id: m[0].id }, data: { mine: { readAt: at } } })
    const marks = () => db.$db.query('SELECT * FROM _message_user').all()
    expect(marks().length).toBe(2)
    await db.user.delete({ where: { id: b.id } })
    expect(marks().map((r: any) => r.userId)).toEqual([a.id])
    await db.message.delete({ where: { id: m[0].id } })
    expect(marks()).toEqual([])
  })

  test('a filter on a non-null default agrees with the read of an unmarked row', async () => {
    const d = await createClient({
      schema: `model User { id Int @id; @@auth }
model Doc { id Int @id; pinned Boolean @scoped @default(false); rank Int @scoped @default(5) }`,
      db: ':memory:',
    }) as any
    const u = await d.user.create({ data: {} })
    for (let i = 0; i < 3; i++) await d.doc.create({ data: {} })
    const me = d.$setAuth(u)
    await me.doc.update({ where: { id: 1 }, data: { mine: { pinned: true, rank: 9 } } })
    expect((await me.doc.findMany({ where: { mine: { pinned: false } } })).map((r: any) => r.id).sort()).toEqual([2, 3])
    expect((await me.doc.findMany({ where: { mine: { pinned: true } } })).map((r: any) => r.id)).toEqual([1])
    expect(await me.doc.count({ where: { mine: { rank: { gte: 5 } } } })).toBe(3)
    expect(await me.doc.count({ where: { mine: { rank: { in: [9] }, pinned: true } } })).toBe(1)
    expect(await me.doc.count({ where: { mine: { rank: { gt: 5 }, pinned: false } } })).toBe(0)
    d.$close()
  })
})
