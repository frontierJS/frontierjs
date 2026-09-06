// tests/relation-filter-validation.test.ts
//
// `?customer[is][nope]=1` answered **500 `no such column: t.nope`**, while the
// same typo one level up answered 400 naming the field and suggesting the right
// one (`FJS-776`, `adapter-8` of `FJS-708`).
//
// The key `customer` is a real relation, so it passed the filter check and the
// object under it was never graded — the check was one level deep. The inner
// name then reached SQL as an identifier. It is quoted and not injectable, but
// **a caller-supplied name entered a SQL pattern**, which is Invariant 8's
// class and exactly what the top-level check exists to prevent.
//
// Two properties are asserted here and neither is visible from the other side:
//
//   THE STATUS   — 400 rather than 500, at every depth, for a bad column AND
//                  for a bad relation OPERATOR, which the compiler threw a bare
//                  `Error` for.
//
//   THE SENTENCE — which is where the first version of this fix was still
//                  wrong. `allowed` is the TARGET model's column list, so a
//                  message saying *filterable fields on orders* while listing
//                  Customer's sends the reader to the wrong schema. The path
//                  and the model travel with the problem now.
//
// Every refusal is PAIRED with the same filter one character different, because
// a check that refused every relation filter would satisfy a test that only
// asked about the broken one (`FJS-351`).

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp }     from '../src/core/app.ts'
import { createService } from '../src/core/service.ts'
import { createClient }  from '../../litestone/src/index.js'
import { request }       from '../src/testing/index.ts'

const SCHEMA = `
  database main { path ":memory:" }

  model Customer {
    id    Int    @id @default(autoincrement())
    name  String
    tier  String @default("std")
    orders Order[]
    @@db(main)
  }

  model Order {
    id         Int      @id @default(autoincrement())
    reference  String
    customerId Int
    customer   Customer @relation(fields: [customerId], references: [id])
    @@db(main)
  }
`

let app: any

beforeAll(async () => {
  const db: any = await createClient({ schema: SCHEMA, db: ':memory:' })
  await db.customer.create({ data: { name: 'Robin' } })
  await db.order.create({ data: { reference: 'A-1', customerId: 1 } })

  app = createApp({
    db: db as never,
    config: { port: 0, database: { url: '', log: false }, services: { dir: '/nonexistent' } },
  })
  app.services.register(createService({ name: 'orders',    model: 'Order' } as never))
  app.services.register(createService({ name: 'customers', model: 'Customer' } as never))
})

const get = async (qs: string) => {
  const res = await request(app).get(`/orders?${qs}`)
  return { status: res.status, body: res.body as any }
}

describe('a filter through a relation is graded', () => {
  test('the control: a real column on the target still works', async () => {
    const ok = await get('customer[is][name]=Robin')
    expect(ok.status).toBe(200)
    expect(ok.body.data).toHaveLength(1)

    // …and actually filters, or a check that let everything through would pass
    // the row above too.
    const none = await get('customer[is][name]=Nobody')
    expect(none.status).toBe(200)
    expect(none.body.data).toHaveLength(0)
  })

  test('a bad column through a relation is 400, not 500', async () => {
    const { status, body } = await get('customer[is][nope]=1')
    expect(status).toBe(400)
    // The SQL fragment is what it used to answer with.
    expect(JSON.stringify(body)).not.toContain('no such column')
  })

  test('the message names the PATH and the model that owns the columns', async () => {
    const { body } = await get('customer[is][nope]=1')
    expect(body.message).toContain('customer.is.nope')
    // `allowed` is Customer's columns, so the sentence must say Customer.
    expect(body.message).toContain('Customer')
    expect(body.message).toContain('tier')
    // The suggestion still works at depth.
    expect(body.message).toContain('name')
  })

  test('a bad relation OPERATOR is 400 too — the compiler threw a bare Error', async () => {
    const { status, body } = await get('customer[nope][id]=1')
    expect(status).toBe(400)
    expect(body.message).toContain('customer.nope')
    // It lists the operators, which is the answer, not Customer's columns.
    for (const mode of ['is', 'isNot', 'some', 'every', 'none'])
      expect(body.message).toContain(mode)
  })

  test('every bad key in one request, not one per round trip', async () => {
    const { body } = await get('customer[is][nope]=1&customer[is][alsoNope]=2')
    expect(body.message).toContain('nope')
    expect(body.message).toContain('alsoNope')
  })

  test('a top-level typo is unchanged — the fix did not move the existing case', async () => {
    const { status, body } = await get('nope=1')
    expect(status).toBe(400)
    expect(body.message).toContain('nope')
    expect(body.message).toContain('reference')
  })

  test('$populate naming nothing is 400 too', async () => {
    // The other half of the finding, and a different mechanism: the include
    // expander threw a bare `Error`, which reaches a caller as a 500 quoting a
    // name the caller supplied.
    const { status, body } = await get('$populate=nope')
    expect(status).toBe(400)
    expect(body.message).toContain('nope')
    expect(body.message).toContain('customer')   // …and says what IS a relation

    // The pair: a real one still populates.
    const ok = await get('$populate=customer')
    expect(ok.status).toBe(200)
    expect(ok.body.data[0].customer.name).toBe('Robin')
  })

  test('a nested object under an ORDINARY column is not descended into', async () => {
    // A typed-Json path is an object under a non-relation key, and a name in it
    // means something else entirely. Grading it against the model's columns
    // would refuse valid queries — so `customer` descends and `reference` must
    // not, and the pair is what says the walk is keyed on the relation map
    // rather than on "the value is an object".
    const { status } = await get('reference[startsWith]=A')
    expect(status).toBe(200)
  })
})
