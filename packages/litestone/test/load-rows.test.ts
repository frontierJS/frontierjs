// loadRows: data somebody else wrote, read against the schema row by row.
// The invariant under every test: each input row is loaded or rejected, never
// both and never neither, and a reason never quotes the cell.
import { describe, it, expect } from 'bun:test'
import { createClient } from '../src/index.js'
import { loadRows, loadFixture, parseCsv } from '../src/seeder.js'

const schema = `
enum Status { paid pending refunded cancelled }
model Order {
  id         String   @id
  customerId String
  placedAt   DateTime
  status     Status
  currency   String
  amount     Int      @money(field: currency)
  items      Int
  postcode   String?
  note       String   @default("")
}
model Landed {
  id         String   @id
  amount     Int
  _loadId    Int
  _syncedAt  DateTime
}
model Wide {
  id         String   @id
  amount     Int
  _extra     Json?
  _required  Json     @default("{}")
}
`

const HEADER = 'id,customerId,placedAt,status,currency,amount,items,postcode'
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n') + '\n'
const open = async () => (await createClient({ schema, db: ':memory:' })) as any
const accounted = (n: number, out: { loaded: number; rejects: unknown[] }) =>
  expect(out.loaded + out.rejects.length).toBe(n)

describe('loadRows', () => {
  it('reads each cell as its column: exact money by currency, a quoted 0123 as text, a zoned instant as UTC', async () => {
    const db = await open()
    const out = await loadRows(db, 'Order', csv(
      'o1,c03,2025-10-01T05:45:27+02:00,paid,USD,1050.24,2,"0123"',
      'o2,c17,2025-10-01T04:54:29Z,pending,JPY,1050,3,0123',
      'o3,c29,2025-10-02T00:00:00Z,refunded,KWD,8.125,1,',
    ))
    expect(out).toEqual({ loaded: 3, rejects: [] })
    const rows = await db.order.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r.amount)).toEqual([105024, 1050, 8125])
    expect(rows[0].placedAt).toBe('2025-10-01T03:45:27.000Z')
    expect(rows[0].postcode).toBe('0123')
    expect(rows[1].postcode).toBe('0123')
    expect(rows[2].postcode).toBeNull()
    expect(rows[2].note).toBe('')
    db.$close()
  })

  it('sets a bad row aside with its line, column and reason, and loads the rest', async () => {
    const db = await open()
    const out = await loadRows(db, 'Order', csv(
      'o1,c01,2025-10-01T00:00:00Z,paid,USD,10.00,1,1',
      'o2,c01,31/13/2026,paid,USD,10.00,1,1',
      'o3,,2025-10-01T00:00:00Z,paid,USD,10.00,1,1',
      'o4,c01,2025-10-01T00:00:00Z,paid,USD,"1,234.50",1,1',
      'o5,c01,2025-10-01T00:00:00Z,shipped,USD,10.00,1,1',
      'o6,c01,2025-10-01T00:00:00Z,paid,USD,10.00,3.5,1',
      'o7,c01,2025-10-01T00:00:00Z,paid,XYZ,10.00,1,1',
      'o8,c01,2025-10-01T00:00:00Z,paid,USD,10.005,1,1',
    ), { key: 'id' })
    accounted(8, out)
    expect(out.loaded).toBe(1)
    expect(out.rejects.map((r: any) => [r.line, r.key, r.field, r.reason])).toEqual([
      [3, 'o2', 'placedAt', 'not an ISO 8601 date and time'],
      [4, 'o3', 'customerId', 'required, and empty'],
      [5, 'o4', 'amount', 'a number with at most 2 decimal places, without a thousands separator'],
      [6, 'o5', 'status', 'not one of paid, pending, refunded, cancelled'],
      [7, 'o6', 'items', 'not a whole number'],
      [8, 'o7', 'currency', 'not an ISO 4217 currency'],
      [9, 'o8', 'amount', 'more than 2 decimal places'],
    ])
    db.$close()
  })

  it('a key repeated in the source is a reject naming the first line; under upsert it is the newer value', async () => {
    const db = await open()
    const rows = csv(
      'o1,c01,2025-10-01T00:00:00Z,paid,USD,1.00,1,1',
      'o2,c01,2025-10-01T00:00:00Z,paid,USD,2.00,1,1',
      'o1,c01,2025-10-01T00:00:00Z,paid,USD,3.00,1,1',
    )
    const inserted = await loadRows(db, 'Order', rows, { key: 'id' })
    expect(inserted.rejects).toEqual([{ row: 2, line: 4, key: 'o1', field: 'id', reason: 'repeats the key of line 2' }])

    const upserted = await loadRows(db, 'Order', rows, { key: 'id', mode: 'upsert' })
    accounted(3, upserted)
    expect(upserted.rejects).toEqual([])
    expect((await db.order.findFirst({ where: { id: 'o1' } })).amount).toBe(300)
    db.$close()
  })

  it('a refusal only the database makes lands on its row, and the rest of its batch still loads', async () => {
    const db = await open()
    await loadRows(db, 'Order', csv('o1,c01,2025-10-01T00:00:00Z,paid,USD,1.00,1,1'))
    const out = await loadRows(db, 'Order', csv(
      'o2,c01,2025-10-01T00:00:00Z,paid,USD,1.00,1,1',
      'o1,c01,2025-10-01T00:00:00Z,paid,USD,1.00,1,1',
      'o3,c01,2025-10-01T00:00:00Z,paid,USD,1.00,1,1',
    ))
    accounted(3, out)
    expect(out.loaded).toBe(2)
    expect(out.rejects).toHaveLength(1)
    expect(out.rejects[0]).toMatchObject({ line: 3, key: null })
    expect(out.rejects[0].reason).not.toContain('o1')
    expect(await db.order.count()).toBe(3)
    db.$close()
  })

  it('replace swaps every stored row for the source in one transaction', async () => {
    const db = await open()
    await loadRows(db, 'Order', csv('old,c01,2025-10-01T00:00:00Z,paid,USD,1.00,1,1'))
    const out = await loadRows(db, 'Order', csv('new,c01,2025-10-01T00:00:00Z,paid,USD,1.00,1,1'), { mode: 'replace', key: 'id' })
    expect(out.loaded).toBe(1)
    expect((await db.order.findMany()).map((r: any) => r.id)).toEqual(['new'])
    db.$close()
  })

  it('a dry run answers exactly what would land, and lands nothing', async () => {
    const db = await open()
    const out = await loadRows(db, 'Order', csv(
      'o1,c01,2025-10-01T00:00:00Z,paid,USD,1.00,1,1',
      'o2,c01,yesterday,paid,USD,1.00,1,1',
    ), { dryRun: true })
    expect(out.loaded).toBe(1)
    expect(out.rejects).toHaveLength(1)
    expect(await db.order.count()).toBe(0)
    db.$close()
  })

  it('a typed record passes through: a REST page loads beside a file', async () => {
    const db = await open()
    const out = await loadRows(db, 'Order', [
      { id: 'r1', customerId: 'c03', placedAt: '2025-10-01T00:00:00Z', status: 'paid', currency: 'USD', amount: 1299, items: 2 },
      { id: 'r2', customerId: 'c03', placedAt: '2025-10-01T00:00:00Z', status: 'paid', currency: 'USD', amount: 'twelve', items: 2 },
    ])
    accounted(2, out)
    expect(out.rejects[0]).toMatchObject({ row: 1, field: 'amount' })
    expect(out.rejects[0].line).toBeUndefined()
    expect((await db.order.findFirst({ where: { id: 'r1' } })).amount).toBe(1299)
    db.$close()
  })

  it('a mapping mistake throws before any row: an unknown column, a required one missing, a computed one named', async () => {
    const db = await open()
    await expect(loadRows(db, 'Order', 'id,colour\no1,red\n')).rejects.toThrow("'colour' is not a column of Order")
    await expect(loadRows(db, 'Order', 'id,customerId\no1,c01\n')).rejects.toThrow('the file has no column for placedAt, status, currency, amount, items')
    await expect(loadRows(db, 'Order', [], { mode: 'upsert' })).rejects.toThrow('needs a key')
    await expect(loadRows(db, 'Nope', [])).rejects.toThrow("'Nope' is not a model")
    expect(await db.order.count()).toBe(0)
    db.$close()
  })

  it('a line number survives a quoted newline', async () => {
    const db = await open()
    const out = await loadRows(db, 'Order', csv(
      'o1,"c\n01",2025-10-01T00:00:00Z,paid,USD,1.00,1,1',
      'o2,c01,bad,paid,USD,1.00,1,1',
    ))
    expect(out.rejects[0].line).toBe(4)
    db.$close()
  })
})

describe('loadRows stamps what the source cannot say', () => {
  it('every loaded row carries the stamp, and a source naming a stamped column is refused', async () => {
    const db = await open()
    const stamp = { _loadId: 7, _syncedAt: '2026-10-03T12:00:00.000Z' }
    const out = await loadRows(db, 'Landed', 'id,amount\na,1\nb,x\n', { stamp })
    expect(out.loaded).toBe(1)
    expect(await db.landed.findFirst({ where: { id: 'a' } })).toMatchObject(stamp)
    await expect(loadRows(db, 'Landed', 'id,amount,_loadId\nc,1,3\n', { stamp })).rejects.toThrow("has a column '_loadId', which this load stamps")
    await expect(loadRows(db, 'Landed', [{ id: 'd', amount: 1, _loadId: 3 }], { stamp })).rejects.toThrow("names '_loadId'")
    await expect(loadRows(db, 'Landed', 'id,amount\ne,1\n')).rejects.toThrow('no column for _loadId, _syncedAt')
    db.$close()
  })
})

// DL L2: the schema is frozen, and a column it does not know is kept rather
// than refused when the load names a place to keep it.
describe('loadRows keeps what no column takes in an overflow column', () => {
  it('a CSV column the model lacks lands per row in the Json column, as text', async () => {
    const db = await open()
    const out = await loadRows(db, 'Wide', 'id,amount,channel,coupon\na,1,web,\nb,2,store,SPRING\n', { overflow: '_extra' })
    expect(out).toEqual({ loaded: 2, rejects: [] })
    const rows = await db.wide.findMany({ orderBy: { id: 'asc' } })
    expect(rows.map((r: any) => r._extra)).toEqual([{ channel: 'web', coupon: null }, { channel: 'store', coupon: 'SPRING' }])
    db.$close()
  })

  it('a record keeps its unknown keys at their JSON types, and a record with none leaves the column empty', async () => {
    const db = await open()
    const out = await loadRows(db, 'Wide', [
      { id: 'a', amount: 1, metadata: { orderId: 'o1' }, livemode: false },
      { id: 'b', amount: 2 },
    ], { overflow: '_extra' })
    expect(out.loaded).toBe(2)
    const rows = await db.wide.findMany({ orderBy: { id: 'asc' } })
    expect(rows[0]._extra).toEqual({ metadata: { orderId: 'o1' }, livemode: false })
    expect(rows[1]._extra).toBeNull()
    db.$close()
  })

  it('a known column is still read against its type: a bad cell beside an extra one is a reject', async () => {
    const db = await open()
    const out = await loadRows(db, 'Wide', 'id,amount,channel\na,x,web\nb,2,web\n', { overflow: '_extra' })
    expect(out.loaded).toBe(1)
    expect(out.rejects).toEqual([{ row: 0, line: 2, key: null, field: 'amount', reason: expect.any(String) }])
    db.$close()
  })

  it('without an overflow column the schema is frozen: an unknown column throws before any row', async () => {
    const db = await open()
    await expect(loadRows(db, 'Wide', 'id,amount,channel\na,1,web\n')).rejects.toThrow("'channel' is not a column of Wide")
    await expect(loadRows(db, 'Wide', [{ id: 'a', amount: 1, channel: 'web' }])).rejects.toThrow("'channel' is not a column of Wide")
    expect(await db.wide.count()).toBe(0)
    db.$close()
  })

  it('the overflow column must be an optional Json column, and a source naming it is refused', async () => {
    const db = await open()
    await expect(loadRows(db, 'Wide', 'id,amount\na,1\n', { overflow: 'nope' })).rejects.toThrow("overflow 'nope' is not a column of Wide")
    await expect(loadRows(db, 'Wide', 'id,amount\na,1\n', { overflow: 'amount' })).rejects.toThrow('must be an optional Json column')
    await expect(loadRows(db, 'Wide', 'id,amount\na,1\n', { overflow: '_required' })).rejects.toThrow('must be an optional Json column')
    await expect(loadRows(db, 'Wide', 'id,amount,_extra\na,1,{}\n', { overflow: '_extra' })).rejects.toThrow("has a column '_extra', which this load fills")
    await expect(loadRows(db, 'Wide', [{ id: 'a', amount: 1, _extra: {} }], { overflow: '_extra' })).rejects.toThrow("names '_extra'")
    db.$close()
  })
})

describe('loadFixture is loadRows that throws', () => {
  it('names every row that did not load, because a fixture is authored', async () => {
    const db = await open()
    const text = 'id,customerId,placedAt,status,currency,amount,items\no1,c01,yesterday,paid,USD,1.00,1\n'
    await expect(loadFixture(db, 'Order', [{ id: 'o1', customerId: 'c01', placedAt: 'yesterday', status: 'paid', currency: 'USD', amount: '1.00', items: '1' }]))
      .rejects.toThrow('row 0 placedAt: not an ISO 8601 date and time')
    expect(parseCsv(text)).toHaveLength(1)
    db.$close()
  })
})

describe('parseCsv', () => {
  it('every cell is text, or null for an empty unquoted one (FJS-1634)', () => {
    expect(parseCsv('a,b,c,d\n1,true,,"0123"\n')[0]).toEqual({ a: '1', b: 'true', c: null, d: '0123' })
    expect(parseCsv('a,b\n0123,""\n')[0]).toEqual({ a: '0123', b: '' })
  })
})
