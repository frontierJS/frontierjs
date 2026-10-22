// test/method-input.test.ts
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
// a string does. It is not silent — `app.snapshot.md` carries the
// policy-applied method list and the `snapshots` CI phase fails a stale one —
// but a service that gains its first `methods:` to turn validation on loses
// every verb it did not name, and `narrowing is not free` is the test saying so.

import { describe, test, expect } from 'bun:test'
import { createClient }           from '../../litestone/src/index.js'
import { createApp }              from '../src/core/app.ts'
import { collectMethodInputs, collectMethodOutputs, methodEntryName, buildService, defineMethod } from '../src/core/service.ts'
import { describeApp }        from '../src/core/app-model.ts'
import { generateOpenAPI }    from '../src/plugins/openapi/index.ts'

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
  app.services.register(buildService({
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
// around hook is what puts the scoped client on `$.db`, and the
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
      .toThrow(/must be a method name or \{ method, input, output, gate \}/)
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

  test('an object entry naming a method that does not exist is reported', () => {
    // Collected rather than thrown at construction — `start()`'s
    // `check-authoring` phase refuses with every finding at once (`FJS-D199`).
    const svc = buildService({
      name: 'orders',
      methods: [{ method: 'pya', input: 'PayOrder' }] as never,
      async pay() { return null },
    } as never)
    const findings = ((svc as { _authoringFindings?: string[] })._authoringFindings ?? []).join('\n')
    expect(findings).toMatch(/'pya'/)

    // The control one letter away: the entry naming the method that IS there
    // reports nothing, so the refusal is about the name and not about the
    // object form of an entry.
    const fine = buildService({
      name: 'orders',
      methods: [{ method: 'pay', input: 'PayOrder' }] as never,
      async pay() { return null },
    } as never)
    expect((fine as { _authoringFindings?: string[] })._authoringFindings).toEqual([])
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

  test('a transform runs before the checks — @trim reaches the method (FJS-401)', async () => {
    const { app, seen } = await mkApp([{ method: 'pay', input: 'PayOrder' }])
    await call(app, 'pay', { reference: ' ABC123 ', amount: 1 })
    expect((seen[0] as Record<string, unknown>).reference).toBe('ABC123')
  })

  test('the order matches the Data boundary — a transform decides what is valid (FJS-401)', async () => {
    const { app, seen } = await mkApp([{ method: 'pay', input: 'PayOrder' }])
    // 14 characters raw, 12 trimmed: @length(3,12) is asked of the trimmed value.
    await call(app, 'pay', { reference: '  ABC12345678 ', amount: 1 })
    expect((seen[0] as Record<string, unknown>).reference).toBe('ABC12345678')
    // 2 trimmed, 6 raw: the length that fails is the stored one.
    let err: any
    try { await call(app, 'pay', { reference: '  ab  ', amount: 1 }) } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(JSON.stringify(err.data ?? err.errors ?? err.message)).toMatch(/reference/)
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

// ─── a nested type's values ───────────────────────────────────────────────

// A member typed by another `type` is graded by that type's rules, at any
// depth: no Data boundary stands behind an `input:` to catch `contact.email:
// 'nope'` later (FJS-2128).
describe('a nested type is graded by its own rules', () => {
  const NESTED = `
    type Contact { email String @email  first String }
    type Address { zip String @regex("^[0-9]{5}$")  city String  tags String[]? }
    type Start   { key String  contact Contact  property Address?  stops Address[] }
    type Node    { label String @length(1, 5)  children Node[]? }
    model Order  { id Int @id }
  `
  async function mkStart() {
    const db  = await createClient({ db: ':memory:', schema: NESTED })
    const app = createApp({ db: db as never })
    const seen: unknown[] = []
    app.services.register(buildService({
      name: 'orders', model: 'Order', db: db as never,
      methods: [{ method: 'start', input: 'Start' }, { method: 'tree', input: 'Node' }],
      async start(ctx: any) { seen.push(ctx.data); ctx.dispatch = false; return { ok: true } },
      async tree(ctx: any)  { seen.push(ctx.data); ctx.dispatch = false; return { ok: true } },
    } as never))
    await app._startForTest()
    return { app, seen }
  }
  const start = { key: 'k', contact: { email: 'a@b.co', first: 'a' }, stops: [] }
  const refusal = async (app: any, body: unknown) => {
    let err: any
    try { await app.service('orders').call('start', null, body as never) } catch (e) { err = e }
    expect(err).toBeDefined()
    expect(err.code ?? err.status ?? err.statusCode).toBe(400)
    return JSON.stringify(err.data ?? err.errors ?? err.message)
  }

  test('a nested value that breaks its type is a 400 naming its path', async () => {
    const { app } = await mkStart()
    expect(await refusal(app, { ...start, contact: { email: 'nope', first: 'a' } })).toMatch(/contact\.email/)
    expect(await refusal(app, { ...start, property: { zip: 'abc', city: 'c' } })).toMatch(/property\.zip/)
    expect(await refusal(app, { ...start, stops: [{ zip: '12345', city: 'c' }, { zip: 'abc', city: 'c' }] }))
      .toMatch(/stops\[1\]\.zip/)
  })

  test('a nested required key that is absent is refused', async () => {
    const { app } = await mkStart()
    expect(await refusal(app, { ...start, contact: { email: 'a@b.co' } })).toMatch(/contact\.first/)
  })

  test('…and a nested value that keeps its type passes, absent optionals included', async () => {
    const { app, seen } = await mkStart()
    const body = { ...start, property: { zip: '12345', city: 'c' }, stops: [{ zip: '54321', city: 'd' }] }
    await app.service('orders').call('start', null, body as never)
    expect(seen[0]).toMatchObject(body)
  })

  test('a type that holds itself compiles, and is graded at every depth', async () => {
    const { app } = await mkStart()
    let err: any
    const body = { label: 'a', children: [{ label: 'b', children: [{ label: 'too long' }] }] }
    try { await app.service('orders').call('tree', null, body as never) } catch (e) { err = e }
    expect(JSON.stringify(err?.data ?? err?.message)).toMatch(/children\[0\]\.children\[0\]\.label/)
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

  test('describe() reports the declaration, so app.snapshot.md can diff it', async () => {
    const { app } = await mkApp(['find', { method: 'pay', input: 'PayOrder' }])
    const d = (app.services.get('orders') as { describe(): { methods: string[]; inputs: Record<string,string> } }).describe()
    expect(d.methods.sort()).toEqual(['find', 'pay'])
    expect(d.inputs).toEqual({ pay: 'PayOrder' })
  })
})

// ─── the declared answer (FJS-1410) ───────────────────────────────────────

describe('a declared output is reported', () => {
  const SEARCH = `
    type Hit { url String  title String  snippet String? }
    type SearchResult { hits Hit[] }
    model Order { id Int @id }
  `

  test('collectMethodOutputs keys the declared types by method, input untouched', () => {
    const entries = ['find', { method: 'search', input: 'PayOrder', output: 'SearchResult' }]
    expect(collectMethodOutputs(entries, 's')).toEqual({ search: 'SearchResult' })
    expect(collectMethodInputs(entries, 's')).toEqual({ search: 'PayOrder' })
    expect(collectMethodOutputs(['find', 'search'], 's')).toEqual({})
    expect(collectMethodOutputs(undefined, 's')).toEqual({})
  })

  test('output must name a type, not a schema object', () => {
    expect(() => collectMethodOutputs([{ method: 'search', output: {} as never }], 'orders'))
      .toThrow(/\.output must name a `type`/)
  })

  test('describe() and the app description carry it, and so does the OpenAPI answer', async () => {
    const db  = await createClient({ db: ':memory:', schema: SEARCH })
    const app = createApp({ db: db as never })
    app.services.register(buildService({
      name: 'orders', model: 'Order', db: db as never,
      methods: [{ method: 'search', output: 'SearchResult', read: true }] as never,
      async search() { return { hits: [] } },
    } as never))
    await app._startForTest()

    expect(app.services.get('orders')!.describe().outputs).toEqual({ search: 'SearchResult' })
    const desc = describeApp(app)
    expect(desc.services.find(s => s.name === 'orders')!.outputs).toEqual({ search: 'SearchResult' })

    const { generateJsonSchema } = await import('../../litestone/src/index.js')
    const defs = (generateJsonSchema((db as any).$schema, { mode: 'create' }) as any).$defs
    const spec = generateOpenAPI(app, { title: 't', version: '1' }, defs) as any
    const ok   = spec.paths['/orders/{id}'].post.responses['200']
    expect(ok.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/SearchResult' })
    expect(spec.components.schemas.SearchResult).toBeDefined()
  })
})

// ─── a list's size rules ──────────────────────────────────────────────────

// `@minItems`/`@maxItems` reach `$defs` as JSON Schema keywords; mapProp copied
// the string and number bounds and dropped these, so a list rule declared in
// the schema passed any length over the wire (FJS-2702).
describe('a list member is graded by its size rules', () => {
  const LISTS = `
    type SurveyPreview { labels String[] @minItems(2) @maxItems(3) }
    model Order { id Int @id }
  `

  async function mk() {
    const db  = await createClient({ db: ':memory:', schema: LISTS })
    const app = createApp({ db: db as never })
    const seen: unknown[] = []
    app.services.register(buildService({
      name: 'orders', model: 'Order', db: db as never,
      methods: [{ method: 'preview', input: 'SurveyPreview' }] as never,
      async preview(ctx: any) { seen.push(ctx.data); ctx.dispatch = false; return { ok: true } },
    } as never))
    await app._startForTest()
    return { app, seen }
  }

  test('too few and too many are a 400 naming the field; the range passes', async () => {
    const { app, seen } = await mk()
    for (const labels of [['a'], ['a', 'b', 'c', 'd']]) {
      let err: any
      try { await call(app, 'preview', { labels }) } catch (e) { err = e }
      expect(err).toBeDefined()
      expect(err.code ?? err.status ?? err.statusCode).toBe(400)
      expect(JSON.stringify(err.data ?? err.errors ?? err.message)).toMatch(/labels/)
    }
    await call(app, 'preview', { labels: ['a', 'b'] })
    expect(seen).toHaveLength(1)
  })
})

// ─── defineMethod ─────────────────────────────────────────────────────────

describe('defineMethod carries the input with the body (FJS-503)', () => {
  async function mk(methods?: unknown) {
    const db  = await createClient({ db: ':memory:', schema: SCHEMA })
    const app = createApp({ db: db as never })
    const seen: unknown[] = []
    const svc = buildService({
      name: 'orders', model: 'Order', db: db as never,
      ...(methods ? { methods: methods as never } : {}),
      pay: defineMethod('PayOrder', ctx => { seen.push(ctx.data); ctx.dispatch = false; return { ok: true } }),
    } as never)
    app.services.register(svc)
    await app._startForTest()
    return { app, svc, seen }
  }

  test('the handle alone declares the input -- an entry need not repeat it', async () => {
    const { app, svc, seen } = await mk(['find', 'pay'])
    expect((svc as { _inputs?: Record<string, string> })._inputs).toEqual({ pay: 'PayOrder' })
    await call(app, 'pay', { reference: ' ABC123 ', amount: '5' as never })
    expect(seen[0]).toMatchObject({ reference: 'ABC123', amount: 5 })
    let err: any
    try { await call(app, 'pay', { reference: 'x', amount: 5 }) } catch (e) { err = e }
    expect(err.code ?? err.status ?? err.statusCode).toBe(400)
  })

  test('with no methods: list the handle still validates', async () => {
    const { app } = await mk()
    let err: any
    try { await call(app, 'pay', { reference: 'x', amount: 5 }) } catch (e) { err = e }
    expect(err.code ?? err.status ?? err.statusCode).toBe(400)
  })

  test('an entry that names a different input than the handle is refused', () => {
    expect(() => buildService({
      name: 'orders',
      methods: [{ method: 'pay', input: 'Other' }] as never,
      pay: defineMethod('PayOrder', () => null),
    } as never)).toThrow(/defineMethod\('PayOrder'.*'Other'/)
  })
})

// ─── an input on a CRUD verb ──────────────────────────────────────────────

// The declaration REPLACES the model-derived validator (FJS-2873). Left in
// place, autoValidate refused a wire-only key the type names and the model
// does not, before validateInput ran.
describe('an input on a CRUD verb replaces autoValidate', () => {
  const CRUD_SCHEMA = `
    type NewOrder { status String  expiresIn Int @gte(1) }
    model Order { id Int @id  status String @default("new") }
  `

  async function mkCrud() {
    const db  = await createClient({ db: ':memory:', schema: CRUD_SCHEMA })
    const app = createApp({ db: db as never })
    const seen: unknown[] = []
    app.services.register(buildService({
      name: 'orders', model: 'Order', db: db as never,
      methods: ['find', 'get', { method: 'create', input: 'NewOrder' }, 'patch'] as never,
      hooks: { before: { create: [function seeIt(ctx: any) { seen.push({ ...ctx.data }) }] } },
    } as never))
    await app._startForTest()
    return { app, seen }
  }

  test('a key the type names and the model does not reaches the method', async () => {
    const { app } = await mkCrud()
    // The Data boundary would refuse expiresIn if it reached the write, so the
    // proof is that validation passed: the answer is whatever the write says.
    let err: any
    try { await call(app, 'create', { status: 'x', expiresIn: 5 }) } catch (e) { err = e }
    expect(JSON.stringify(err?.data ?? err?.message ?? '')).not.toMatch(/is not a field of Order/)
  })

  test('the declared type still refuses what it declares', async () => {
    const { app } = await mkCrud()
    let err: any
    try { await call(app, 'create', { status: 'x', expiresIn: 0 }) } catch (e) { err = e }
    expect(err.code ?? err.status ?? err.statusCode).toBe(400)
    expect(JSON.stringify(err.data ?? err.message)).toMatch(/expiresIn/)
  })

  test('a CRUD verb beside it with no input keeps autoValidate', async () => {
    const { app } = await mkCrud()
    let err: any
    try { await call(app, 'patch', { status: 'x', nope: 1 }) } catch (e) { err = e }
    expect(JSON.stringify(err?.data ?? err?.message ?? '')).toMatch(/not a field of Order/)
  })
})
