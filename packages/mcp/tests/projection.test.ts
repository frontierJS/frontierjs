/*
 * tests/projection.test.ts — what one standing sees, and what decided
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
import { projectTools, schemaViews } from '../src/projection.ts'
import type { ServiceShape } from '../src/projection.ts'

// ─── the fixture, parsed ──────────────────────────────────────────────────────
//
// `tests/fixtures/shop.lite` says why it is real source rather than a `$defs`
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
    expect(p.hid('orders.find')).toBe(true)
    expect(p.why('orders.find')?.needs).toBe(1)
    expect(p.hid('orders.create')).toBe(true)
    expect(p.why('orders.create')?.needs).toBe(4)
  })

  test('the same tools appear for a caller who clears them', () => {
    // The pair. Without this, a projection returning nothing passes above.
    const p = at(4)
    expect(p.has('orders.create')).toBe(true)
    expect(p.has('orders.patch')).toBe(true)
    expect(p.hid('orders.remove')).toBe(true)    // delete: 5
    expect(at(5).has('orders.remove')).toBe(true)
  })

  test('read: 1 withholds from a stranger and admits a visitor', () => {
    // The pair for the row above. One rung, and the whole service appears.
    expect(at(0).hid('orders.find')).toBe(true)
    expect(at(1).has('orders.find')).toBe(true)
    expect(at(1).has('orders.get')).toBe(true)
  })
})

describe('LOCKED is reachable by nobody — the shape example has not got', () => {

  test('a level-9 position admits no standing, SYSTEM included', () => {
    for (const level of [0, 4, 5, 6, 7, 8]) {
      const p = at(level)
      expect(p.hid('ledger.patch'),  `patch at ${level}`).toBe(true)
      expect(p.hid('ledger.remove'), `remove at ${level}`).toBe(true)
    }
  })

  test('and the same model still answers its reads, or the row proves nothing', () => {
    // The pair. A projection that dropped `Ledger` entirely satisfies the test
    // above and is broken.
    expect(at(5).has('ledger.find')).toBe(true)
    expect(at(5).has('ledger.get')).toBe(true)
    expect(at(4).hid('ledger.find')).toBe(true)  // read: 5
  })

  test('create: 8 admits SYSTEM and refuses SYSADMIN', () => {
    // The sentinel that IS reachable: 8 is not a rung, so the highest human
    // standing is refused and only the application itself passes.
    expect(at(8).has('ledger.create')).toBe(true)
    expect(at(7).hid('ledger.create')).toBe(true)
    expect(at(8).why('ledger.create')?.needs).toBe(8)
    // The pair, so the row is not satisfied by a projection that hid everything.
    expect(at(7).has('ledger.find')).toBe(true)
  })
})

// ─── the half the gate says nothing about ─────────────────────────────────────

describe('a declared move grades the verb that drives it', () => {

  test('a move with no gate of its own takes the model update level', () => {
    expect(at(0).hid('orders.pay')).toBe(true)
    expect(at(4).has('orders.pay')).toBe(true)
    expect(at(4).has('orders.ship')).toBe(true)
    expect(at(4).why('orders.pay')?.needs).toBe(4)
    expect(at(4).why('orders.pay')?.verdict).toBe('move-floor')
  })

  test('a gated move takes the HIGHER of the two, not its own number', () => {
    // orders.refund — @gate 5 over update 4. The move's number wins.
    expect(at(4).hid('orders.refund')).toBe(true)
    expect(at(5).has('orders.refund')).toBe(true)
    expect(at(5).why('orders.refund')?.needs).toBe(5)
  })

  test('invoices.void needs 8, because the MODEL is written at 8', () => {
    // The regression that measurement found. Grading by the move's own @gate 5
    // offers this at STAFF, two rungs under what the boundary accepts — the one
    // mistake here that misleads a caller about its own permissions rather than
    // merely wasting a turn.
    expect(at(5).hid('invoices.void')).toBe(true)
    expect(at(7).hid('invoices.void')).toBe(true)
    expect(at(8).has('invoices.void')).toBe(true)
    expect(at(8).why('invoices.void')?.needs).toBe(8)

    // The negative control for the floor: taking the move's number alone.
    const naive = Math.min(8, 5)
    expect(naive).toBe(5)
    expect(at(naive).has('invoices.void')).toBe(false)
  })

  test('a @system move takes the same floor as any move — @system is whose decision, not how senior', () => {
    // `FJS-D150`: the method lifts @system on the CALLER's client, which keeps
    // the gate. Withheld from every standing, `example`'s `invoices.settle`
    // was hidden from the staff who press it.
    expect(at(3).hid('orders.lapse')).toBe(true)
    expect(at(4).has('orders.lapse')).toBe(true)
    expect(at(4).why('orders.lapse')?.verdict).toBe('move-floor')
    expect(at(4).why('orders.lapse')?.needs).toBe(4)

    // The control: on a model written at 8 the same attribute still leaves the
    // move to the application alone, because the FLOOR says so.
    expect(at(7).hid('invoices.issue')).toBe(true)
    expect(at(8).has('invoices.issue')).toBe(true)
    expect(at(8).why('invoices.issue')?.needs).toBe(8)
  })
})

describe('what the seed does not say is labelled, not guessed', () => {

  test('a custom method backed by no declared move stays visible and is marked', () => {
    const p = at(0)
    expect(p.has('carts.checkout')).toBe(true)
    expect(p.why('carts.checkout')?.verdict).toBe('ungraded')
    expect(p.why('carts.checkout')?.needs).toBe(null)
  })

  test('carts at STRANGER is CORRECT and a fix must not tighten it', () => {
    // A guest basket is owned by a caller with no session, through a claim.
    // `example`'s verify:cart exists to prove it. A rule that withheld
    // everything at level 0 would read as a tightening and break the storefront.
    const p = at(0)
    expect(p.has('carts.find')).toBe(true)
    expect(p.has('carts.open')).toBe(true)
    expect(p.withheld.filter(t => t.service === 'carts')).toEqual([])
  })

  test('ungraded is not filed with the rules that actually cleared a number', () => {
    // *Nothing refused this* and *a rule allowed it* are different facts, and a
    // verdict that conflated them would make the list useless as evidence.
    const p = at(0)
    const graded = p.tools.filter(t => t.verdict === 'model-gate' || t.verdict === 'move-floor')
    const open   = p.tools.filter(t => t.verdict === 'ungraded')
    // Spans models on purpose: `recordTracking` is a custom method on the most
    // heavily gated model here and still ungraded, because it drives no declared
    // move. Ungraded is about the METHOD, never about the model's own rules.
    expect(open.map(t => t.name).sort())
      .toEqual(['carts.checkout', 'carts.open', 'shipments.recordTracking'])
    // And a graded tool with no NUMBER is exactly a model that declares no
    // gate — asserted as a set against the schema rather than by naming the
    // models, or the row goes stale the moment the fixture grows one.
    const ungatedModels = Object.keys(DEFS).filter(m => !DEFS[m]?.['x-gate']).sort()
    const nullNeeds = [...new Set(graded.filter(t => t.needs === null).map(t => t.model))].sort()
    expect(nullNeeds).toEqual(ungatedModels.filter(m => nullNeeds.includes(m)))
    expect(nullNeeds.every(m => ungatedModels.includes(m as string))).toBe(true)
  })
})

// ─── the controls ─────────────────────────────────────────────────────────────

describe('the projection was really built', () => {

  test('every declared method lands in exactly one of the two lists', () => {
    const declared = SERVICES.flatMap(s => s.methods.map(m => `${s.name}.${m}`))
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
    expect([...p.tools, ...p.withheld].map(t => t.name)).toEqual(['ledger.find', 'ledger.get'])
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
      .toEqual(['orders.create', 'orders.find', 'orders.pay', 'orders.refund'])
    // And the row says which definition decided, not the name that was stated.
    expect(p.withheld[0]?.model).toBe('Order')
  })

  test('the gates and the moves are really applied, not merely found', () => {
    // The pair. The assertion above passes against a projection that withheld
    // everything for any reason at all.
    const p4 = projectTools(AS_JUNCTION_REPORTS_IT, VIEWS, 4)
    expect(p4.tools.map(t => t.name).sort()).toEqual(['orders.create', 'orders.find', 'orders.pay'])
    expect(p4.withheld.map(t => t.name)).toEqual(['orders.refund'])   // @gate 5
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
    expect(p.tools[0]?.verdict).toBe('model-gate')
    expect(p.tools[0]?.model).toBe(null)

    // The control: a service whose model DOES resolve reports nothing here.
    expect(projectTools(AS_JUNCTION_REPORTS_IT, VIEWS, 0).unresolved).toEqual([])
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
    const create = tool(4, 'orders.create')
    expect(create?.input.source).toBe('create-mode')
    const cprops = Object.keys((create?.input.schema?.properties ?? {}) as object)
    expect(cprops).toContain('reference')
    expect(cprops).toContain('total')
    expect(create?.input.schema?.required).toContain('reference')

    const patch = tool(4, 'orders.patch')
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
      const t = tool(5, `orders.${m}`)
      expect(t?.input.source, m).toBe('id')
      expect(Object.keys((t?.input.schema?.properties ?? {}) as object)).toEqual(['id'])
    }
  })

  test('find takes filters plus the directive table, read off the kit', () => {
    const t = tool(1, 'orders.find')
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

  test('a custom method with a declared type gets that type', () => {
    const t = tool(4, 'shipments.recordTracking')
    expect(t?.input.source).toBe('declared-type')
    expect(Object.keys((t?.input.schema?.properties ?? {}) as object)).toEqual(['trackingCode'])
    // A declared `type` already closes itself, which is what an MCP input is.
    expect(t?.input.schema?.additionalProperties).toBe(false)
    expect(t?.input.schema?.required).toEqual(['trackingCode'])
  })

  test('a custom method with nothing declared says nothing, and says so', () => {
    // The pair with the row above: same shape of method, opposite answer,
    // because one is written down in the seed and the other is not.
    const t = tool(0, 'carts.checkout')
    expect(t?.input.source).toBe(null)
    expect(t?.input.schema).toBe(null)
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
    const create = at(8).why('credentials.create')
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
