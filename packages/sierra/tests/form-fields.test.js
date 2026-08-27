/**
 * tests/form-fields.test.js
 *
 * The control table, and the two things it makes possible.
 *
 * A form's FIELD LIST is the last thing a page still restates about a model.
 * Typed into a component it drifts the way every duplicated list in this repo
 * has drifted: a column added to `.lite` does not appear, and nothing says so.
 * `formFieldList()` derives it, `controlFor()` says which control each entry
 * gets, and `resource.options()` fills a foreign key's picker from the relation.
 *
 * The table is asserted HERE rather than in the component that renders it,
 * because a hand-written form and a generated one have to agree about what a
 * `Float` is, and one table is the only way to hold that. `@frontierjs/ui`'s
 * own form suite imports this same module by relative path for the same reason.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest'

// Every service call the resource makes, and what it answers with.
let _asked = []
let _rows  = []
let _fail  = null
let _total = undefined

vi.mock('@frontierjs/sierra/junction', () => ({
  getClient: () => ({
    service: (name) => ({
      find: async (query, params) => {
        _asked.push({ name, query, params })
        if (_fail) throw _fail
        return _total === undefined ? { data: _rows } : { data: _rows, total: _total }
      },
      on:   () => {},
    }),
    resource: () => ({
      store: { get: () => [], subscribe: (fn) => { fn([]); return () => {} }, set: () => {} },
      load: async () => [],
    }),
  }),
}))

const {
  createResource, controlFor, defaultControlFor, formFieldList, labelFieldFor, buildFieldRules,
  registerControl, unregisterControl, registeredControls, validateAgainstFields,
} = await import('../src/junction/resource.js')
const { registerSchemas, serviceNameFor } = await import('../src/junction/schema-registry.js')

// What generateJsonSchema emits (create mode) for:
//   model Order    { id Int @id  reference String @length(3,20)  status OrderStatus @default("pending")
//                    total Float @default(0)  active Boolean  body String @markdown
//                    dueOn DateTime? @date  opensAt String @time  shutsAt String @time(seconds: true)
//                    customerId Int  customer Customer @relation(...)
//                    tags String[] }
//   model Customer { id Int @id  name String  email String }
const DEFS = {
  Order: {
    type: 'object', title: 'Order',
    properties: {
      reference:  { type: 'string', minLength: 3, maxLength: 20 },
      status:     { $ref: '#/$defs/OrderStatus', default: 'pending' },
      total:      { type: 'number', default: 0 },
      active:     { type: 'boolean', title: 'Is live' },
      body:       { type: 'string', contentMediaType: 'text/markdown' },
      dueOn:      { anyOf: [{ type: 'string', format: 'date' }, { type: 'null' }] },
      opensAt:    { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$', 'x-time': { seconds: false } },
      shutsAt:    { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d)?$', 'x-time': { seconds: true } },
      customerId: { type: 'integer', title: 'Customer' },
      tags:       { type: 'array', items: { type: 'string' } },
      notes:      { type: 'object' },
    },
    required: ['reference', 'customerId'],
    'x-relations': [
      { field: 'customer', model: 'Customer', type: 'belongsTo',
        fields: ['customerId'], references: ['id'], optional: false },
    ],
  },
  Customer: {
    type: 'object', title: 'Customer',
    properties: { name: { type: 'string' }, email: { type: 'string', format: 'email' } },
    required: ['name'],
  },
  OrderStatus: { type: 'string', enum: ['pending', 'paid', 'shipped'] },
}

beforeEach(() => {
  registerSchemas(DEFS, ['Order', 'Customer'])
  _asked = []
  _rows  = []
  _fail  = null
  _total = undefined
  // The registry is module state, so a registration that outlives its test
  // changes the answer for every test after it.
  for (const name of registeredControls()) unregisterControl(name)
})

const rules = () => buildFieldRules(DEFS.Order)

describe('controlFor — the one place a type becomes a control', () => {

  test('a foreign key is a picker, never a number spinner', () => {
    const c = controlFor(rules().customerId)
    expect(c).toMatchObject({ control: 'picker', model: 'Customer', valueField: 'id', relation: 'customer' })
  })

  test('an enum is a select carrying its members', () => {
    expect(controlFor(rules().status)).toEqual({ control: 'select', options: ['pending', 'paid', 'shipped'] })
  })

  test('a boolean is a checkbox', () => {
    expect(controlFor(rules().active).control).toBe('checkbox')
  })

  test('a number states its step, because the schema does not say how finely to nudge', () => {
    expect(controlFor(rules().total)).toEqual({ control: 'input', step: 'any' })
    expect(controlFor({ type: 'integer' })).toEqual({ control: 'input', step: 1 })
  })

  test('@markdown is a textarea — a declaration, not a guess about length', () => {
    expect(controlFor(rules().body).control).toBe('textarea')
    // An ordinary unbounded string is NOT promoted. Nothing declared it long.
    expect(controlFor({ type: 'string' })).toEqual({ control: 'input' })
  })

  test('a date round-trips in a date input; a date-time needs a control of its own', () => {
    // A date has no zone, so the element round-trips it and a type attribute
    // is the whole answer.
    expect(controlFor(rules().dueOn)).toEqual({ control: 'input', type: 'date' })
    // A date-time does have one and `datetime-local` has none, so the value has
    // to be converted at each edge — that is a control, and this row names it
    // rather than a type. `@frontierjs/ui` binds it to DateTimeInput.
    expect(controlFor({ type: 'string', format: 'date-time' })).toEqual({ control: 'datetime' })
  })

  test('a wall-clock time is a time input, and the seconds box is a step', () => {
    // The same argument as `date`: no zone, so the element round-trips it.
    expect(controlFor(rules().opensAt)).toEqual({ control: 'input', type: 'time' })
    // `<input type="time">` shows HH:MM unless the step is not a whole number
    // of minutes — so without this, a column that ACCEPTS seconds gives a
    // person no way to type them (`FJS-522`).
    expect(controlFor(rules().shutsAt)).toEqual({ control: 'input', type: 'time', step: 1 })
  })

  test('the pattern survives into the rule, so the browser checks what the server checks', () => {
    // `x-time` picks the control and enforces nothing. The refusal is the
    // `pattern`, which is the validator's own regex — carried, not restated.
    const at = (v) => validateAgainstFields(rules(), { reference: 'abc', customerId: 1, opensAt: v }, 'create')
                        .find(e => e.field === 'opensAt')
    expect(at('09:30')).toBeUndefined()
    expect(at('9:30')?.message).toBeTruthy()   // leading zeros are what make it sort
    expect(at('24:00')?.message).toBeTruthy()
  })

  // ── Against a real schema, because the fixtures above are hand-written ─────
  //
  // Every rule in this file is typed out by hand, which is fast and is also how
  // the `json` control shipped not working for the one column it was written
  // for: a `Json` field does NOT arrive as `type: 'object'`. Litestone emits it
  // as `{}` — the empty schema, no type at all, since a JSON document may be
  // any of the seven things JSON can hold — and the table waited for a type
  // that never comes. The same pass turned a `File` column into a JSON
  // textarea, because FileRef derefs to an ordinary object.
  //
  // So this one derives its rules from litestone itself. Fake fixtures hide
  // real bugs; this is the fixture that cannot.
  test('a real .lite schema resolves the shapes the hand-written rules cannot', async () => {
    // The two modules by path, not the package index — that one opens
    // `bun:sqlite` and these tests run under vitest on node. Both of these are
    // pure: a parser and an emitter.
    const { parse }              = await import('../../litestone/src/core/parser.js')
    const { generateJsonSchema } = await import('../../litestone/src/jsonschema.js')

    const { schema } = parse(
      'model Doc {\n' +
      '  id Int @id\n' +
      '  title String\n' +
      '  attachment File?\n' +
      '  meta Json\n' +
      '  opt Json?\n' +
      '  tags String[]\n' +
      '}\n',
    )
    const defs = generateJsonSchema(schema).$defs

    // The resolver is passed rather than registered globally: `$defs` is the
    // whole definition table and a `File` column is a `$ref` into it, so
    // without one the FileRef below never derefs — and an unresolved ref and a
    // `Json` column are indistinguishable by type alone, which the table has to
    // be told apart rather than guess at.
    const rules = buildFieldRules(defs.Doc, (ref) => defs[ref.replace('#/$defs/', '')])

    // A Json column: `{}` in, the json control out. This is the assertion that
    // was missing, and the reason it was missing is that no fixture here was
    // ever built by the thing that builds them in an app.
    expect(rules.meta.type).toBe(null)
    expect(controlFor(rules.meta, { field: 'meta', model: 'Doc' }).control).toBe('json')
    expect(controlFor(rules.opt, { field: 'opt', model: 'Doc' }).control).toBe('json')

    expect(controlFor(rules.tags, { field: 'tags', model: 'Doc' }).control).toBe('json')
    expect(controlFor(rules.title, { field: 'title', model: 'Doc' }).control).toBe('input')

    // A File column derefs to FileRef — an object with eight properties — so a
    // table that answers `json` for an object would offer a textarea over a
    // storage key and a bucket. It answers `file`, and the resolved $ref is the
    // only thing separating the two: this is what `x-litestone-file` is carried
    // for (`FJS-409`).
    const file = controlFor(rules.attachment, { field: 'attachment', model: 'Doc' })
    expect(file.control).toBe('file')
    // `File` and `File[]` are one control and two inputs, and the declared type
    // is all that separates them once the $ref is resolved away.
    expect(file.multiple).toBe(false)
    // No `@accept` on this column, so the picker offers everything — null
    // rather than a guessed default, because the kit is what decides what "no
    // restriction" looks like to a file dialog.
    expect(file.accept).toBe(null)

    // And the other half of that ambiguity: with NO resolver the same `File`
    // column has no type either, which reads exactly like a Json document. It
    // must not become a textarea — an unpopulated registry would otherwise turn
    // every enum and every relation on a form into one.
    const blind = buildFieldRules(defs.Doc)
    const guess = controlFor(blind.attachment, { field: 'attachment', model: 'Doc' })
    expect(guess.control).toBe(null)
    expect(guess.reason).toMatch(/unresolved/)
    // …while a real Json column is still a document, resolver or not.
    expect(controlFor(blind.meta, { field: 'meta', model: 'Doc' }).control).toBe('json')
  })

  test('the two types the schema stops describing are edited as their own syntax', () => {
    // A `Json` column and a `String[]` have no field list under them, so there
    // is nothing to generate a row of controls from and the only editor that
    // covers every value they may hold is the document's own text.
    // `@frontierjs/ui` binds this name to JsonInput.
    expect(controlFor(rules().notes).control).toBe('json')
    expect(controlFor(rules().tags).control).toBe('json')
  })

  test('a column with no control answers with a reason, not with nothing', () => {
    expect(controlFor({ type: 'string', readOnly: true })).toMatchObject({ control: null, reason: 'readOnly' })
    // A type this table has never heard of. Dropping it silently is the failure
    // the reason exists to prevent.
    expect(controlFor({ type: 'geography' })).toMatchObject({ control: null })
    expect(controlFor({ type: 'geography' }).reason).toMatch(/geography/)
  })
})

describe('formFieldList — the field set, derived', () => {

  test('every writable column, in schema order', () => {
    const list = formFieldList(rules()).filter(f => f.control)
    expect(list.map(f => f.name)).toEqual(
      ['reference', 'status', 'total', 'active', 'body', 'dueOn', 'opensAt', 'shutsAt',
       'customerId', 'tags', 'notes'],
    )
  })

  test('a column with no control stays in the list so a renderer can say so', () => {
    // A type the table has never heard of. It declines and says why, rather
    // than dropping the entry, because a field missing from a form in silence
    // is the failure generating the list exists to end.
    const list = formFieldList({ ...rules(), shape: { type: 'geography' } })
    const shape = list.find(f => f.name === 'shape')
    expect(shape.control).toBeNull()
    expect(shape.reason).toBeTruthy()
  })

  test('only narrows AND orders — naming five fields names their order too', () => {
    const list = formFieldList(rules(), { only: ['total', 'reference'] })
    expect(list.map(f => f.name)).toEqual(['total', 'reference'])
  })

  test('except removes', () => {
    const names = formFieldList(rules(), { except: ['status', 'tags', 'notes'] }).map(f => f.name)
    expect(names).not.toContain('status')
    expect(names).toContain('reference')
  })

  test('a name neither list knows is reported, not ignored — usually a rename', () => {
    const only = formFieldList(rules(), { only: ['reference', 'refrence'] })
    expect(only.find(f => f.name === 'refrence')).toMatchObject({ control: null, rule: null })

    const except = formFieldList(rules(), { except: ['trackingCode'] })
    expect(except.find(f => f.name === 'trackingCode')?.reason).toMatch(/no such field/)
  })

  test('the rule travels with the entry, so nothing has to look it up twice', () => {
    const ref = formFieldList(rules()).find(f => f.name === 'reference')
    expect(ref.rule).toMatchObject({ required: true, maxLength: 20 })
  })
})

describe('labelFieldFor — which column a picker shows', () => {

  test('a conventional name wins', () => {
    expect(labelFieldFor(buildFieldRules(DEFS.Customer))).toBe('name')
  })

  test('otherwise the first plain string column', () => {
    expect(labelFieldFor({ id: { type: 'integer' }, ref: { type: 'string' } })).toBe('ref')
  })

  test('an enum, a foreign key and a readOnly column are not labels', () => {
    const fields = {
      status: { type: 'string', enum: ['a'] },
      ownerId: { type: 'string', references: { model: 'User', field: 'id' } },
      slug:    { type: 'string', readOnly: true },
    }
    expect(labelFieldFor(fields, 'id')).toBe('id')
  })
})

describe('serviceNameFor — the crossing a relation needs', () => {

  test("English's regular plurals, and only those", () => {
    expect(serviceNameFor('Customer')).toBe('customers')
    expect(serviceNameFor('Company')).toBe('companies')
    expect(serviceNameFor('Status')).toBe('statuses')
    expect(serviceNameFor('Box')).toBe('boxes')
  })

  test('and what registerSchemas indexes resolves back', async () => {
    const { modelNameFor } = await import('../src/junction/schema-registry.js')
    expect(modelNameFor(serviceNameFor('Customer'))).toBe('Customer')
  })
})

describe('resource.options — a picker filled from the relation', () => {

  test('asks the related service, and maps id → the column a person recognises', async () => {
    _rows = [{ id: 7, name: 'Ada', email: 'ada@example.com' }, { id: 9, name: 'Grace' }]
    const orders = createResource('orders', { model: 'Order' })

    const { options, total, truncated } = await orders.options('customerId')

    expect(_asked[0].name).toBe('customers')          // from the relation, not from a name typed anywhere
    expect(_asked[0].params.orderBy).toBe('name')
    expect(options).toEqual([{ value: 7, label: 'Ada' }, { value: 9, label: 'Grace' }])
    // The stub answers `{ data }` with no `total`, which is the case that has
    // to stay distinguishable from a complete list: unknown, not "no".
    expect(total).toBe(null)
    expect(truncated).toBe(null)
  })

  test('a stated labelField wins over the convention', async () => {
    _rows = [{ id: 7, name: 'Ada', email: 'ada@example.com' }]
    const orders = createResource('orders', { model: 'Order' })

    expect((await orders.options('customerId', { labelField: 'email' })).options)
      .toEqual([{ value: 7, label: 'ada@example.com' }])
  })

  test('one request per field for the life of the resource', async () => {
    _rows = [{ id: 1, name: 'Ada' }]
    const orders = createResource('orders', { model: 'Order' })

    await Promise.all([orders.options('customerId'), orders.options('customerId')])
    await orders.options('customerId')

    expect(_asked).toHaveLength(1)
  })

  test('an enum answers from the rule, with no request, and still a promise', async () => {
    // One call shape for both kinds of field is the point: a caller asking
    // what a field's options are cannot know which kind it holds without
    // re-deriving the thing this function decides. An enum resolves off the
    // schema, so nothing is asked of the network — but it is still awaited,
    // so the caller has one path rather than two.
    const orders = createResource('orders', { model: 'Order' })

    const { options, total, truncated } = await orders.options('status')

    expect(options).toEqual([
      { value: 'pending', label: 'pending' },
      { value: 'paid',    label: 'paid' },
      { value: 'shipped', label: 'shipped' },
    ])
    expect(_asked).toHaveLength(0)
    // A declared set is entirely in hand, so the count is the whole set and
    // truncation is decidably false — never the null a paged relation gives.
    expect(total).toBe(3)
    expect(truncated).toBe(false)
  })

  test('search goes to the SERVER as a filter on the label column', async () => {
    // The half that makes a relation bigger than the page reachable at all.
    // Filtering the hundred rows that already arrived cannot find row 4,000.
    _rows = [{ id: 7, name: 'Ada' }]
    const orders = createResource('orders', { model: 'Order' })

    await orders.options('customerId', { search: 'ad' })

    expect(_asked[0].query).toEqual({ name: { contains: 'ad' } })
  })

  test('search composes with a standing filter rather than replacing it', async () => {
    _rows = []
    const orders = createResource('orders', { model: 'Order' })

    await orders.options('customerId', { query: { active: true }, search: 'ad' })

    expect(_asked[0].query).toEqual({ active: true, name: { contains: 'ad' } })
  })

  test('a searched result is not cached, an unsearched one is', async () => {
    // The key would carry the term, so every keystroke would leave an entry
    // behind for the life of the resource — and it is the one answer certain
    // to be superseded a moment later.
    _rows = [{ id: 1, name: 'Ada' }]
    const orders = createResource('orders', { model: 'Order' })

    await orders.options('customerId', { search: 'a' })
    await orders.options('customerId', { search: 'a' })
    expect(_asked).toHaveLength(2)

    await orders.options('customerId')
    await orders.options('customerId')
    expect(_asked).toHaveLength(3)
  })

  test('a total the service reports is carried, and decides truncated', async () => {
    _rows  = [{ id: 1, name: 'Ada' }]
    _total = 400
    const orders = createResource('orders', { model: 'Order' })

    const { total, truncated } = await orders.options('customerId')

    expect(total).toBe(400)
    expect(truncated).toBe(true)
    _total = undefined
  })

  test('a field that is not a foreign key answers [] and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const orders = createResource('orders', { model: 'Order' })

    expect((await orders.options('reference')).options).toEqual([])
    expect(warn.mock.calls[0][0]).toMatch(/neither an enum nor a foreign key/)
    warn.mockRestore()
  })

  test('a failed load empties the picker rather than taking the form down', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    _fail = new Error('offline')
    const orders = createResource('orders', { model: 'Order' })

    expect((await orders.options('customerId')).options).toEqual([])
    expect(warn.mock.calls[0][0]).toMatch(/offline/)

    // …and the failure is not remembered as an answer: the next render asks
    // again, which is what makes a dropped connection recoverable.
    _fail = null
    _rows = [{ id: 1, name: 'Ada' }]
    expect((await orders.options('customerId')).options).toEqual([{ value: 1, label: 'Ada' }])

    warn.mockRestore()
  })
})

describe('the resource hands the list out', () => {

  test('resource.formFields() is the same list, over the resource own fields', () => {
    const orders = createResource('orders', { model: 'Order' })
    expect(orders.formFields().filter(f => f.control).map(f => f.name))
      .toEqual(formFieldList(rules()).filter(f => f.control).map(f => f.name))
  })

  test('a resource with no schema generates nothing rather than guessing', () => {
    registerSchemas({}, [])
    const nothing = createResource('mystery')
    expect(nothing.formFields()).toEqual([])
  })
})


// ── Contributed controls ──────────────────────────────────────────────────────
//
// `FJS-D17`. The table above is the framework's answer and it is deliberately
// narrow; everything past it — money, a rich editor, chips for a `String[]`,
// a structured tree over a Json document — is a control somebody else owns.
// Before this registry `controlFor` was a switch inside a published package, so
// contributing one meant forking Sierra.
//
// Only the NAME is decided here. The component is the kit's half
// (`@frontierjs/ui/controls`), because this module is a leaf that has to run in
// plain Node and cannot hold a component at all.

describe('registerControl — the half of a contribution that names the control', () => {

  test('a resolver takes a column the built-in table already answers', () => {
    // The registry is asked BEFORE the table, so this is the same mechanism a
    // brand-new type uses — an app that wants chips for a `String[]` beats the
    // json editor the table falls back to, without forking Sierra.
    expect(controlFor(rules().tags).control).toBe('json')

    registerControl('tags', (rule) => (rule.type === 'array' ? 'tag-input' : null))

    expect(controlFor(rules().tags)).toMatchObject({ control: 'tag-input', by: 'tags' })
    // …and it did not claim anything else on the way past.
    expect(controlFor(rules().total)).toEqual({ control: 'input', step: 'any' })
  })

  test('a descriptor travels whole — whatever the component needs rides along', () => {
    registerControl('stars', () => ({ control: 'stars', max: 5, allowHalf: true }))
    expect(controlFor(rules().total)).toEqual({ control: 'stars', max: 5, allowHalf: true, by: 'stars' })
  })

  test('answering null declines and the next entry — then the table — answers', () => {
    const asked = []
    registerControl('never', (rule) => { asked.push(rule.type); return null })

    expect(controlFor(rules().active).control).toBe('checkbox')
    expect(asked).toEqual(['boolean'])
  })

  test('the last registration is the first asked, so an app beats the kit it imported', () => {
    registerControl('kit', () => 'kit-select')
    registerControl('app', () => 'app-select')

    expect(controlFor(rules().status).control).toBe('app-select')
    expect(registeredControls()).toEqual(['app', 'kit'])

    // …and re-registering a name MOVES it rather than stacking a second copy —
    // a dev server re-evaluating a module must not leave three of it behind.
    registerControl('kit', () => 'kit-again')
    expect(registeredControls()).toEqual(['kit', 'app'])
    expect(controlFor(rules().status).control).toBe('kit-again')
  })

  test('the undo it returns removes that entry, and only if it is still the one', () => {
    const off = registerControl('tmp', () => 'x')
    expect(controlFor(rules().total).control).toBe('x')

    off()
    expect(controlFor(rules().total).control).toBe('input')

    // Registering the name again after the undo was captured, then calling it:
    // the later entry is somebody else's and must survive.
    const off2 = registerControl('tmp', () => 'y')
    off()
    expect(controlFor(rules().total).control).toBe('y')
    off2()
  })

  test('a resolver is handed which column, on which model — not just a type', () => {
    const seen = []
    registerControl('one-column', (rule, ctx) => {
      seen.push(ctx)
      return ctx.field === 'body' && ctx.model === 'Order' ? 'editor' : null
    })

    const list = formFieldList(rules(), { model: 'Order' })
    expect(list.find(f => f.name === 'body').control).toBe('editor')
    expect(list.find(f => f.name === 'reference').control).toBe('input')
    expect(seen[0]).toEqual({ field: 'reference', model: 'Order' })
  })

  test('a resource passes its own model name down', () => {
    const seen = []
    registerControl('spy', (_rule, ctx) => { seen.push(ctx.model); return null })

    createResource('orders', { model: 'Order' }).formFields()
    expect(new Set(seen)).toEqual(new Set(['Order']))
  })

  test('a resolver may say a column deliberately has NO control', () => {
    registerControl('no-json', (rule) =>
      (rule.type === 'object' ? { control: null, reason: 'a Json column is edited on its own screen here' } : null))

    const c = controlFor(rules().notes)
    expect(c.control).toBe(null)
    expect(c.reason).toMatch(/its own screen/)
    expect(c.by).toBe('no-json')
  })

  test('a readOnly column is not offered to the registry at all', () => {
    // @system / @computed / @generated / @from — the Data boundary refuses the
    // write by name, so a control over one is a form that cannot submit.
    let asked = false
    registerControl('greedy', () => { asked = true; return 'anything' })

    expect(controlFor({ type: 'string', readOnly: true })).toEqual({ control: null, reason: 'readOnly' })
    expect(asked).toBe(false)
  })

  test('a resolver that throws is skipped by name, and the form still renders', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerControl('broken', () => { throw new Error('boom') })

    expect(controlFor(rules().total)).toEqual({ control: 'input', step: 'any' })
    expect(warn.mock.calls[0][0]).toMatch(/broken/)
    expect(warn.mock.calls[0][0]).toMatch(/boom/)
    warn.mockRestore()
  })

  test('an answer that is not a control name is refused out loud, not rendered', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    registerControl('confused', () => 42)
    expect(controlFor(rules().total).control).toBe('input')

    registerControl('emptyish', () => ({ options: [] }))
    expect(controlFor(rules().total).control).toBe('input')

    expect(warn.mock.calls.map(c => c[0]).join('\n')).toMatch(/confused/)
    expect(warn.mock.calls.map(c => c[0]).join('\n')).toMatch(/emptyish/)
    warn.mockRestore()
  })

  test('registering nonsense is refused where it happens, not where it renders', () => {
    expect(() => registerControl('', () => 'x')).toThrow(/non-empty string/)
    expect(() => registerControl('x')).toThrow(/must be a function/)
  })

  test('defaultControlFor is the table with the registry skipped, so a resolver can extend it', () => {
    registerControl('wider-step', (rule) => {
      const base = defaultControlFor(rule)
      return base.control === 'input' && base.step === 'any' ? { ...base, step: 0.01 } : null
    })

    expect(controlFor(rules().total)).toMatchObject({ control: 'input', step: 0.01 })
    expect(defaultControlFor(rules().total)).toEqual({ control: 'input', step: 'any' })
  })
})

// ─── @transient — a field the caller writes and no read answers ─────────────
//
// It reaches the browser because sierra registers the CREATE-mode schema, which
// is where litestone emits it. Nothing here is special-cased: the value of
// declaring it is that a generated form offers a control for it and the
// resource's own validation applies the schema's rules to it — where a wire-only
// field held by a server hook alone was stripped in the browser before the
// request was ever made.
describe('a @transient field', () => {
  const MODEL = {
    properties: {
      name:   { type: 'string' },
      secret: { type: 'string', minLength: 4, title: 'Credential', writeOnly: true,
                'x-litestone-kind': 'transient' },
    },
    required: ['name', 'secret'],
  }

  test('gets a control, and carries writeOnly for a view that needs to know', () => {
    const rules = buildFieldRules(MODEL)
    expect(rules.secret.writeOnly).toBe(true)
    expect(controlFor(rules.secret).control).toBe('input')
  })

  test('is in the generated form field list, in schema order', () => {
    const list = formFieldList(buildFieldRules(MODEL))
    expect(list.map(f => f.name)).toEqual(['name', 'secret'])
  })

  test('and its rules are enforced in the browser, like any other field', () => {
    const rules = buildFieldRules(MODEL)
    expect(rules.secret.required).toBe(true)
    expect(rules.secret.minLength).toBe(4)
  })
})
