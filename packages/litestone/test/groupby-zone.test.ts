// groupBy's interval, cut on a time zone's wall clock (DL S3), and the two
// defects in its gap fill that turned up beside it.
//
// A month is a place's month. An order at 23:30 UTC on 31 January is a
// February order in Tokyo and a January one in New York, and a revenue report
// cut in UTC answers neither. `timeZone` states the zone, and since SQLite has
// no zone database it is stated to SQLite as the fixed offsets the zone keeps
// over the rows read (toolbelt's offsetSpans), one CASE arm per change.
//
// FJS-1650: the gap fill wrote its bounds into the statement as
// date('${start}'), so a bound could close the quote and read any table one
// bit per call, over the aggregate verb. And its NOT IN compared labels with
// raw instants, so every interval with data came back twice.

import { describe, it, expect } from 'bun:test'
import { createClient, ValidationError } from '../src/index.js'

const SCHEMA = `
model Order {
  id       Int      @id
  placedAt DateTime
  amount   Int
}
model Secret {
  id    Int    @id
  value String
  @@gate("8.8.8.8")
}
`

async function seeded(rows: [number, string, number][]) {
  const db  = await createClient({ schema: SCHEMA, db: ':memory:' }) as any
  const sys = db.asSystem()
  for (const [id, placedAt, amount] of rows) await sys.order.create({ data: { id, placedAt, amount } })
  await sys.secret.create({ data: { id: 1, value: 'TOP-SECRET' } })
  return db
}

const months = (rows: any[]) => Object.fromEntries(rows.map(r => [r.placedAt, r._count]))

describe('groupBy interval with a timeZone', () => {
  const ROWS: [number, string, number][] = [
    [1, '2024-01-31T23:30:00.000Z', 10],   // Feb in Tokyo, Jan in New York and UTC
    [2, '2024-02-01T03:00:00.000Z', 20],   // Feb in Tokyo and UTC, Jan 31 22:00 in New York
    [3, '2024-02-15T12:00:00.000Z', 30],   // Feb everywhere
  ]

  it('UTC is what it was', async () => {
    const db = await seeded(ROWS)
    expect(months(await db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'month' }, fillGaps: false, _count: true })))
      .toEqual({ '2024-01': 1, '2024-02': 2 })
  })

  it('Tokyo moves the late-January order into February', async () => {
    const db = await seeded(ROWS)
    const got = await db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'month' }, timeZone: 'Asia/Tokyo', fillGaps: false, _count: true, _sum: { amount: true } })
    expect(months(got)).toEqual({ '2024-02': 3 })
    expect(got[0]._sum.amount).toBe(60)
  })

  it('New York moves the early-February order into January', async () => {
    const db = await seeded(ROWS)
    expect(months(await db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'month' }, timeZone: 'America/New_York', fillGaps: false, _count: true })))
      .toEqual({ '2024-01': 2, '2024-02': 1 })
  })

  it('a summer-time change inside the rows is cut on each side at its own offset', async () => {
    // New York leaves EST (-5) for EDT (-4) at 2024-03-10T07:00Z. 04:30Z on the
    // 10th is 23:30 on the 9th; 04:30Z on the 11th is 00:30 on the 11th, which
    // a single -5 offset would put on the 10th.
    const db = await seeded([
      [1, '2024-03-10T04:30:00.000Z', 1],
      [2, '2024-03-11T04:30:00.000Z', 1],
      [3, '2024-11-03T05:30:00.000Z', 1],   // 01:30 EDT, before the fall back at 06:00Z
      [4, '2024-11-04T04:30:00.000Z', 1],   // 23:30 EST on the 3rd
    ])
    expect(months(await db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'day' }, timeZone: 'America/New_York', fillGaps: false, _count: true })))
      .toEqual({ '2024-03-09': 1, '2024-03-11': 1, '2024-11-03': 2 })
  })

  it('fills the zone\'s own months, once each', async () => {
    const db = await seeded(ROWS)
    const got = await db.order.groupBy({
      by: ['placedAt'], interval: { placedAt: 'month' }, timeZone: 'Asia/Tokyo', _count: true,
      fillGaps: { start: '2024-01-01T00:00:00+09:00', end: '2024-03-31T23:59:59+09:00' },
      orderBy: { placedAt: 'asc' },
    })
    expect(got.map((r: any) => [r.placedAt, r._count])).toEqual([['2024-01', 0], ['2024-02', 3], ['2024-03', 0]])
  })

  it('is refused without an interval, and for a zone that is not one', async () => {
    const db = await seeded(ROWS)
    await expect(db.order.groupBy({ by: ['amount'], timeZone: 'Asia/Tokyo', _count: true })).rejects.toThrow(/cuts an interval/)
    await expect(db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'month' }, timeZone: 'Mars/Olympus', _count: true })).rejects.toThrow(ValidationError)
  })
})

describe('the gap fill (FJS-1650)', () => {
  const ROWS: [number, string, number][] = [[1, '2024-01-15T10:00:00.000Z', 5], [2, '2024-03-15T10:00:00.000Z', 7]]

  it('answers each interval once: a gap row only where there is no data', async () => {
    const db = await seeded(ROWS)
    const got = await db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'month' }, where: { placedAt: { gte: '2024-01-01', lte: '2024-03-31' } }, _count: true, orderBy: { placedAt: 'asc' } })
    expect(got.map((r: any) => [r.placedAt, r._count])).toEqual([['2024-01', 1], ['2024-02', 0], ['2024-03', 1]])
  })

  it('a bound that closes the quote is refused, and reads nothing either way', async () => {
    const db = await seeded(ROWS)
    const ask = (ch: string) => db.order.groupBy({
      by: ['placedAt'], interval: { placedAt: 'month' }, _count: true,
      fillGaps: { start: '2024-01-01', end: `2024-03-31') AND (SELECT substr(value,1,1) FROM secret)='${ch}' AND date('2024-03-31` },
    })
    await expect(ask('T')).rejects.toThrow(ValidationError)
    await expect(ask('X')).rejects.toThrow(ValidationError)
  })

  it('a well-formed bound with a time in it still fills', async () => {
    const db = await seeded(ROWS)
    const got = await db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'month' }, _count: true, fillGaps: { start: '2024-01-01T00:00:00Z', end: new Date('2024-03-31T00:00:00Z') } })
    expect(got).toHaveLength(3)
  })
})

describe('the gap fill\'s other two edges', () => {
  it('an hour fill walks hours and ends (it looped for ever on date())', async () => {
    const db = await seeded([[1, '2024-01-01T01:15:00.000Z', 1], [2, '2024-01-01T03:45:00.000Z', 1]])
    const got = await db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'hour' }, _count: true, orderBy: { placedAt: 'asc' },
      fillGaps: { start: '2024-01-01T00:00:00Z', end: '2024-01-01T04:00:00Z' } })
    expect(got.map((r: any) => [r.placedAt, r._count])).toEqual([
      ['2024-01-01T00', 0], ['2024-01-01T01', 1], ['2024-01-01T02', 0], ['2024-01-01T03', 1], ['2024-01-01T04', 0]])
  })

  it('a range of more than 10,000 intervals is refused by name', async () => {
    const db = await seeded([[1, '2024-01-01T01:15:00.000Z', 1]])
    await expect(db.order.groupBy({ by: ['placedAt'], interval: { placedAt: 'hour' }, _count: true,
      fillGaps: { start: '1924-01-01', end: '2024-01-01' } })).rejects.toThrow(/more than 10000 hours/)
  })
})

describe('a SELECT-list value is bound before the WHERE\'s', () => {
  it('_stringAgg beside a where joins the matching rows with the separator', async () => {
    const db  = await createClient({ schema: `model Order {
  id     Int    @id
  status String
  ref    String
}`, db: ':memory:' }) as any
    const sys = db.asSystem()
    for (const [id, status, ref] of [[1, 'paid', 'a'], [2, 'paid', 'b'], [3, 'void', 'c']] as const)
      await sys.order.create({ data: { id, status, ref } })
    const grouped = await db.order.groupBy({ by: ['status'], where: { status: 'paid' }, _stringAgg: { field: 'ref', separator: '|', orderBy: 'ref' } })
    expect(grouped).toEqual([{ status: 'paid', _stringAgg: { ref: 'a|b' } }])
    const whole = await db.order.aggregate({ where: { status: 'paid' }, _stringAgg: { field: 'ref', separator: '|', orderBy: 'ref' } })
    expect(whole._stringAgg).toEqual({ ref: 'a|b' })
  })
})
