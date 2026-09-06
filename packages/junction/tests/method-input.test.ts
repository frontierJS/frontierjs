// tests/method-input.test.ts
//
// A custom method declares the payload it accepts.
//
// `autoValidate` derives from a MODEL and covers create/patch on a model
// service. Everything else a service answers — `pay`, `ship`, `prune` — took
// `ctx.data` on trust, which is the largest unguarded surface junction had: the
// interesting operations in an app are exactly the ones that are not CRUD.
//
// The shape: one key, the one that already declares the surface.
//
//   methods: ['find', 'get', { method: 'pay', input: 'PayOrder' }]
//
// `PayOrder` is a `type T { … }` in the app's OWN seed, so nothing new decides
// what a shape is — it reaches `$defs` beside the models and the same
// jsonSchemaToJunctionSchema → createSchema pair compiles it. That is what buys
// `@length`, `@gte`, required-ness and the author's `x-messages` for free, and
// it is why these tests run against a real Litestone client rather than a stub:
// a fake one would agree with whatever this file assumed about `$defs`.
//
// What it does NOT buy is TRANSFORMS. `@trim`/`@lower`/`@upper`/`@slug` are
// enforced at the Data boundary and are not emitted into JSON Schema at all, so
// a payload that never becomes a model write never meets them — asserted below,
// so the day they start crossing, this file says so rather than staying quiet.
//
// The sharp edge asserted below: an object entry narrows the service exactly as
// a string does. It is not silent — `surface.snapshot.md` carries the
// policy-applied method list and the `snapshots` CI phase fails a stale one —
// but a service that gains its first `methods:` to turn validation on loses
// every verb it did not name, and `narrowing is not free` is the test saying so.

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../../litestone/src/index.js'
import { createApp }              from '../src/core/app.ts'
import { createService, collectMethodInputs, methodEntryName } from '../src/core/service.ts'

const SCHEMA = `
  type PayOrder {
    reference String  @length(3, 12)  @trim
    amount    Int     @gte(1)
    note      String? @label("Note")
  }

  model Order { id Int @id  status String @default("new") }
`

async function mkApp(methods: unknown) {
  const db  = await createClient({ db: ':memory:', schema: SCHEMA })
  const app = createApp({ db: db as never })
  const seen: unknown[] = []
  app.services.register(createService({
    name: 'orders', model: 'Order', db: db as never,
    methods: methods as never,
    // `dispatch = false`: these answer a receipt rather than an Order row, and
    // an unannounced custom method is not what this file is about.
    async pay(ctx: any)  { seen.push(ctx.data); ctx.dispatch = false; return { ok: true } },
    async ship(ctx: any) { seen.push(ctx.data); ctx.dispatch = false; return { ok: true } },
  } as never))
  await app._startForTest()
  return { app, db, seen }
}

// Through `app.service(name)` rather than a hand-built ctx: the app-level
// around hook is what puts the scoped client on `ctx.locals.db`, and the
// declaration is resolved off that client's own $schema.
const call = (app: any, method: string, data: unknown) =>
  app.service('orders').call(method, null, data as never)

// ─── the declaration ──────────────────────────────────────────────────────

describe('methods: entries', () => {

  test('a name and { method } mean the same thing to the policy', () => {
    expect(methodEntryName('pay', 's')).toBe('pay')
    expect(methodEntryName({ method: 'pay', input: 'PayOrder' }, 's')).toBe('pay')
  })

  test('an entry that is neither is refused by name', () => {
    expect(() => methodEntryName({ input: 'PayOrder' } as never, 'orders'))
      .toThrow(/must be a method name or \{ method, input, gate \}/)
    expect(() => methodEntryName(7 as never, 'orders')).toThrow(/orders/)
  })

  test('collectMethodInputs keys the declared types by method', () => {
    expect(collectMethodInputs(['find', { method: 'pay', input: 'PayOrder' }], 's'))
      .toEqual({ pay: 'PayOrder' })
    expect(collectMethodInputs(['find', 'pay'], 's')).toEqual({})
    expect(collectMethodInputs('readOnly', 's')).toEqual({})
    expect(collectMethodInputs(undefined, 's')).toEqual({})
  })

  test('one method, one declaration — a repeated name is refused', () => {
    expect(() => collectMethodInputs(['pay', { method: 'pay', input: 'PayOrder' }], 'orders'))
      .toThrow(/names 'pay' twice/)
  })

  test('input must name a type, not a schema object', () => {
    expect(() => collectMethodInputs([{ method: 'pay', input: {} as never }], 'orders'))
      .toThrow(/must name a `type` declared in the schema/)
    expect(() => collectMethodInputs([{ method: 'pay', input: '  ' }], 'orders'))
      .toThrow(/must name a `type`/)
  })

  test('an object entry naming a method that does not exist is refused at construction', () => {
    expect(() => createService({
      name: 'orders',
      methods: [{ method: 'pya', input: 'PayOrder' }] as never,
      async pay() { return null },
    } as never)).toThrow(/'pya'/)
  })
})

// ─── what it enforces ─────────────────────────────────────────────────────

describe('a declared input is enforced', () => {

  test('a valid payload passes through, coerced', async () => {
    const { app, seen } = await mkApp(['find', 'get', { method: 'pay', input: 'PayOrder' }, 'ship'])
    // '5' as a string: coercion is part of what the declaration buys.
    await call(app, 'pay', { reference: 'ABC123', amount: '5' as never })
    expect(seen[0]).toMatchObject({ reference: 'ABC123', amount: 5 })
  })

  test('a transform does NOT run — @trim is a Data-boundary rule (FJS-401)', async () => {
    const { app, seen } = await mkApp([{ method: 'pay', input: 'PayOrder' }])
    await call(app, 'pay', { reference: ' ABC123 ', amount: 1 })
    // The value is 8 characters and @length(3,12) passed it. Were @trim
    // emitted, `' ABC12345678 '` would trim to 12 and pass where it fails now —
    // the two boundaries do not merely differ in output, they disagree about
    // what is valid, which is why wiring it needs the order settled first.
    expect((seen[0] as Record<string, unknown>).reference).toBe(' ABC123 ')
  })

  test('a payload that violates the type is a 400 naming the field', async () => {
    const { app } = await mkApp(['find', 'get', { method: 'pay', input: 'PayOrder' }, 'ship'])
    let err: any
    try { await call(app, 'pay', { reference: 'x', amount: 5 }) } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(err.code ?? err.status ?? err.statusCode).toBe(400)
    expect(JSON.stringify(err.data ?? err.errors ?? err.message)).toMatch(/reference/)
  })

  test('a required key that is absent is refused', async () => {
    const { app } = await mkApp([{ method: 'pay', input: 'PayOrder' }])
    let err: any
    try { await call(app, 'pay', { reference: 'ABC123' }) } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(JSON.stringify(err.data ?? err.message)).toMatch(/amount/)
  })

  test('an undeclared method beside it is still unvalidated — the declaration is per method', async () => {
    const { app, seen } = await mkApp(['find', 'get', { method: 'pay', input: 'PayOrder' }, 'ship'])
    await call(app, 'ship', { anything: true })
    expect(seen[0]).toEqual({ anything: true })
  })

  test('an empty body is refused rather than passed on as undefined', async () => {
    const { app } = await mkApp([{ method: 'pay', input: 'PayOrder' }])
    let err: any
    try { await call(app, 'pay', null) } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(String(err.message)).toMatch(/body is required/i)
  })
})

// ─── failing open is worse than failing loud ──────────────────────────────

describe('a type that is not there', () => {

  test('throws naming the type and what the schema does have', async () => {
    const { app } = await mkApp([{ method: 'pay', input: 'PayOrdr' }])
    let err: any
    try { await call(app, 'pay', { reference: 'ABC123', amount: 1 }) } catch (e) { err = e }
    expect(err).toBeDefined()
    // Not a warning: an `input:` is a statement the author made, and failing
    // open on it hands back the assurance it was written to provide.
    expect(String(err.message)).toMatch(/PayOrdr/)
    expect(String(err.message)).toMatch(/PayOrder/)
  })

  test('naming a MODEL rather than a type is legal — both are object defs', async () => {
    const { app, seen } = await mkApp([{ method: 'pay', input: 'Order' }])
    await call(app, 'pay', { status: 'paid' })
    expect(seen[0]).toMatchObject({ status: 'paid' })
  })
})

// ─── the sharp edge ───────────────────────────────────────────────────────

describe('an object entry narrows, exactly as a name does', () => {

  test('narrowing is not free', async () => {
    const { app } = await mkApp([{ method: 'pay', input: 'PayOrder' }])
    // `find` was answered before this service declared anything.
    await expect(app.service('orders').find({})).rejects.toThrow()
  })

  test('describe() reports the declaration, so surface.snapshot.md can diff it', async () => {
    const { app } = await mkApp(['find', { method: 'pay', input: 'PayOrder' }])
    const d = (app.services.get('orders') as { describe(): { methods: string[]; inputs: Record<string,string> } }).describe()
    expect(d.methods.sort()).toEqual(['find', 'pay'])
    expect(d.inputs).toEqual({ pay: 'PayOrder' })
  })
})
