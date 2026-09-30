/*
 * test/projection.test.ts — what one standing sees, and what decided
 *
 * Every visibility row is a PAIR: the tool withheld here and the same tool
 * admitted one rung up, or admitted for a caller entitled to it. A projection
 * that showed NOTHING satisfies every assertion about a refusal on its own, and
 * one that showed EVERYTHING satisfies every assertion about an affordance, so
 * neither half is evidence without the other.
 *
 * The fixture is hand-built rather than read out of `example`, for one reason
 * that forces it: the two shapes this module is arranged around are absent
 * there. No model in that app offers a method its policy allows AND a LOCKED
 * gate refuses, so `levelPasses` against a bare `>=` is a distinction it cannot
 * draw. The floor case IS present there (`invoices.void`) and is reproduced
 * here with its real numbers, because that one was found by measurement and the
 * regression has to be answerable without booting a shop.
 */

import { describe, test, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { parse } from '@frontierjs/litestone/parser'
import { generateJsonSchema } from '@frontierjs/litestone/jsonschema'
import { projectTools, schemaViews, toolName } from '../src/projection.ts'
import type { ServiceShape } from '../src/projection.ts'

// ─── the fixture, parsed ──────────────────────────────────────────────────────
//
// `test/fixtures/shop.lite` says why it is real source rather than a `$defs`
// blob. The generator runs for real, so a keyword that moves is a failure here
// rather than a wrong answer nobody sees.

const parsed = parse(readFileSync(new URL('./fixtures/shop.lite', import.meta.url), 'utf8'))
if (parsed.errors?.length) throw new Error(`fixture does not parse: ${JSON.stringify(parsed.errors)}`)

const VIEWS = schemaViews(parsed.schema, generateJsonSchema as never)
const DEFS  = VIEWS.full

const SERVICES: ServiceShape[] = [
  { name: 'orders',   model: 'Order',   methods: ['find', 'get', 'create', 'patch', 'remove', 'pay', 'ship', 'refund', 'lapse'] },
  { name: 'invoices', model: 'Invoice', methods: ['find', 'get', 'issue', 'void'] },
  { name: 'ledger',   model: 'Ledger',  methods: ['find', 'get', 'create', 'patch', 'remove'] },
  { name: 'carts',    model: 'Cart',    methods: ['find', 'get', 'open', 'checkout'] },
  {
    name: 'credentials', model: 'Credential', methods: ['find', 'get', 'create'],
  },
  // A custom method with a DECLARED input type, which is the only place a
  // custom argument shape is written down.
  {
    name: 'shipments', model: 'Order', methods: ['recordTracking'],
    inputs: { recordTracking: 'TrackingUpdate' },
  },
]

const at = (level: number) => {
  const p = projectTools(SERVICES, VIEWS, level)
  return {
    ...p,
    has:  (n: string) => p.tools.some(t => t.name === n),
    hid:  (n: string) => p.withheld.some(t => t.name === n),
    why:  (n: string) => [...p.tools, ...p.withheld].find(t => t.name === n),
  }
}

// ─── the CRUD half ────────────────────────────────────────────────────────────

describe('a model gate narrows the CRUD verbs', () => {

  test('a stranger sees no Order at all, because read is 1 and not 0', () => {
    // Worth stating rather than assuming: `example` gates Order reads at VISITOR,
    // so a caller with no session is refused the LIST as well as the write. The
    // first draft of this test asserted the opposite and the module was right.
    const p = at(0)
    expect(p.hid('orders_find')).toBe(true)
    expect(p.why('orders_find')?.needs).toBe(1)
    expect(p.hid('orders_create')).toBe(true)
    expect(p.why('orders_create')?.needs).toBe(4)
  })

  test('the same tools appear for a caller who clears them', () => {
    // The pair. Without this, a projection returning nothing passes above.
    const p = at(4)
    expect(p.has('orders_create')).toBe(true)
    expect(p.has('orders_patch')).toBe(true)
    expect(p.hid('orders_remove')).toBe(true)    // delete: 5
    expect(at(5).has('orders_remove')).toBe(true)
  })

  test('read: 1 withholds from a stranger and admits a visitor', () => {
    // The pair for the row above. One rung, and the whole service appears.
    expect(at(0).hid('orders_find')).toBe(true)
    expect(at(1).has('orders_find')).toBe(true)
    expect(at(1).has('orders_get')).toBe(true)
  })
})

describe('LOCKED is reachable by nobody — the shape example has not got', () => {

  test('a level-9 position admits no standing, SYSTEM included', () => {
    for (const level of [0, 4, 5, 6, 7, 8]) {
      const p = at(level)
      expect(p.hid('ledger_patch'),  `patch at ${level}`).toBe(true)
      expect(p.hid('ledger_remove'), `remove at ${level}`).toBe(true)
    }
  })

  test('and the same model still answers its reads, or the row proves nothing', () => {
    // The pair. A projection that dropped `Ledger` entirely satisfies the test
    // above and is broken.
    expect(at(5).has('ledger_find')).toBe(true)
    expect(at(5).has('ledger_get')).toBe(true)
    expect(at(4).hid('ledger_find')).toBe(true)  // read: 5
  })

  test('create: 8 admits SYSTEM and refuses SYSADMIN', () => {
    // The sentinel that IS reachable: 8 is not a rung, so the highest human
    // standing is refused and only the application itself passes.
    expect(at(8).has('ledger_create')).toBe(true)
    expect(at(7).hid('ledger_create')).toBe(true)
    expect(at(8).why('ledger_create')?.needs).toBe(8)
    // The pair, so the row is not satisfied by a projection that hid everything.
    expect(at(7).has('ledger_find')).toBe(true)
  })
})

// ─── the half the gate says nothing about ─────────────────────────────────────

describe('a declared move grades the verb that drives it', () => {

  test('a move with no gate of its own takes the model update level', () => {
    expect(at(0).hid('orders_pay')).toBe(true)
    expect(at(4).has('orders_pay')).toBe(true)
    expect(at(4).has('orders_ship')).toBe(true)
    expect(at(4).why('orders_pay')?.needs).toBe(4)
    expect(at(4).why('orders_pay')?.verdict).toBe('move-floor')
  })

  test('a gated move takes the HIGHER of the two, not its own number', () => {
    // orders.refund — @gate 5 over update 4. The move's number wins.
    expect(at(4).hid('orders_refund')).toBe(true)
    expect(at(5).has('orders_refund')).toBe(true)
    expect(at(5).why('orders_refund')?.needs).toBe(5)
  })

  test('invoices.void needs 8, because the MODEL is written at 8', () => {
    // The regression that measurement found. Grading by the move's own @gate 5
    // offers this at STAFF, two rungs under what the boundary accepts — the one
    // mistake here that misleads a caller about its own permissions rather than
    // merely wasting a turn.
    expect(at(5).hid('invoices_void')).toBe(true)
    expect(at(7).hid('invoices_void')).toBe(true)
    expect(at(8).has('invoices_void')).toBe(true)
    expect(at(8).why('invoices_void')?.needs).toBe(8)

    // The negative control for the floor: taking the move's number alone.
    const naive = Math.min(8, 5)
    expect(naive).toBe(5)
    expect(at(naive).has('invoices_void')).toBe(false)
  })

  test('a @system move takes the same floor as any move — @system is whose decision, not how senior', () => {
    // `FJS-D150`: the method lifts @system on the CALLER's client, which keeps
    // the gate. Withheld from every standing, `example`'s `invoices.settle`
    // was hidden from the staff who press it.
    expect(at(3).hid('orders_lapse')).toBe(true)
    expect(at(4).has('orders_lapse')).toBe(true)
    expect(at(4).why('orders_lapse')?.verdict).toBe('move-floor')
    expect(at(4).why('orders_lapse')?.needs).toBe(4)

    // The control: on a model written at 8 the same attribute still leaves the
    // move to the application alone, because the FLOOR says so.
    expect(at(7).hid('invoices_issue')).toBe(true)
    expect(at(8).has('invoices_issue')).toBe(true)
    expect(at(8).why('invoices_issue')?.needs).toBe(8)
  })
})

describe('what the seed does not say is labelled, not guessed', () => {

  test('a custom method backed by no declared move stays visible and is marked', () => {
    const p = at(0)
    expect(p.has('carts_checkout')).toBe(true)
    expect(p.why('carts_checkout')?.verdict).toBe('ungraded')
    expect(p.why('carts_checkout')?.needs).toBe(null)
  })

  test('carts at STRANGER is CORRECT and a fix must not tighten it', () => {
    // A guest basket is owned by a caller with no session, through a claim.
    // `example`'s verify:cart exists to prove it. A rule that withheld
    // everything at level 0 would read as a tightening and break the storefront.
    const p = at(0)
    expect(p.has('carts_find')).toBe(true)
    expect(p.has('carts_open')).toBe(true)
    expect(p.withheld.filter(t => t.service === 'carts')).toEqual([])
  })

  test('ungraded is not filed with the rules that actually cleared a number', () => {
    // *Nothing refused this* and *a rule allowed it* are different facts, and a
    // verdict that conflated them would make the list useless as evidence.
    const p = at(0)
    const graded = p.tools.filter(t => t.verdict === 'model-gate' || t.verdict === 'move-floor')
    const open   = p.tools.filter(t => t.verdict === 'ungraded')
    // Only `Cart` earns it, and it earns it by declaring no `@@gate` at all —
    // which is what `customMethodGrade` calls `unchecked`. A custom method on a
    // GATED model is never ungraded: it takes that model's read gate as a
    // presence check, which is the row below.
    expect(open.map(t => t.name).sort()).toEqual(['carts_checkout', 'carts_open'])
    // And a graded tool with no NUMBER is exactly a model that declares no
    // gate — asserted as a set against the schema rather than by naming the
    // models, or the row goes stale the moment the fixture grows one.
    const ungatedModels = Object.keys(DEFS).filter(m => !DEFS[m]?.['x-gate']).sort()
    const nullNeeds = [...new Set(graded.filter(t => t.needs === null).map(t => t.model))].sort()
    expect(nullNeeds).toEqual(ungatedModels.filter(m => nullNeeds.includes(m)))
    expect(nullNeeds.every(m => ungatedModels.includes(m as string))).toBe(true)
  })

  test('a custom method on a gated model needs a SESSION, and no more than one', () => {
    // The API boundary's own rule, which this module read none of for its whole
    // first life: `gateAuthAround` grades a custom verb through
    // `customMethodGrade`, and with nothing declared that is the model's read
    // gate as a PRESENCE check — 401 for a stranger, and then no comparison at
    // all. `shipments.recordTracking` is on `Order`, whose read is 1.
    expect(at(0).hid('shipments_recordTracking')).toBe(true)
    expect(at(1).has('shipments_recordTracking')).toBe(true)
    expect(at(1).why('shipments_recordTracking')?.verdict).toBe('method-floor')

    // The level is NOT compared, so `needs` states no number. A projection that
    // reported the read gate here would be claiming a requirement the boundary
    // never holds anyone to.
    expect(at(1).why('shipments_recordTracking')?.needs).toBe(null)

    // The pair that makes the refusal evidence: the SAME caller, one rung up,
    // is admitted — and so is every rung above it, because presence is all
    // there is to clear.
    for (const level of [1, 2, 3, 4, 5, 6, 7, 8]) {
      expect(at(level).has('shipments_recordTracking'), `level ${level}`).toBe(true)
    }

    // And the control one model over: `Cart` declares no gate, so the identical
    // shape of method is `unchecked` and a stranger keeps it. Without this row,
    // a rule that refused every custom method at level 0 passes the above.
    expect(at(0).has('carts_checkout')).toBe(true)
  })

  test('a DECLARED method gate is compared, where the floor is not', () => {
    // The other half of `customMethodGrade`, and the only place a number is
    // graded on a custom verb. `example` declares exactly one — `payments.start`
    // at 0 — so the fixture states the shape rather than borrowing it.
    const services = [
      { name: 'reports', model: 'Cart', methods: ['summarize'], methodGates: { summarize: 5 } },
    ]
    const hid = (level: number) =>
      projectTools(services, VIEWS, level).withheld.some(t => t.name === 'reports_summarize')

    expect(hid(4)).toBe(true)
    expect(hid(5)).toBe(false)
    const row = projectTools(services, VIEWS, 5).tools.find(t => t.name === 'reports_summarize')
    expect(row?.verdict).toBe('method-gate')
    expect(row?.needs).toBe(5)

    // The control: `Cart` declares no `@@gate`, so WITHOUT the declaration this
    // same method is open to a stranger. The refusal above is the declaration's
    // and nothing else's.
    const undeclared = [{ name: 'reports', model: 'Cart', methods: ['summarize'] }]
    expect(projectTools(undeclared, VIEWS, 0).tools.some(t => t.name === 'reports_summarize')).toBe(true)
  })
})

// ─── the controls ─────────────────────────────────────────────────────────────

describe('the projection was really built', () => {

  test('every declared method lands in exactly one of the two lists', () => {
    const declared = SERVICES.flatMap(s => s.methods.map(m => toolName(s.name, m)))
    for (const level of [0, 4, 5, 8]) {
      const p    = projectTools(SERVICES, VIEWS, level)
      const seen = [...p.tools, ...p.withheld].map(t => t.name)
      expect(seen.slice().sort()).toEqual(declared.slice().sort())
      expect(new Set(seen).size).toBe(declared.length)
    }
  })

  test('it narrows monotonically — nothing is lost by climbing', () => {
    // A rule written the wrong way round shows up here and nowhere else.
    let previous = new Set(at(0).tools.map(t => t.name))
    for (const level of [1, 2, 3, 4, 5, 6, 7]) {
      const now = new Set(at(level).tools.map(t => t.name))
      for (const name of previous) expect(now.has(name), `${name} lost at ${level}`).toBe(true)
      previous = now
    }
  })

  test('a method the policy removed does not exist to anybody', () => {
    // `describe().methods` is policy-applied, so the projection never sees it —
    // which is why `example`'s @@gate 9 models never reach the gate at all.
    const narrowed = [{ name: 'ledger', model: 'Ledger', methods: ['find', 'get'] }]
    const p = projectTools(narrowed, VIEWS, 8)
    expect([...p.tools, ...p.withheld].map(t => t.name)).toEqual(['ledger_find', 'ledger_get'])
  })
})

// ─── the trap the fixture did not have ────────────────────────────────────────

describe('the model name a service STATES may not be a model', () => {

  // `Service.model` is optional and Junction defaults it to the service's own
  // name, so a service declaring no `model:` reports `orders` — camelCase,
  // plural, matching no `$def`. Every gate and every move on that model then
  // resolves to undefined, which permissive-unknown reads as *nothing declared*.
  // The most heavily gated service in an app comes out completely open, and
  // nothing fails. The first measurement taken against `example` reported a
  // narrowing with `Order` silently absent from it.
  const AS_JUNCTION_REPORTS_IT: ServiceShape[] = [
    { name: 'orders', model: 'orders', methods: ['find', 'create', 'pay', 'refund'] },
  ]

  test('a stated name that is no definition is resolved through inflect', () => {
    const p = projectTools(AS_JUNCTION_REPORTS_IT, VIEWS, 0)
    expect(p.tools.map(t => t.name)).toEqual([])
    expect(p.withheld.map(t => t.name).sort())
      .toEqual(['orders_create', 'orders_find', 'orders_pay', 'orders_refund'])
    // And the row says which definition decided, not the name that was stated.
    expect(p.withheld[0]?.model).toBe('Order')
  })

  test('the gates and the moves are really applied, not merely found', () => {
    // The pair. The assertion above passes against a projection that withheld
    // everything for any reason at all.
    const p4 = projectTools(AS_JUNCTION_REPORTS_IT, VIEWS, 4)
    expect(p4.tools.map(t => t.name).sort()).toEqual(['orders_create', 'orders_find', 'orders_pay'])
    expect(p4.withheld.map(t => t.name)).toEqual(['orders_refund'])   // @gate 5
    expect(projectTools(AS_JUNCTION_REPORTS_IT, VIEWS, 5).withheld).toEqual([])
  })

  test('the un-resolution is REPORTED, because open and ungoverned look alike', () => {
    // Without this, *no rules exist for these rows* and *the rules could not be
    // found* produce the same tool list and an operator cannot tell which.
    const overNoModel: ServiceShape[] = [
      { name: 'revenue', model: 'revenue', methods: ['find'] },
    ]
    const p = projectTools(overNoModel, VIEWS, 0)
    expect(p.unresolved).toEqual(['revenue'])
    // Not `model-gate`: there is no model and so no gate, and naming one would
    // be the rule this list says decided.
    expect(p.tools[0]?.verdict).toBe('ungraded')
    expect(p.tools[0]?.model).toBe(null)

    // The control: a service whose model DOES resolve reports nothing here.
    expect(projectTools(AS_JUNCTION_REPORTS_IT, VIEWS, 0).unresolved).toEqual([])
  })

  test('over no model a CRUD verb is graded by its declared level, as junction enforces it (FJS-D408)', () => {
    const targets: ServiceShape[] = [
      { name: 'targets', model: 'targets', methods: ['find', 'get', 'remove'], methodGates: { find: 7, remove: 7 } },
    ]
    const at5 = projectTools(targets, VIEWS, 5)
    expect(at5.withheld.map(t => [t.name, t.verdict, t.needs])).toEqual([
      ['targets_find', 'method-gate', 7], ['targets_remove', 'method-gate', 7],
    ])
    expect(at5.tools.map(t => [t.name, t.verdict])).toEqual([['targets_get', 'ungraded']])
    // The pair: at the level, offered.
    expect(projectTools(targets, VIEWS, 7).tools.map(t => t.name).sort())
      .toEqual(['targets_find', 'targets_get', 'targets_remove'])
  })

  test('a stated name that IS a definition is preferred over the derived one', () => {
    // `invoices` states `Invoice` and must not be re-derived — an app may name a
    // service anything, and `singularize` is a guess where a declaration exists.
    const p = projectTools(SERVICES, VIEWS, 8)
    expect(p.unresolved).toEqual([])
    expect([...p.tools, ...p.withheld].every(t => t.model !== null)).toBe(true)
  })
})

// ─── the input schemas ────────────────────────────────────────────────────────

describe('a tool says what to send, or says nothing', () => {

  const tool = (level: number, name: string) => at(level).why(name)

  test('create takes the create view; patch takes an id and the update view', () => {
    const create = tool(4, 'orders_create')
    expect(create?.input.source).toBe('create-mode')
    const cprops = Object.keys((create?.input.schema?.properties ?? {}) as object)
    expect(cprops).toContain('reference')
    expect(cprops).toContain('total')
    expect(create?.input.schema?.required).toContain('reference')

    const patch = tool(4, 'orders_patch')
    expect(patch?.input.source).toBe('update-mode')
    const pprops = (patch?.input.schema?.properties ?? {}) as Record<string, any>
    expect(Object.keys(pprops).sort()).toEqual(['data', 'id'])
    // `id` is the tool's own argument and must not also be a writable change —
    // the update view carries it, so it is stripped from `data`.
    expect(Object.keys(pprops.data.properties)).not.toContain('id')
    expect(Object.keys(pprops.data.properties)).toContain('status')
  })

  test('get, remove and restore take one identifier', () => {
    for (const m of ['get', 'remove']) {
      const t = tool(5, `orders_${m}`)
      expect(t?.input.source, m).toBe('id')
      expect(Object.keys((t?.input.schema?.properties ?? {}) as object)).toEqual(['id'])
    }
  })

  test('find takes filters plus the directive table, read off the kit', () => {
    const t = tool(1, 'orders_find')
    expect(t?.input.source).toBe('query')
    const props = (t?.input.schema?.properties ?? {}) as Record<string, any>
    expect(Object.keys(props).sort()).toEqual(['directives', 'query'])
    // Invariant 10: the `$` is wire syntax and does not survive the bridge, so
    // an in-process argument carries the bare name.
    const names = Object.keys(props.directives.properties)
    expect(names).toContain('limit')
    expect(names).toContain('orderBy')
    expect(names.some(n => n.startsWith('$'))).toBe(false)
  })

  test('the directives are typed off the kit, so a count is not a free-form value', () => {
    const d = ((tool(1, 'orders_find')?.input.schema?.properties ?? {}) as Record<string, any>).directives.properties
    expect(d.limit).toEqual({ type: 'integer' })
    expect(d.withDeleted).toEqual({ type: 'boolean' })
    expect(d.orderBy.type).toBeUndefined()
  })

  test('find names the model\'s columns as filters, each taking its type or an operator', () => {
    const q = ((tool(1, 'orders_find')?.input.schema?.properties ?? {}) as Record<string, any>).query
    expect(Object.keys(q.properties)).toEqual(expect.arrayContaining(['id', 'reference', 'status', 'total', 'note']))
    // The operator half is what keeps the SDK's validator from refusing
    // `{ status: { in: [...] } }`, which the Data boundary takes.
    expect(q.properties.status.anyOf[0].enum).toContain('paid')
    expect(q.properties.status.anyOf[1].type).toBe('object')
    // `@length` says what may be written, and a filter is not a write.
    expect(q.properties.reference.anyOf[0].minLength).toBeUndefined()
    // Open: a relation path or AND/OR is still passable, and the boundary
    // refuses an unknown key by name.
    expect(q.additionalProperties).toBeUndefined()
  })

  test('a column the boundary will not filter on is not offered as a filter', () => {
    // `x-filterable` is a REFUSAL — absent is permitted — so the control is the
    // plain column beside the two refused ones.
    const src    = `model Note {\n  id    Int    @id\n  title String\n  body  String @encrypted\n  slug  String @computed\n  @@gate("1.1.1.1")\n}`
    const views  = schemaViews(parse(src).schema, generateJsonSchema as never)
    const find   = projectTools([{ name: 'notes', model: 'Note', methods: ['find'] }], views, 8).tools[0]
    const cols   = Object.keys(((find?.input.schema?.properties ?? {}) as Record<string, any>).query.properties)
    expect(cols).toEqual(['id', 'title'])
  })

  test('a custom method takes the id AND the declared type, because call() takes both', () => {
    // `ServiceCaller.call(name, id, data, opts)` is the one dispatch path for
    // every non-CRUD verb, so a tool describing only the payload describes a
    // call nobody can make: it has the tracking code and no way to name the
    // order. The declared type is `data`, not the whole argument.
    const t     = tool(4, 'shipments_recordTracking')
    const props = (t?.input.schema?.properties ?? {}) as Record<string, { properties?: object }>
    expect(t?.input.source).toBe('declared-type')
    expect(Object.keys(props)).toEqual(['id', 'data'])
    expect(Object.keys(props.data.properties ?? {})).toEqual(['trackingCode'])
    expect(t?.input.schema?.additionalProperties).toBe(false)
  })

  test('a move takes an id and nothing else', () => {
    // The seed says this outright by declaring the transition on the model: a
    // move acts on one row and its rules live in `@@transitions`. Before this
    // the whole move half of the list carried no argument schema at all, so
    // `orders.refund` was visible, correctly graded, and uncallable.
    const t = tool(5, 'orders_refund')
    expect(t?.input.source).toBe('id')
    expect(Object.keys((t?.input.schema?.properties ?? {}) as object)).toEqual(['id'])
    expect(t?.input.schema?.required).toEqual(['id'])
  })

  test('a custom method with nothing declared still says where the id goes', () => {
    // The pair with the two rows above: same dispatch, and the half the seed is
    // silent about stays open rather than being guessed shut. `additionalProperties`
    // is still false because `call()`'s own shape IS known — it is `data`'s
    // contents that are not, and a closed `data` would make the method
    // uncallable rather than merely undescribed.
    const t     = tool(0, 'carts_checkout')
    const props = (t?.input.schema?.properties ?? {}) as Record<string, { properties?: object }>
    expect(t?.input.source).toBe('call-args')
    expect(Object.keys(props)).toEqual(['id', 'data'])
    expect(props.data.properties).toBeUndefined()
    expect(t?.input.schema?.required).toBeUndefined()
  })

  test('null rather than an empty object schema', () => {
    // `{}` accepts anything, which is a claim. null is the absence of one, and
    // an agent handed `{}` will send something and be refused by the boundary.
    for (const t of [...at(8).tools, ...at(8).withheld]) {
      if (t.input.source === null) expect(t.input.schema, t.name).toBe(null)
      else                         expect(t.input.schema, t.name).not.toBe(null)
    }
  })
})

// ─── the audience ─────────────────────────────────────────────────────────────

describe('a protected column never reaches a tool description', () => {

  test('@secret and @guarded are absent from every schema the projection emits', () => {
    const every = [...at(8).tools, ...at(8).withheld]
    const json  = JSON.stringify(every.map(t => t.input.schema))
    expect(json).not.toContain('value')
    expect(json).not.toContain('scope')
  })

  test('and the ordinary columns of the SAME model survive', () => {
    // The pair, and the row that makes the one above evidence. A projection
    // emitting no schema for `Credential` at all satisfies the absence test and
    // is broken — which is `FJS-976`'s own lesson one realm over.
    const create = at(8).why('credentials_create')
    expect(create?.input.source).toBe('create-mode')
    const props = Object.keys((create?.input.schema?.properties ?? {}) as object)
    expect(props).toContain('label')
    expect(props).not.toContain('value')
    expect(props).not.toContain('scope')
  })

  test('the audience is not reachable through the projection at all', () => {
    // It is not an option and must not become one: `system` puts a password
    // hash and OAuth tokens into a tool description, and it is the tempting
    // default. `schemaViews` owns the three calls.
    const viaSystem = schemaViews(parsed.schema, ((schema: unknown, opts: Record<string, unknown>) => {
      // Even a caller who tries to force it: `schemaViews` overrides.
      expect(opts.audience).toBe('client')
      return generateJsonSchema(schema as never, opts as never)
    }) as never)
    expect(Object.keys(viaSystem.create.Credential.properties as object)).not.toContain('value')
  })
})

// ─── the name, and what a client will accept ──────────────────────────────────

describe('a tool name is one an MCP client will take', () => {

  test('the separator is an underscore, because a dot is refused outright', () => {
    // `^[a-zA-Z0-9_-]{1,128}$`. A dot does not narrow the list, it makes the
    // whole list invalid — so the projection's own spelling has to be the legal
    // one rather than something a transport rewrites on the way out.
    const legal = /^[a-zA-Z0-9_-]{1,128}$/
    const p = at(8)
    for (const t of [...p.tools, ...p.withheld]) {
      expect(legal.test(t.name), t.name).toBe(true)
    }
    expect(toolName('orders', 'refund')).toBe('orders_refund')
  })

  test('the structured halves survive, so nothing has to parse the name back apart', () => {
    const t = at(5).why('orders_refund')
    expect(t?.service).toBe('orders')
    expect(t?.method).toBe('refund')
  })

  test('two methods that derive one name are BOTH withheld, and reported', () => {
    // A dot is not the only illegal character, so two names can meet after the
    // replacement. Keeping either one is the failure: an agent calls the name
    // and which method runs is whichever the client happened to keep.
    const clash = [
      { name: 'pay.runs', model: 'Cart', methods: ['calculate'] },
      { name: 'pay',      model: 'Cart', methods: ['runs_calculate'] },
    ]
    const p = projectTools(clash, VIEWS, 8)
    expect(p.collisions).toEqual([
      { name: 'pay_runs_calculate', methods: ['pay.runs.calculate', 'pay.runs_calculate'] },
    ])
    expect(p.tools.some(t => t.name === 'pay_runs_calculate')).toBe(false)

    // The control: one of the two alone is an ordinary tool. Without this row a
    // rule that dropped every tool would pass.
    const alone = projectTools([clash[0]], VIEWS, 8)
    expect(alone.collisions).toEqual([])
    expect(alone.tools.some(t => t.name === 'pay_runs_calculate')).toBe(true)
  })
})

// ─── the schema an agent is actually handed ───────────────────────────────────

describe('an argument schema resolves on its own', () => {

  test('an enum field carries its values rather than a ref into a document that is gone', () => {
    // A model `$def` is LIFTED out of the generated document to become one
    // tool's input, and `#/$defs/OrderStatus` resolves against the root — which
    // is then the tool schema itself. Left alone the agent gets a pointer to
    // nothing, and no error either.
    const status = ((at(8).why('orders_create')?.input.schema?.properties ?? {}) as Record<string, { enum?: string[]; $ref?: string }>).status
    expect(status.$ref).toBeUndefined()
    expect(status.enum).toContain('refunded')
  })

  test('no ref anywhere in any tool schema points outside that schema', () => {
    // The catch-all: inlining covers enums, and a `Json @type(T)` still emits a
    // ref. Whatever survives must be carried in with its definition.
    for (const t of at(8).tools) {
      const schema = t.input.schema
      if (!schema) continue
      const defs = (schema.$defs ?? {}) as Record<string, unknown>
      const refs: string[] = []
      ;(function walk(n: unknown): void {
        if (Array.isArray(n)) return n.forEach(walk)
        if (!n || typeof n !== 'object') return
        for (const [k, v] of Object.entries(n)) {
          if (k === '$ref' && typeof v === 'string') refs.push(v)
          else walk(v)
        }
      })(schema)
      for (const ref of refs) {
        const name = /^#\/\$defs\/(.+)$/.exec(ref)?.[1]
        expect(name && name in defs, `${t.name} → ${ref}`).toBe(true)
      }
    }
  })

  test('a money column says it is minor units, because the integer alone is a trap', () => {
    // `{"type":"integer","x-money":{...}}` reads as an ordinary number, and the
    // mistake that shape invites is a factor of a hundred on somebody's refund.
    const total = ((at(8).why('orders_create')?.input.schema?.properties ?? {}) as Record<string, { description?: string }>).total
    expect(total.description).toContain('minor units')
    // The SCALE is deliberately absent — the generator declines to resolve it
    // because JPY has none and KWD has three, and a number right two thirds of
    // the time is worse than no number.
    expect(total.description).not.toContain('100')
  })

  test('the model access rules do not ride along in the argument schema', () => {
    // `x-gate` and `x-transitions` are the model's ACCESS RULES. The projection
    // already answered that question by deciding whether this tool is listed at
    // all, and `x-transitions` is the largest keyword on the page — paid for in
    // the context window of every call.
    const schema = at(8).why('orders_create')?.input.schema as Record<string, unknown>
    expect(Object.keys(schema).some(k => k.startsWith('x-'))).toBe(false)
    // The pair: the definition the GATE is read from still carries it, because
    // annotating the generator's own object in place would have stripped the
    // rule out from under the grading.
    expect(DEFS.Order['x-gate']?.read).toBe(1)
  })
})
