// test/cron-validator.test.ts
//
// FJS-D1285: a recurring wall-clock rule is a ROW — `rule String @cron` beside
// a `@zone` column — and Caravan binds one schedule per row. `@cron` is a pure
// validator: it refuses at write the expression Caravan's clock would refuse at
// bind, through the grammar's one owner (`@frontierjs/toolbelt/cron`), and
// knows nothing of Caravan.

import { describe, test, expect } from 'bun:test'
import { parse } from '../src/core/parser.js'

const SCHEMA = `
model Window {
  id       Int     @id
  name     String
  rule     String  @cron
  timeZone String  @zone @default("UTC")
}
`

const refusal = (p: Promise<any>) => p.then(() => null, (e: any) => e)

async function client(schema = SCHEMA) {
  const { createClient } = await import('../src/index.js')
  return ((await createClient({ db: ':memory:', schema })) as any).asSystem()
}

describe('@cron (FJS-D1285)', () => {
  test('parses on a String and is refused on any other type', () => {
    expect(parse(SCHEMA).errors).toEqual([])
    expect(parse(SCHEMA.replace('rule     String  @cron', 'rule     Int  @cron')).errors.join('\n'))
      .toContain('@cron requires a String field')
  })

  test('a well-formed expression stores, Lisbon’s Sunday 01:30 included', async () => {
    const sys = await client()
    const row = await sys.window.create({ data: { name: 'maint', rule: '30 1 * * 0', timeZone: 'Europe/Lisbon' } })
    expect(row.rule).toBe('30 1 * * 0')
    expect((await sys.window.create({ data: { name: 'weekday', rule: '0 3 * * MON-FRI' } })).rule).toBe('0 3 * * MON-FRI')
  })

  test('a malformed expression or an out-of-range field is refused at write, naming the field', async () => {
    const sys = await client()
    for (const [rule, says] of [
      ['banana',      'expected 5 fields'],
      ['61 * * * *',  'minute value is 61'],
      ['0 25 * * *',  'hour value is 25'],
      ['0 0 30 2 *',  'never occurs'],
    ]) {
      const err = await refusal(sys.window.create({ data: { name: 'x', rule } }))
      expect(err?.name).toBe('ValidationError')
      expect(JSON.stringify(err.errors)).toContain('rule')
      expect(JSON.stringify(err.errors)).toContain(says)
    }
    const row = await sys.window.create({ data: { name: 'ok', rule: '0 3 * * *' } })
    expect(await refusal(sys.window.update({ where: { id: row.id }, data: { rule: '*/0 * * * *' } }))).not.toBeNull()
  })

  test('a custom message replaces the sentence', async () => {
    const sys = await client(SCHEMA.replace('@cron', '@cron("not a schedule")'))
    const err = await refusal(sys.window.create({ data: { name: 'x', rule: 'nope' } }))
    expect(JSON.stringify(err.errors)).toContain('not a schedule')
  })
})
