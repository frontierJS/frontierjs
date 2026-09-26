/*
 * projection.ts — the tool list, derived from the seed and narrowed by a standing.
 *
 * An MCP server's hard problem is not exposing tools, it is SCOPING them. A
 * hand-written one invents an authorization story from nothing, usually as prose
 * in a system prompt. Here the story is already written: `@@gate` on a model,
 * `@gate` on a declared move, and the method policy on the service. This module
 * reads those three and answers what one standing may see.
 *
 * ── It is an AFFORDANCE and the boundary is elsewhere ────────────────────────
 *
 * Invariant 6. Litestone enforces at the Data boundary whatever this answers, so
 * a tool wrongly SHOWN is a wasted turn and a 403, never an escalation. That
 * asymmetry is why unknowns are permissive — but it is not a licence to guess,
 * because the two mistakes are not symmetrical in the other direction either:
 *
 *   showing a tool the boundary refuses   → a turn burned, and jailbreak surface
 *   withholding one the caller may use    → an agent that cannot do the work
 *   claiming a LOWER need than the truth  → the only one that misleads a CALLER
 *                                           about what it is allowed to do
 *
 * The third is the one this module is arranged around, and `example` is what
 * found it: `invoices.void` declares `@gate 5` on a model whose `update` is 8.
 * A move's gate is a FLOOR on top of the model's update level, never a
 * replacement for it, so grading by the move's own number offers that tool two
 * rungs below what the boundary accepts.
 *
 * ── Every answer says what graded it ─────────────────────────────────────────
 *
 * `FJS-D230`'s line, one realm over: a surface that previews at a standing must
 * say what decided. So nothing here returns a bare boolean — a tool carries the
 * rule that admitted it and a withheld one carries the rule that refused it. An
 * ungraded tool is labelled ungraded rather than quietly grouped with the ones a
 * gate actually cleared, because *nothing refused this* and *a rule allowed it*
 * are different facts and only one of them is evidence.
 */

import { levelPasses, canAtLevel } from '@frontierjs/toolbelt/gate'
import { modelName }               from '@frontierjs/toolbelt/inflect'
import { DIRECTIVE_SCHEMAS }       from '@frontierjs/toolbelt/directives'
// The one rule this module may not own a copy of. `gateAuthAround` asks
// `customMethodGrade` what stands between a caller and a custom method, and a
// projection that answered that question a second way would be the fifth copy
// of a gate rule in this repo — which is the disease `FJS-D197` named. It is a
// pure function of two plain records, so importing it costs the fixture
// nothing.
import { customMethodGrade }       from '@frontierjs/junction/litestone'

// ─── what it reads ────────────────────────────────────────────────────────────

/** A model's `@@gate`, as `generateJsonSchema` emits it. */
export interface ModelGate {
  read?:   number
  create?: number
  update?: number
  delete?: number
}

/** One declared move, as `x-transitions` emits it. */
export interface DeclaredMove {
  from:    string[]
  to:      string
  gate:    number | null
}

/**
 * The half of a model definition this module reads. Deliberately not the whole
 * `$def`: a projection that took the generated document wholesale would be free
 * to start depending on any keyword in it, and the three it is allowed to grade
 * on are the point.
 */
export interface ModelDef {
  'x-gate'?:        ModelGate
  'x-transitions'?: Record<string, Record<string, DeclaredMove>>
}

/** The half of `describe()` this module reads. */
export interface ServiceShape {
  name:    string
  model:   string
  /** Policy already applied — a method absent here does not exist to anybody. */
  methods: string[]
  /**
   * The `type` in the seed each method's payload must satisfy, keyed by method
   * — `describe().inputs`. The one place a custom method's argument shape is
   * written down; 7 of `example`'s 38 services declare any.
   */
  inputs?: Record<string, string>
  /**
   * The level a custom method declared in `methods: [{ method, gate }]`, keyed
   * by method — `describe().methodGates`.
   *
   * The fourth input, and the projection ran without it for its whole first
   * life. A method that declares a number is the ONE place the API boundary
   * compares a caller's standing on a custom verb, and reading three inputs
   * where the boundary reads four is how a tool list offers what the boundary
   * refuses.
   */
  methodGates?: Record<string, number>
}

// ─── what it answers ──────────────────────────────────────────────────────────

/**
 * Which rule decided, named. `model-gate` and `move-floor` are the two that
 * ALLOWED something by clearing a declared number; `ungraded` is the absence of
 * any rule and is never to be read as the first two.
 */
export type Verdict =
  | 'model-gate'    // the model's @@gate position for this operation
  | 'move-floor'    // max(model update, the move's own @gate), @system or not
  | 'method-gate'   // the level the service declared for this custom method
  | 'method-floor'  // a SESSION is required and the level is not compared
  | 'ungraded'      // nothing says; permissive by Invariant 6

export interface Tool {
  /**
   * `orders_refund` — the name an agent calls.
   *
   * An underscore rather than the dot this app writes everywhere else, because
   * a tool name is matched against `^[a-zA-Z0-9_-]{1,128}$` and a dot is
   * refused: the whole list would be rejected, not the one tool. It is derived
   * here rather than mapped at the transport so that one name exists — a
   * projection that answered `orders.refund` and a transport that offered
   * `orders_refund` is two vocabularies for one thing, and the second is the
   * only one anybody can call.
   *
   * `service` and `method` beside it are the structured truth; nothing should
   * parse this back apart.
   */
  name:    string
  service: string
  method:  string
  /** The `$def` that graded this, or `null` for a service over no model. */
  model:   string | null
  kind:    'crud' | 'move' | 'custom'
  /** What decided, and the level it cleared. `null` where nothing was declared. */
  verdict: Verdict
  needs:   number | null
  /**
   * The JSON Schema for this tool's argument, and where it came from.
   *
   * `null` where the seed does not describe one — a custom method with no
   * declared input type, or `aggregate`, whose spec is an allow-list rather
   * than a shape. Reported as null rather than as `{}`: an empty object schema
   * accepts anything, which is a claim, where null is the absence of one.
   */
  input:   ToolInput
}

export type InputSource =
  | 'create-mode'     // the model at mode: 'create'
  | 'update-mode'     // an id plus the model at mode: 'update'
  | 'declared-type'   // the `type T { … }` the service named for this method
  | 'id'              // one identifier
  | 'query'           // filters plus the directive table
  | 'call-args'       // `call(id, data)`'s shape, with the payload undescribed
  | null              // nothing in the seed describes it

export interface ToolInput {
  schema: Record<string, unknown> | null
  source: InputSource
}

export interface Withheld extends Tool {
  verdict: Exclude<Verdict, 'ungraded'>
  needs:   number | null
}

export interface Projection {
  level:    number
  tools:    Tool[]
  withheld: Withheld[]
  /**
   * Services whose `model` named no definition, by the name they stated.
   *
   * Reported rather than logged, because it is the difference between *this app
   * declares no rules for these rows* and *this projection could not find the
   * rules that exist*, and those two produce the same open tool list. An
   * operator has to be able to ask.
   */
  unresolved: string[]
  /**
   * Tool names more than one method derives, and the methods that derived them.
   *
   * Every colliding tool is held out of `tools` rather than the loser being
   * dropped. Two tools under one name is a list an agent cannot use correctly:
   * it calls the name and which method runs is decided by whichever one the
   * client happened to keep. Fail closed and report — the other way fails open
   * and says nothing.
   */
  collisions: Array<{ name: string; methods: string[] }>
}

/**
 * The MCP name for one method.
 *
 * `^[a-zA-Z0-9_-]{1,128}$` is the whole rule and a dot fails it, so the
 * separator this framework uses everywhere else cannot be used here. Anything
 * else outside the set is replaced rather than deleted, so two names that
 * differed only by an illegal character still differ — and if a replacement or
 * the length cap does make two names meet, `projectTools` refuses both.
 */
export function toolName(service: string, method: string): string {
  return `${service}_${method}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 128)
}

// CRUD verbs graded by the model's own gate. `aggregate` is a read and `restore`
// is an update; both are in the kit's map, and both are here because a verb this
// set omits falls through to the custom path and is graded as a move that does
// not exist.
export const CRUD = new Set([
  'find', 'get', 'aggregate',
  'create', 'update', 'patch', 'upsert', 'restore',
  'remove',
])

/**
 * Find the declared move a custom method drives, by NAME.
 *
 * A match is a convention rather than a declaration — nothing in the seed says
 * `orders.refund` is the method that runs `Order.status`'s `refund` move — and
 * the reason that is acceptable here is the DIRECTION it can be wrong in. Every
 * custom method is permissive without this lookup, so a match can only ever
 * narrow: a wrong one withholds a tool that was callable, which is the
 * affordance failure, and it cannot widen anything. The inverse convention
 * would not be safe and is not attempted.
 *
 * A move is searched across every machine on the model, because a model may
 * declare more than one `@@transitions` field and the method name does not say
 * which.
 */
function declaredMove(def: ModelDef | undefined, method: string): DeclaredMove | null {
  const machines = def?.['x-transitions']
  if (!machines) return null
  for (const moves of Object.values(machines)) {
    if (Object.hasOwn(moves, method)) return moves[method] as DeclaredMove
  }
  return null
}

/**
 * The level a declared move actually requires.
 *
 * `max(model.update, move.gate)` — Litestone's catalog: *a `@gate(N)` on a move
 * is a floor on top of the model update level*. Either half alone is wrong in a
 * different direction, and only one of those directions is visible from this
 * app: `invoices.void` is `@gate 5` on a model whose `update` is 8.
 */
function moveFloor(gate: ModelGate | undefined, move: DeclaredMove): number | null {
  const update = typeof gate?.update === 'number' ? gate.update : null
  if (typeof move.gate !== 'number') return update
  return update === null ? move.gate : Math.max(update, move.gate)
}

/**
 * Which `$def` a service's rows come out of.
 *
 * **`describe().model` cannot be trusted to be a model**, and this is the trap
 * that makes the whole projection quietly wrong rather than broken. `Service.model`
 * is optional and Junction defaults it to the service's own NAME, so a service
 * that declares no `model:` reports `orders` — camelCase and plural, matching no
 * `$def` at all. Every gate, every transition and every `@system` move on that
 * model then resolves to `undefined`, which the permissive-unknown rule reads as
 * *nothing is declared*: the most heavily gated service in an app is the one that
 * comes out completely open. `example`'s `orders` is exactly that shape, and the
 * first measurement taken here reported a narrowing with `Order` silently absent
 * from it.
 *
 * So the name is resolved the way Invariant 2's three resolvers already agree on
 * — `modelName` from `@frontierjs/toolbelt/inflect`, `pascal(singularize(name))`
 * — and the stated value is preferred only when it actually names a definition.
 */
export function resolveModel(stated: string, defs: Record<string, ModelDef>): string | null {
  if (Object.hasOwn(defs, stated)) return stated
  const derived = modelName(stated)
  return Object.hasOwn(defs, derived) ? derived : null
}

// ─── the input schemas ────────────────────────────────────────────────────────

/**
 * The three views of the schema a tool list needs, generated HERE.
 *
 * **The audience is not a parameter and must not become one.** `client` omits
 * `@guarded` and `@secret` columns; `system` includes them. Handing an agent a
 * `system`-audience schema puts the password hash and the OAuth tokens into the
 * TOOL DESCRIPTION — disclosed before any call is made, to a caller whose whole
 * job is to read what it is given. Measured on `example`: `Credential` carries
 * three extra properties at `system` (`value`, `accessToken`, `refreshToken`)
 * and `Session` carries `token`.
 *
 * It is also the tempting default, which is the reason this function exists
 * rather than an option. *The agent acts for the application, so give it what
 * the application knows* is the sentence, and `FJS-976` is what it costs one
 * realm over: Studio's table dump defaulted to `asSystem()` and shipped
 * protected columns in plaintext for as long as nobody was made to choose. A
 * caller who can pass the audience is a caller who can get this wrong in a way
 * no test of theirs would show, so the projection takes the SCHEMA and owns the
 * three calls.
 */
export interface SchemaViews {
  full:   Record<string, ModelDef>
  create: Record<string, JsonSchemaObject>
  update: Record<string, JsonSchemaObject>
}

type JsonSchemaObject = Record<string, unknown>

function defsOf(js: unknown): Record<string, JsonSchemaObject> {
  const doc = js as { $defs?: Record<string, JsonSchemaObject>; definitions?: Record<string, JsonSchemaObject> }
  return doc.$defs ?? doc.definitions ?? {}
}

/**
 * Read the schema three ways, at the one audience an agent may be given.
 *
 * `generate` is passed in rather than imported so this module keeps no
 * dependency on Litestone — the API realm may depend on the Data realm, but a
 * projection that imported the generator would also be choosing its version.
 */
export function schemaViews(
  schema:   unknown,
  generate: (schema: unknown, opts: Record<string, unknown>) => unknown,
): SchemaViews {
  // `inlineEnums` is not a style preference. A model's `$def` is lifted OUT of
  // the generated document to become one tool's input schema, and a `$ref` to
  // `#/$defs/OrderStatus` resolves against the document ROOT — which, once
  // lifted, is the tool schema itself. Left alone, every enum field points at a
  // definition the agent was never given: no values, and no error either.
  // `attachRefs` below is the same repair for the refs inlining does not cover.
  const at = (mode: string) => defsOf(generate(schema, { mode, audience: 'client', inlineEnums: true }))
  return {
    full:   at('full') as Record<string, ModelDef>,
    create: at('create'),
    update: at('update'),
  }
}

// ─── from a `$def` to a tool's argument schema ────────────────────────────────

/**
 * What a `@money` column means, in words an agent can act on.
 *
 * The column is a whole number of MINOR units and nothing in the generated
 * schema says so: `total` arrives as `{"type":"integer","x-money":{}}`, which
 * reads as an ordinary integer. The mistake that shape invites is a factor of a
 * hundred on a refund, in the direction of the customer's money.
 *
 * The SCALE is deliberately not stated. `jsonschema.js` declines to resolve it
 * — JPY has no minor unit and KWD has three — and a number that is right two
 * thirds of the time is worse here than an absent one. So the description says
 * which currency when the column states one, names the sibling column when the
 * currency is per row, and otherwise says only what is certainly true.
 */
function moneyNote(x: unknown): string {
  const spec = (x ?? {}) as { currency?: string; field?: string }
  if (spec.currency) return `A whole number of ${spec.currency} minor units, not a decimal amount.`
  if (spec.field)    return `A whole number of minor units, not a decimal amount. The currency is in this row's \`${spec.field}\`.`
  return 'A whole number of minor units (the app\'s default currency), not a decimal amount.'
}

/**
 * Turn one model definition into a tool's argument schema.
 *
 * Three things happen and each is a defect if it does not:
 *
 *   1. `x-money` becomes a `description`, because the keyword means nothing to
 *      an MCP client and the integer alone is a trap.
 *   2. Every `x-` keyword is then dropped. They are Litestone's vocabulary for
 *      a Litestone reader; `x-gate` and `x-transitions` in particular are the
 *      model's ACCESS RULES, and an argument schema is not where a caller's
 *      permissions belong — the projection already answered that question by
 *      deciding whether this tool is in the list at all. `x-transitions` is
 *      also the largest keyword on the page, paid for in the context window of
 *      every call.
 *   3. Whatever `$ref`s survive are carried in with their definitions.
 *
 * The clone is not optional: these objects are the generator's, shared with
 * `views.full`, which is what GRADES. Annotating in place would strip `x-gate`
 * off the definition the gate is read from.
 */
function toolSchema(def: JsonSchemaObject | undefined, all: Record<string, JsonSchemaObject>): JsonSchemaObject | null {
  if (!def) return null
  return attachRefs(rewrite(def), all)
}

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite)
  if (!node || typeof node !== 'object') return node

  const out: JsonSchemaObject = {}
  const src = node as JsonSchemaObject
  for (const [key, value] of Object.entries(src)) {
    if (key === 'x-money') {
      const note = moneyNote(value)
      out.description = typeof src.description === 'string' ? `${src.description} ${note}` : note
      continue
    }
    if (key.startsWith('x-')) continue
    if (key === 'description' && typeof out.description === 'string') continue  // moneyNote already merged it
    out[key] = rewrite(value)
  }
  return out
}

/**
 * Carry in the definitions a lifted schema still points at.
 *
 * Walks its own output, because a definition pulled in can name another —
 * a `Json @type(T)` whose field is itself typed. A ref naming something the
 * document does not define is left alone rather than faked: a dangling ref is
 * at least visible, where an invented `{}` accepts anything.
 */
function attachRefs(schema: unknown, all: Record<string, JsonSchemaObject>): JsonSchemaObject {
  const needed: Record<string, JsonSchemaObject> = {}
  const seen   = new Set<string>()

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    for (const [key, value] of Object.entries(node as JsonSchemaObject)) {
      if (key === '$ref' && typeof value === 'string') {
        const name = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(value)?.[1]
        if (name && !seen.has(name)) {
          seen.add(name)
          const target = all[name]
          if (target) {
            needed[name] = rewrite(target) as JsonSchemaObject
            visit(needed[name])
          }
        }
        continue
      }
      visit(value)
    }
  }

  visit(schema)
  const out = schema as JsonSchemaObject
  return Object.keys(needed).length ? { ...out, $defs: { ...(out.$defs as object ?? {}), ...needed } } : out
}

/** One identifier, for `get`, `remove` and `restore`. */
const ID_INPUT: JsonSchemaObject = {
  type:       'object',
  properties: { id: { type: ['string', 'number'], title: 'Id' } },
  required:   ['id'],
  additionalProperties: false,
}

/**
 * `find`'s argument: filters, plus the directives.
 *
 * The directives and their value schemas come from
 * `@frontierjs/toolbelt/directives` — Invariant 10's one table — rather than
 * being spelled here, so a directive the Data realm grows arrives typed in the
 * tool schema without this file being opened. They are named WITHOUT the `$`,
 * because the prefix is wire syntax and an in-process caller passes
 * `{ directives: { limit } }`.
 *
 * `query` lists the model's scalar columns and stays OPEN. `x-filterable` is a
 * refusal — absent means permitted — so every scalar without it is a column
 * the boundary filters on, and naming them invents no whitelist; what is not
 * listed (a relation path, `AND`/`OR`) is still passable, and the Data boundary
 * refuses an unknown key by name. Each column takes its value OR an operator
 * object, because the SDK validates before dispatch and a column typed as its
 * value alone would refuse `{ status: { in: [...] } }`, which the boundary
 * takes. Which operators exist is Litestone's and is not restated here.
 */
function findInput(def: JsonSchemaObject | undefined): JsonSchemaObject {
  return {
    type: 'object',
    properties: {
      query:      { type: 'object', title: 'Filters', description: 'Column filters: each column takes its own type or an operator object. An unknown key is refused by name at the Data boundary.', ...filterColumns(def) },
      directives: { type: 'object', title: 'Directives', properties: { ...DIRECTIVE_SCHEMAS }, additionalProperties: false },
    },
    additionalProperties: false,
  }
}

const SCALAR   = new Set(['string', 'number', 'integer', 'boolean'])
const OPERATOR = { type: 'object', description: 'An operator, such as { in: [...] } or { gte: 5 }.' }

// Validation keywords are dropped: `@length(3, 20)` says what may be WRITTEN,
// and a filter on `contains: "ab"` is not a write.
function filterColumns(def: JsonSchemaObject | undefined): { properties?: JsonSchemaObject } {
  const fields = (def?.properties ?? {}) as Record<string, JsonSchemaObject>
  const out: JsonSchemaObject = {}
  for (const [name, field] of Object.entries(fields)) {
    if (field['x-filterable'] !== undefined) continue
    const value = scalarOf(field)
    if (!value) continue
    out[name] = { ...(field.title ? { title: field.title } : {}), anyOf: [value, OPERATOR] }
  }
  return Object.keys(out).length ? { properties: out } : {}
}

// A nullable column is `anyOf [T, null]`; its filter value is T or null.
function scalarOf(field: JsonSchemaObject): JsonSchemaObject | null {
  const alt = (field.anyOf ?? field.oneOf) as JsonSchemaObject[] | undefined
  if (alt) {
    const kept = alt.filter(a => a.type !== 'null')
    const one  = kept.length === 1 ? scalarOf(kept[0]!) : null
    return one ? { anyOf: [one, { type: 'null' }] } : null
  }
  const types = ([] as unknown[]).concat(field.type ?? [])
  if (!types.length || !types.every(t => SCALAR.has(t as string) || t === 'null')) return null
  return { type: field.type, ...(field.enum ? { enum: field.enum } : {}), ...(field.format ? { format: field.format } : {}) }
}

/**
 * `call(name, id, data, opts)`'s two arguments, as one object schema.
 *
 * A MOVE takes an id and is required to: it acts on one row, and the seed says
 * so by declaring the transition on that model. It takes no payload unless the
 * service declared an input type — `example` states this outright, that its four
 * order moves take an id and nothing else, because a move's rules live in
 * `@@transitions` where every other rule about the row lives.
 *
 * A custom method that declared no input type is the one shape the seed is
 * silent about, and `data` is left a free-form object rather than omitted, for
 * the same reason `find`'s `query` is: the Data boundary refuses an unknown key
 * by name, so an open object costs a refusal where a CLOSED one costs a method
 * that cannot be called at all. `id` is optional there — a custom verb over a
 * collection is an ordinary shape.
 */
function callInput(views: SchemaViews, declared: string | undefined, isMove: boolean): ToolInput {
  const idProp = (ID_INPUT.properties as Record<string, unknown>).id
  const data   = declared
    ? toolSchema(views.full[declared] as JsonSchemaObject | undefined, views.full as Record<string, JsonSchemaObject>)
    : null

  if (isMove && !data) {
    return { schema: ID_INPUT, source: 'id' }
  }

  // `$defs` belongs on the root of the schema that carries the `$ref`, and the
  // root is this wrapper rather than the declared type.
  const { $defs, ...body } = (data ?? {}) as JsonSchemaObject
  return {
    schema: {
      type: 'object',
      properties: {
        id: idProp,
        data: data
          ? body
          : { type: 'object', description: 'The payload for this method. Nothing in the seed describes its shape; an unknown key is refused by name at the Data boundary.' },
      },
      ...(isMove ? { required: ['id'] } : {}),
      additionalProperties: false,
      ...($defs ? { $defs } : {}),
    },
    source: data ? 'declared-type' : 'call-args',
  }
}

/**
 * The argument schema for one tool.
 *
 * Every branch either names a source or answers null. There is no fallback that
 * invents a shape, because a tool described with the wrong argument schema is
 * worse than one described with none: an agent retries against a claim.
 */
function inputFor(
  method:   string,
  model:    string | null,
  views:    SchemaViews,
  declared: string | undefined,
  kind:     Tool['kind'],
): ToolInput {
  // Everything that is not a CRUD verb is dispatched through
  // `ServiceCaller.call(name, id, data, opts)`, so both halves of that signature
  // have to reach the tool schema. A move whose input named only its declared
  // type, or nothing at all, described a call an agent cannot make: it has the
  // payload and no way to say WHICH ROW.
  if (kind !== 'crud') return callInput(views, declared, kind === 'move')

  if (method === 'find')                            return { schema: findInput(model ? views.full[model] as JsonSchemaObject | undefined : undefined), source: 'query' }
  if (method === 'get' || method === 'remove' || method === 'restore')
                                                     return { schema: ID_INPUT, source: 'id' }

  if (!model) return { schema: null, source: null }

  if (method === 'create') {
    const c = toolSchema(views.create[model], views.create)
    return c ? { schema: c, source: 'create-mode' } : { schema: null, source: null }
  }

  if (method === 'patch' || method === 'update' || method === 'upsert') {
    const u = toolSchema(views.update[model], views.update)
    if (!u) return { schema: null, source: null }
    // The caller signature is `patch(id, data, opts)`, so the tool takes both.
    // `data` is the update view minus `id`, which that view carries.
    const { id: _id, ...rest } = (u.properties ?? {}) as Record<string, unknown>
    // `$defs` rides on the ROOT of a schema, and the root here is the wrapper
    // rather than the model — a ref left behind on the inner object resolves
    // against a document that no longer has the definitions.
    const { $defs } = u as { $defs?: object }
    return {
      schema: {
        type: 'object',
        properties: {
          id:   ID_INPUT.properties && (ID_INPUT.properties as Record<string, unknown>).id,
          data: { type: 'object', title: `${model} changes`, properties: rest, additionalProperties: false },
        },
        required: ['id', 'data'],
        additionalProperties: false,
        ...($defs ? { $defs } : {}),
      },
      source: 'update-mode',
    }
  }

  // `aggregate` lands here and answers null deliberately: its spec is an
  // allow-list of operators rather than a shape the schema describes, and a
  // guess at it would be a claim about what the boundary accepts.
  return { schema: null, source: null }
}

/**
 * The tools one standing sees, and the ones it does not, each with its reason.
 *
 * `services` is `describe()` per mounted service and `defs` is
 * `generateJsonSchema(schema)`'s definitions — the same document the browser
 * gets, so nothing here is a second read of the schema.
 */
export function projectTools(
  services: ServiceShape[],
  views:    SchemaViews,
  level:    number,
): Projection {
  const defs = views.full
  const tools:      Tool[]     = []
  const withheld:   Withheld[] = []
  const unresolved: string[]   = []

  for (const svc of services) {
    const model = resolveModel(svc.model, defs)
    const def   = model ? defs[model] : undefined
    const gate  = def?.['x-gate']
    if (!model) unresolved.push(svc.model)

    for (const method of svc.methods) {
      // `model` rather than `svc.model`, so the row says which definition
      // graded it. `null` is a service over no model at all, which is a whole
      // category — `revenue`, `shopfront` — and not an error.
      const ident = {
        name: toolName(svc.name, method), service: svc.name, method, model,
      }

      if (CRUD.has(method)) {
        // `canAtLevel` owns the method→position map and the sentinels.
        const need = gradedNeed(gate, method)
        const ok   = canAtLevel(gate ?? null, method, level)
        const row  = {
          ...ident, kind: 'crud' as const, verdict: 'model-gate' as const, needs: need,
          input: inputFor(method, model, views, svc.inputs?.[method], 'crud'),
        }
        ;(ok ? tools : withheld).push(row)
        continue
      }

      // Two checks stand in front of one custom verb and they are enforced by
      // different realms, so both are read and the STRICTER wins:
      //
      //   the API boundary   `customMethodGrade` — a declared `gate:`, else the
      //                      model's read gate as a PRESENCE check
      //   the Data boundary  the move's own floor, when the method drives one
      //
      // `@system` is not part of either. It says whose DECISION a move is, and
      // the method that lifts it does so on the caller's client with
      // `{ system: true }`, which keeps the gate and every row policy
      // (`FJS-D150`). Withholding a `@system` move from every standing hid
      // `example`'s `invoices.settle` from the staff who press it.
      const move     = declaredMove(def, method)
      const api      = customMethodGrade(method, svc.methodGates ?? {}, (gate ?? null) as never)
      const moveNeed = move ? moveFloor(gate, move) : null

      // Only a number the boundary COMPARES goes in here. `floor` is deliberately
      // absent: its level is the model's read gate and nothing is graded against
      // it, so carrying it as `needs` would state a requirement no caller is
      // actually held to — the one mistake this module is arranged against.
      const compared: Array<[Verdict, number]> = []
      if (api.source === 'declared' && typeof api.level === 'number') compared.push(['method-gate', api.level])
      if (moveNeed !== null)                                          compared.push(['move-floor', moveNeed])

      const top      = compared.sort((a, b) => b[1] - a[1])[0] ?? null
      const presence = api.source === 'floor' && (api.level ?? 0) > 0
      const kind     = move ? 'move' as const : 'custom' as const
      const base     = { ...ident, kind, input: inputFor(method, model, views, svc.inputs?.[method], kind) }

      if (top && top[1] > 0) {
        const [verdict, needs] = top
        const ok = levelPasses(needs, level)
        ;(ok ? tools : withheld).push({ ...base, verdict, needs })
        continue
      }

      if (presence) {
        // A session, and nothing more. `gateAuthAround` answers 401 here and
        // never compares a level: how far above `read` a caller stands is the
        // Data boundary's question. Level 0 is the only thing a projection can
        // read as *no session*.
        const ok = level > 0
        ;(ok ? tools : withheld).push({ ...base, verdict: 'method-floor', needs: null })
        continue
      }

      // Nothing declared — permissive, and LABELLED so. An operator reading this
      // list can see which of their verbs nothing says anything about, which is
      // the list worth shortening.
      tools.push({ ...base, verdict: top ? top[0] : 'ungraded', needs: top ? top[1] : null })
    }
  }

  return { level, ...refuseCollisions(tools), withheld, unresolved }
}

/**
 * Hold back every tool whose name another tool also derived.
 *
 * Only the offered list is checked. A withheld tool is not on offer, so two of
 * them sharing a name is nothing an agent can call; reporting it would be a
 * finding about rows nobody can reach.
 */
function refuseCollisions(tools: Tool[]): { tools: Tool[]; collisions: Projection['collisions'] } {
  const byName = new Map<string, Tool[]>()
  for (const tool of tools) {
    const seen = byName.get(tool.name)
    seen ? seen.push(tool) : byName.set(tool.name, [tool])
  }

  const collisions: Projection['collisions'] = []
  for (const [name, group] of byName) {
    if (group.length > 1) collisions.push({ name, methods: group.map(t => `${t.service}.${t.method}`) })
  }
  if (!collisions.length) return { tools, collisions }

  const refused = new Set(collisions.map(c => c.name))
  return { tools: tools.filter(t => !refused.has(t.name)), collisions }
}

/** The number a CRUD verb clears, for disclosure. `null` where none is declared. */
function gradedNeed(gate: ModelGate | undefined, method: string): number | null {
  if (!gate) return null
  const pos =
    method === 'create'                                  ? 'create' :
    method === 'remove'                                  ? 'delete' :
    (method === 'find' || method === 'get' || method === 'aggregate') ? 'read' :
    'update'
  const need = gate[pos as keyof ModelGate]
  return typeof need === 'number' ? need : null
}
