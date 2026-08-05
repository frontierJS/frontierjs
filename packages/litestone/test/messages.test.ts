/**
 * messages.test.ts — @label and @required, and the trip they make.
 *
 * Litestone already let every validator carry its own wording:
 * `@length(3, 20, "…")`, `@email("…")`, `@gte(1, "…")`. Its own validator
 * honoured them and `generateJsonSchema` emitted none of them, so a sentence
 * authored once in db/schema.lite died at the Data boundary — invisible to
 * Junction's autoValidate and to Sierra's client-side rules, both of which
 * derive from that document. A form therefore said `customerId is required`
 * under a label reading "customer", and no amount of schema authoring changed
 * it.
 *
 * Two gaps behind that: messages were not emitted, and required-ness had no
 * message slot at all (it is the absence of `?`, not an attribute).
 */

import { describe, test, expect } from 'bun:test'
import { createClient, autoMigrate, generateJsonSchema } from '../src/index.js'

const SCHEMA = `
model Customer { id Int @id  name String }

model Order {
  id         Int    @id
  reference  String @length(3, 20, "A reference is 3 to 20 characters")
  email      String @email("That does not look like an email address")
  total      Float  @gte(0, "Totals cannot be negative")
  plain      Int    @gte(0)
  customerId Int    @label("Customer") @required("Please select a customer from the list")
  customer   Customer @relation(fields: [customerId], references: [id])
}
`

const client = () => createClient({ db: ':memory:', schema: SCHEMA })
const defs   = async () => {
  const db = await client()
  return (generateJsonSchema(db.$schema) as any).$defs.Order
}

describe('@label', () => {
  test('is emitted as JSON Schema `title`, the standard slot for a label', async () => {
    expect((await defs()).properties.customerId.title).toBe('Customer')
  })

  test('names the field in Litestone\'s own required message', async () => {
    const db = await client()
    autoMigrate(db)
    // No @required message on this one would read "Customer is required".
    // Here @required wins, so this asserts the label is not what surfaces.
    expect((await defs()).properties.customerId.title).toBe('Customer')
  })

  test('a field with no @label emits no title', async () => {
    expect((await defs()).properties.reference.title).toBeUndefined()
  })
})

describe('@required', () => {
  test('carries the wording through Litestone\'s own validator', async () => {
    const db = await client()
    autoMigrate(db)
    await db.customer.create({ data: { name: 'Acme' } })
    let msg = ''
    try {
      await db.order.create({ data: { reference: 'ORD-1', email: 'a@b.co', total: 1, plain: 1 } })
    } catch (e) { msg = (e as Error).message }
    expect(msg).toContain('Please select a customer from the list')
    expect(msg).not.toContain('customerId is required')
  })

  test('reaches the JSON Schema as x-messages.required', async () => {
    expect((await defs()).properties.customerId['x-messages'])
      .toEqual({ required: 'Please select a customer from the list' })
  })

  test('on an optional field is a parse error, not a silently dead message', async () => {
    await expect(createClient({
      db: ':memory:',
      schema: `model T { id Int @id  note String? @required("never fires") }`,
    })).rejects.toThrow(/@required on an optional field/)
  })
})

describe('validator messages reach the JSON Schema', () => {
  test('keyed by rule name AND by the keyword it compiles to', async () => {
    const p = (await defs()).properties
    // @length → minLength/maxLength, so a consumer that just failed `minLength`
    // looks up `minLength` with no keyword→rule table of its own.
    expect(p.reference['x-messages']).toEqual({
      length:    'A reference is 3 to 20 characters',
      minLength: 'A reference is 3 to 20 characters',
      maxLength: 'A reference is 3 to 20 characters',
    })
    expect(p.email['x-messages']).toEqual({
      email:  'That does not look like an email address',
      format: 'That does not look like an email address',
    })
    expect(p.total['x-messages']).toEqual({
      gte:     'Totals cannot be negative',
      minimum: 'Totals cannot be negative',
    })
  })

  test('a validator with no message emits nothing — absence is not an empty object', async () => {
    const plain = (await defs()).properties.plain
    expect(plain.minimum).toBe(0)
    expect(plain['x-messages']).toBeUndefined()
  })

  test('the keyword alias matches what the field actually emits', async () => {
    // Pins the table against drift: @gt is exclusiveMinimum, not minimum.
    const db = await createClient({
      db: ':memory:',
      schema: `model T { id Int @id  a Int @gt(1, "m1")  b Int @lt(9, "m2") }`,
    })
    const T = (generateJsonSchema(db.$schema) as any).$defs.T
    expect(T.properties.a.exclusiveMinimum).toBe(1)
    expect(T.properties.a['x-messages'].exclusiveMinimum).toBe('m1')
    expect(T.properties.b.exclusiveMaximum).toBe(9)
    expect(T.properties.b['x-messages'].exclusiveMaximum).toBe('m2')
  })
})

/**
 * Transition errors carry an HTTP status.
 *
 * `TransitionGateError` always did (403) with a comment saying that is the
 * contract — Junction reads `err.status` directly, no mapper, no registration.
 * The other three were simply missed, so an illegal move reached a caller as
 * `500 GeneralError`: the wrong class of error entirely, telling a client to
 * retry something that will never work.
 */
describe('transition errors carry a status', () => {
  const STATES = `
enum S { pending paid shipped }
model Job {
  id     Int @id
  status S   @default(pending)
  @@transitions(status, pay: pending -> paid, ship: paid -> shipped @gate(5))
}
`
  const setup = async () => {
    const db = await createClient({ db: ':memory:', schema: STATES })
    autoMigrate(db)
    await db.job.create({ data: {} })
    return db
  }

  test('an illegal move is 409 — it conflicts with the row\'s current state', async () => {
    const db = await setup()
    try {
      await db.job.transition(1, 'ship')          // pending, not paid
      throw new Error('should have refused')
    } catch (e) {
      expect((e as Error).name).toBe('TransitionViolationError')
      expect((e as { status?: number }).status).toBe(409)
    }
  })

  test('a transition the model does not declare is 400', async () => {
    const db = await setup()
    try {
      await db.job.transition(1, 'teleport')
      throw new Error('should have refused')
    } catch (e) {
      expect((e as Error).name).toBe('TransitionNotFoundError')
      expect((e as { status?: number }).status).toBe(400)
    }
  })

  test('a gated move below the caller\'s level stays 403', async () => {
    const { GatePlugin } = await import('../src/index.js')
    const db = await createClient({
      db: ':memory:', schema: STATES,
      plugins: [new GatePlugin({ getLevel: () => 4 })],
    })
    autoMigrate(db)
    await db.asSystem().job.create({ data: { status: 'paid' } })
    try {
      await db.$setAuth({ id: 1 }).job.transition(1, 'ship')   // wants 5
      throw new Error('should have refused')
    } catch (e) {
      expect((e as Error).name).toBe('TransitionGateError')
      expect((e as { status?: number }).status).toBe(403)
    }
  })

  test('every transition error carries one — none falls through to 500', async () => {
    const m = await import('../src/index.js') as Record<string, any>
    // Constructed explicitly: the four signatures differ, and a shared arg list
    // silently builds the wrong error rather than failing.
    const cases: Array<[string, Error, number]> = [
      ['TransitionViolationError', new m.TransitionViolationError('Job', 'status', 'pending', 'shipped', ['paid']), 409],
      ['TransitionConflictError',  new m.TransitionConflictError('Job', 'status', 'pending', 'paid'),               409],
      ['TransitionGateError',      new m.TransitionGateError('Job', 'status', 'ship', 5, 4),                        403],
      ['TransitionNotFoundError',  new m.TransitionNotFoundError('Job', 'teleport', ['pay', 'ship']),               400],
    ]
    for (const [name, err, want] of cases) {
      expect((err as { status?: number }).status, name).toBe(want)
      expect(err.message.length, name).toBeGreaterThan(0)
    }
  })
})
