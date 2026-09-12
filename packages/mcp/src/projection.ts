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
import { DIRECTIVE_PARAMS }        from '@frontierjs/toolbelt/directives'

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
  system:  boolean
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
}

// ─── what it answers ──────────────────────────────────────────────────────────

/**
 * Which rule decided, named. `model-gate` and `move-floor` are the two that
 * ALLOWED something by clearing a declared number; `ungraded` is the absence of
 * any rule and is never to be read as the first two.
 */
export type Verdict =
  | 'model-gate'    // the model's @@gate position for this operation
  | 'move-floor'    // max(model update, the move's own @gate)
  | 'move-system'   // a @system move — no caller, at any standing
  | 'ungraded'      // nothing in the seed says; permissive by Invariant 6

export interface Tool {
  /** `orders.refund` — the name an agent calls. */
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
  | null              // nothing in the seed describes it

export interface ToolInput {
  schema: Record<string, unknown> | null
  source: InputSource
}

export interface Withheld extends Tool {
  /** `move-system` is absent from every standing; the rest are level-dependent. */
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
}

// CRUD verbs graded by the model's own gate. `aggregate` is a read and `restore`
// is an update; both are in the kit's map, and both are here because a verb this
// set omits falls through to the custom path and is graded as a move that does
// not exist.
const CRUD = new Set([
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
  const at = (mode: string) => defsOf(generate(schema, { mode, audience: 'client' }))
  return {
    full:   at('full') as Record<string, ModelDef>,
    create: at('create'),
    update: at('update'),
  }
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
 * The directive names come from `@frontierjs/toolbelt/directives` — Invariant
 * 10's one table — rather than being spelled here, so a directive the Data
 * realm grows arrives in the tool schema without this file being opened. They
 * are named WITHOUT the `$`, because the prefix is wire syntax and an in-process
 * caller passes `{ directives: { limit } }` (Invariant 10 again: no
 * `$`-prefixed key survives the bridge).
 *
 * `query` is left as a free-form object on purpose. Nothing in the generated
 * schema states which columns are filterable as a positive — `x-filterable`
 * is emitted per field as a NEGATIVE where it applies — so a projection listing
 * filterable keys here would be inventing a whitelist, and the Data boundary
 * refuses an unknown key by name anyway.
 */
function findInput(): JsonSchemaObject {
  const directives: JsonSchemaObject = {}
  for (const name of DIRECTIVE_PARAMS) {
    directives[String(name).replace(/^\$/, '')] = {}
  }
  return {
    type: 'object',
    properties: {
      query:      { type: 'object', title: 'Filters', description: 'Column filters. An unknown key is refused by name at the Data boundary.' },
      directives: { type: 'object', title: 'Directives', properties: directives, additionalProperties: false },
    },
    additionalProperties: false,
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
): ToolInput {
  if (declared) {
    // The `type T { … }` the service named for this method. Already an object
    // schema with `required` and `additionalProperties: false` — which is what
    // an MCP input schema is.
    const t = views.full[declared] as JsonSchemaObject | undefined
    return t ? { schema: t, source: 'declared-type' } : { schema: null, source: null }
  }

  if (method === 'find')                            return { schema: findInput(), source: 'query' }
  if (method === 'get' || method === 'remove' || method === 'restore')
                                                     return { schema: ID_INPUT, source: 'id' }

  if (!model) return { schema: null, source: null }

  if (method === 'create') {
    const c = views.create[model]
    return c ? { schema: c, source: 'create-mode' } : { schema: null, source: null }
  }

  if (method === 'patch' || method === 'update' || method === 'upsert') {
    const u = views.update[model]
    if (!u) return { schema: null, source: null }
    // The caller signature is `patch(id, data, opts)`, so the tool takes both.
    // `data` is the update view minus `id`, which that view carries.
    const { id: _id, ...rest } = (u.properties ?? {}) as Record<string, unknown>
    return {
      schema: {
        type: 'object',
        properties: {
          id:   ID_INPUT.properties && (ID_INPUT.properties as Record<string, unknown>).id,
          data: { type: 'object', title: `${model} changes`, properties: rest, additionalProperties: false },
        },
        required: ['id', 'data'],
        additionalProperties: false,
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
      const base = {
        name: `${svc.name}.${method}`, service: svc.name, method, model,
        input: inputFor(method, model, views, svc.inputs?.[method]),
      }

      if (CRUD.has(method)) {
        // `canAtLevel` owns the method→position map and the sentinels.
        const need = gradedNeed(gate, method)
        const ok   = canAtLevel(gate ?? null, method, level)
        const row  = { ...base, kind: 'crud' as const, verdict: 'model-gate' as const, needs: need }
        ;(ok ? tools : withheld).push(row)
        continue
      }

      const move = declaredMove(def, method)

      if (!move) {
        // Rule 3. Nothing declared — permissive, and LABELLED so. An operator
        // reading this list can see which of their verbs the seed says nothing
        // about, which is the list worth shortening.
        tools.push({ ...base, kind: 'custom', verdict: 'ungraded', needs: null })
        continue
      }

      if (move.system) {
        // A `@system` move is the verb half of LOCKED: `getLevel` is clamped to
        // 7, so no caller passes and only `asSystem()` bypasses. Withheld from
        // every standing, which is the largest subtraction available here.
        withheld.push({ ...base, kind: 'move', verdict: 'move-system', needs: null })
        continue
      }

      const need = moveFloor(gate, move)
      const ok   = need === null ? true : levelPasses(need, level)
      const row  = { ...base, kind: 'move' as const, verdict: 'move-floor' as const, needs: need }
      ;(ok ? tools : withheld).push(row)
    }
  }

  return { level, tools, withheld, unresolved }
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
