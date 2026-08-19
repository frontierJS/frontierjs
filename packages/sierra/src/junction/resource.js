/**
 * @frontierjs/sierra/junction — resource factory
 *
 * Provides:
 *   createResource(serviceName, schema?, opts)  — full 4-phase hook pipeline
 *   createResource({ model, service, ... })     — object form
 *   createMakeFromSchema(properties)            — make() factory from JSON schema
 *   createStore(service, opts)                  — independent store for sub-sets
 *
 * Hook phases — match the API realm exactly:
 *
 *   before  — runs before the network call. Validate, guard, attach context.
 *   after   — runs after a successful call. Transform data, format dates.
 *   around  — wraps the entire operation including the network call.
 *             Natural home for loading state, retry logic, timing.
 *             Receives (ctx, next) — must call next() to continue.
 *   error   — runs when any phase or the network call throws.
 *             Clear ctx.error to recover and return ctx.result instead.
 *
 * Pipeline:
 *   around:enter → before → [network call] → after → around:exit
 *                                  ↓ (on throw)
 *                               error
 *
 * Context shape:
 *   {
 *     service: 'leads',
 *     model:   'Lead',      // UI-only — the Litestone model name
 *     method:  'find' | 'get' | 'create' | 'patch' | 'remove' | 'restore',
 *     id:      string | null,
 *     data:    object | null,
 *     query:   object,      // filters — what travels over the wire
 *     directives: object,   // { limit, offset, orderBy, select, populate } — also the wire
 *     locals:  object,      // per-call scratch — never sent to the server
 *     result:  any,         // populated after a successful call
 *     error:   Error | null // populated in error phase
 *   }
 *
 * locals — per-call scratch:
 *   Fresh {} on every call, and it never leaves the browser. It is how the
 *   phases talk to each other: `before` and `after` are separate functions, so
 *   anything one decides and the next needs has to live somewhere per-call.
 *
 *     before: { all: [ctx => { ctx.locals.startedAt = performance.now() }] },
 *     after:  { all: [ctx => track(ctx.method, performance.now() - ctx.locals.startedAt)] },
 *
 *   A closed-over variable is the wrong shape for that: two find() calls in
 *   flight share it and the second overwrites the first. A whole-call concern
 *   with no hand-off — a loading flag — wants an `around` hook and a signal
 *   instead (see the example below); this is for the hand-off.
 *
 *   It is called `locals` because it is the same noun as Junction's
 *   `ctx.locals`, with the same rule. It was `params`, which made three
 *   different things in this package share one word: path captures
 *   (`page.params`), the wire's directives (the `params` argument below), and
 *   this. `params` now means path captures and nothing else.
 *
 *   ctx.directives is the separate, structured half of the wire request — how
 *   to SHAPE the answer, never which records. Junction's client serialises it
 *   into $limit/$offset/$orderBy/$select/$populate for both HTTP and WebSocket.
 *   Hooks set pagination here, and a view that needs a relation asks for it
 *   here:
 *
 *     before: { find: [ctx => { ctx.directives.limit = 50 }] }
 *
 *   The word is `directives` because that is what the rest of the framework
 *   calls this — `ctx.directives` at the API boundary, `page.directives` off a
 *   URL in this same package, one grammar in `@frontierjs/toolbelt/directives`
 *   (Invariant 10). It was `findParams`, which meant Sierra's own router handed
 *   a view `page.directives` and then made it pass them as `params`.
 *
 * Return shapes — READ THIS BEFORE .map()
 *
 *   The service methods are a PASS-THROUGH of Junction's browser client. What
 *   the API returns is what you get here; Sierra does not reshape it. The rule
 *   is Junction's, stated once and applied everywhere: a list keeps its
 *   envelope (it carries total/limit/offset, which have nowhere else to live),
 *   a single record unwraps to the record.
 *
 *     service.find(query, directives) → ListResult — { kind:'list', object, data, total, limit, offset }
 *     service.getOptions(...)      → ListResult — same, it is a find
 *     service.get(id)              → the record
 *     service.create(data)         → the record
 *     service.patch(id, data)      → the record
 *     service.remove(id)           → the removed record
 *     service.restore(id)          → the record
 *     service.upsert(data)         → the record
 *
 *   So the rows live at `.data`:
 *
 *     const res  = await leads.service.find({}, { limit: 20 })
 *     res.data                     // the rows
 *     res.total                    // total matching, for a pager
 *
 *   The stores hand you rows directly, because a view wants something it can
 *   map over and pagination metadata has no place in a record list:
 *
 *     load(query, directives)      → the rows (and sets store to the rows)
 *     store.get()                  → the rows
 *     createStore(svc).find(...)   → returns the raw result; store.get() is rows
 *
 *   `stale` is the third thing beside them — how many changes the live store
 *   could not place on its own, `0` when the list is as current as a push can
 *   make it. A push can say whether a row is in the query and where it sorts;
 *   it cannot say which row from page 2 slides up when one leaves page 1. Show
 *   it and offer a reload; `load()` clears it:
 *
 *     const { get } = useStore(orders.stale)   // same shape as a store
 *
 *   Reach for `load()`/`store` when you are rendering a list, and for
 *   `service.find()` when you need the count alongside it.
 *
 * Hook registration:
 *   At createResource time:   createResource('leads', schema, { hooks: { ... } })
 *   After creation:           resource.hooks({ error: { all: [handleErrors] } })
 *
 * Example:
 *   createResource('leads', LeadSchema, {
 *     hooks: {
 *       around: {
 *         all: [
 *           async (ctx, next) => {
 *             loading.set(true)
 *             await next()
 *             loading.set(false)
 *           }
 *         ]
 *       },
 *       before: { create: [validateLead] },
 *       after:  { all:    [formatDates]  },
 *       error:  { all:    [handleApiErrors] },
 *     }
 *   })
 */

import { getClient } from '@frontierjs/sierra/junction'
import {
  schemaFor, modelNameFor, serviceNameFor, hasSchemas, allSchemas, resolveRef, suggestModel,
} from './schema-registry.js'
import {
  derefFieldSchema, buildFieldRules, buildRelations, buildGate, canAtLevel,
  buildTransitions, transitionsAt, buildVersion, isStaleWrite, STALE_WRITE_MESSAGE, toConflict,
  validateAgainstFields, normalizeBlanks, coerceToSchema, ResourceValidationError,
  toFieldErrors, controlFor, defaultControlFor, formFieldList, labelFieldFor, matchesQuery,
  registerControl, unregisterControl, registeredControls,
} from './field-rules.js'
import { singularize } from '@frontierjs/toolbelt/inflect'
import { runPhase, runAroundHooks, mergeHooks } from '@frontierjs/toolbelt/hooks'
import { createMakeFromSchema as makeFromSchema } from '@frontierjs/toolbelt/jsonschema'

// Re-exported so `sierra/junction` stays the one import for resource work.
export {
  buildFieldRules, buildRelations, buildGate, canAtLevel,
  buildTransitions, transitionsAt, buildVersion, isStaleWrite, STALE_WRITE_MESSAGE, toConflict,
  validateAgainstFields, normalizeBlanks, coerceToSchema, ResourceValidationError,
  toFieldErrors, controlFor, defaultControlFor, formFieldList, labelFieldFor, matchesQuery,
  registerControl, unregisterControl, registeredControls,
}

// ── Hook runners and createMakeFromSchema ─────────────────────────────────────
//
// Both are `@frontierjs/toolbelt`'s. They were pure, zero-dependency and copied
// into jetty by hand, which is the definition the substrate package wrote for
// itself (`FJS-D26`) and the reason `FJS-059` did not need a fifth published
// package. What did NOT move is `createStore` below and the orchestrator around
// it: a store is state, and a transport is not one fact with two owners.

/**
 * Build a `make()` factory from Litestone JSON schema properties.
 *
 *   const { properties } = jsonSchema.definitions['leads']
 *   const make = createMakeFromSchema(properties)
 *
 * Positional, and `resolve` defaults to this package's registry — the kit takes
 * an options object and no default resolver, because jetty may have no
 * definition table at all.
 *
 * @param {object} properties   — JSON schema properties for the model
 * @param {string[]} [skip]     — server-managed fields to exclude from make()
 * @param {(ref: string) => object|null} [resolve]
 *        `$ref` resolver, defaulting to the registry the build populates.
 * @param {string[]} [foreignKeys]
 *        Columns that are a relation's local key — `x-relations[].fields`. A
 *        belongsTo is emitted as a plain integer, so this cannot be derived
 *        from `properties` alone.
 */
export function createMakeFromSchema(properties, skip, resolve = resolveRef, foreignKeys) {
  return makeFromSchema(properties, { skip, resolve, foreignKeys })
}

// ── createStore ───────────────────────────────────────────────────────────────

/**
 * Create an independent store backed by a service — for filtered sub-sets.
 *
 * Unlike client.resource() which wires WS push events automatically,
 * createStore gives you a manually-populated store you populate
 * on demand with a specific query:
 *
 *   const clientTags = createStore(service, { initial: [] })
 *   clientTags.get = async () => {
 *     const result = await service.find({ type: 'client' })
 *     clientTags.set(Array.isArray(result) ? result : result.data ?? [])
 *   }
 *
 * @param {object} service     — resource service (from createResource)
 * @param {object} [opts]
 * @param {Array}  [opts.initial]  — initial value, default []
 */
export function createStore(service, opts = {}) {
  const { initial = [] } = opts

  let _data = Array.isArray(initial) ? [...initial] : initial
  let _issued = 0
  const _subs = new Set()

  function _notify() {
    for (const fn of _subs) fn(_data)
  }

  const store = {
    get() { return _data },

    subscribe(fn) {
      _subs.add(fn)
      fn(_data)
      return () => _subs.delete(fn)
    },

    set(data) {
      _data = data
      _notify()
    },

    upsert(record, idField = 'id') {
      const idx = _data.findIndex(r => r[idField] === record[idField])
      _data = idx === -1
        ? [..._data, record]
        : [..._data.slice(0, idx), record, ..._data.slice(idx + 1)]
      _notify()
    },

    remove(id, idField = 'id') {
      _data = _data.filter(r => r[idField] !== id)
      _notify()
    },

    // Stamped when issued, so a slower earlier request landing second cannot
    // overwrite newer rows — the same rule junction's resource().load() applies,
    // and for the same reason: this store is shared by everything subscribed to
    // it, while the returned result belongs to the one caller who awaited it.
    async find(query, directives) {
      const stamp = ++_issued
      const result = await service.find(query, directives)
      if (stamp === _issued) store.set(Array.isArray(result) ? result : result?.data ?? [])
      return result
    },
  }

  return store
}

// ── createResource ────────────────────────────────────────────────────────────

/**
 * Create a resource wrapper for a Junction service with a full 4-phase
 * hook pipeline matching the API realm.
 *
 * Signatures:
 *   createResource('leads', LeadSchema, { hooks, idField })   — with schema
 *   createResource('leads', { hooks, schema, idField })       — no schema arg
 *   createResource({ model, service, optionsQuery, hooks })   — object form
 *
 * Returns { service, store, make, load, fields, relations, gate, can,
 *           transitions, validate, normalize, coerce, fieldErrors, context,
 *           hooks }
 *   service  — pass-through of the Junction client: find() gives the list
 *              envelope, single-record methods give the record. See "Return
 *              shapes" in the module header.
 *   store    — holds ROWS, never an envelope. Subscribe for renders.
 *   load     — populates store and resolves to the rows.
 *   make     — schema-seeded factory for a blank record.
 *   fields   — per-field rules from the schema: { type, required, nullable,
 *              enum?, format?, minLength?, … }. Render a select from
 *              `fields.plan.enum`; mark a label from `fields.plan.required`.
 *   validate — validate(data, mode?) → [{ field, message }], empty when fine.
 *   normalize— normalize(data) → the record with '' replaced by null on
 *              nullable fields. See opts.blankToNull.
 *   coerce   — coerce(data) → the record with DOM strings cast to the schema's
 *              declared types. See opts.coerce.
 *   hooks()  — add hooks after creation.
 *
 * ── opts.model ─────────────────────────────────────────────────────────────
 * Which Litestone model this resource is backed by. Defaults to the service
 * name, and the registry knows English's regular plurals, so `leads` → Lead,
 * `companies` → Company and `statuses` → Status all resolve on their own.
 *
 * Name it when they cannot: an irregular plural, or a service deliberately not
 * named after its model.
 *
 *   createResource('people',   { model: 'Person' })
 *   createResource('children', { model: 'Child'  })
 *   createResource('roster',   { model: 'Person' })
 *
 * It also labels `ctx.model` in hooks and `resource.context.model`, so naming it
 * is what makes those read as the model rather than as the service.
 *
 * ── The payload pipeline: coerce → blankToNull → validate ──────────────────
 *
 * All three are ON by default. They were opt-in until 2026-08-06; every one of
 * them is the answer to a thing the DOM does that the schema does not want, so
 * a form that did not set all three sent payloads the schema had already said
 * no to, and the framework knew and stayed quiet. Turning them on is what makes
 * `<Form resource={leads}>` correct with nothing else declared.
 *
 * Each is turned off with an explicit `false`:
 *
 *   createResource('leads', { coerce: false, blankToNull: false, validate: false })
 *
 * Order is fixed and load-bearing — see the note at the call site in _call().
 *
 * **coerce** casts the strings a DOM control produces into the types the schema
 * declares. `el.value` is a string for every control there is — `<input
 * type="number">` and `<select>` included — and Mesa's bindInput passes it
 * through unchanged, correctly, because it has no idea what the field is. So a
 * form bound to make() sends `"42"` for a Float and `"1"` for an Int, and the
 * server (and `validate`) reject both. Only the schema knows what they were
 * meant to be. Turn it off for a resource whose data never comes from a DOM
 * control and whose fields are deliberately loosely typed.
 *
 * **blankToNull** replaces '' with null on nullable fields. A text input cannot
 * produce "no value" — an untouched box submits '' — so without this a form
 * writes '' into a column the schema declared nullable. SQLite does not treat
 * those as the same: `String? @unique` accepts any number of NULLs but rejects
 * a second '', and `WHERE col IS NULL` never matches ''. The form keeps binding
 * to a string; the wire carries the distinction. Turn it off where '' is a real
 * value distinct from null.
 *
 * **validate** runs the schema-derived check before every create and patch,
 * throwing ResourceValidationError instead of making the request. The server
 * validates regardless — Junction derives its rules from the same .lite file —
 * so this is not the thing that says no; it is where the "no" surfaces. On, it
 * is the browser, before a round trip, with a per-field message a form can
 * render. Off, it is a 400 you still have to map. Turn it off for a resource
 * whose service deliberately accepts a shape the model does not describe.
 *
 * Validation runs AFTER the before-hooks, so a hook that completes the record
 * (stamping a tenant id, coercing a field) is reflected in what gets checked. A
 * throw lands in the error phase like any other failure, so an `error` hook can
 * present it or recover from it.
 *
 * With no schema resolved there are no rules, so all three are inert — the
 * "no schema found" warning above is the one that matters, not these.
 */
export function createResource(nameOrSpec, schemaOrOpts = {}, maybeOpts = {}) {
  let serviceName, model, optionsQuery, initialHooks, schema, idField, opts

  if (typeof nameOrSpec === 'string') {
    serviceName = nameOrSpec
    // createResource('leads', schema, opts)  or  createResource('leads', opts)
    if (schemaOrOpts && (schemaOrOpts.$defs || schemaOrOpts.definitions || schemaOrOpts.properties)) {
      // second arg looks like a schema
      opts   = maybeOpts
      schema = schemaOrOpts
    } else {
      // second arg is opts
      opts   = schemaOrOpts
      schema = opts.schema
    }
    initialHooks = opts.hooks    ?? {}
    idField      = opts.idField  ?? 'id'
    model        = opts.model    ?? serviceName
    optionsQuery = opts.optionsQuery
  } else {
    // object form
    opts         = nameOrSpec
    serviceName  = opts.service
    model        = opts.model        ?? serviceName
    optionsQuery = opts.optionsQuery
    initialHooks = opts.hooks        ?? {}
    schema       = opts.schema
    idField      = opts.idField      ?? 'id'
  }

  // The payload pipeline is ON unless the caller says `false` — see the header.
  // `!== false` rather than `?? true` so an explicit `undefined` (a prop threaded
  // through from a component that did not set it) reads as "not stated", not
  // as "off".
  const autoValidate = opts.validate    !== false
  const autoBlank    = opts.blankToNull !== false
  const autoCoerce   = opts.coerce      !== false

  // Whether the caller ASKED, as opposed to inheriting the default. Only an
  // explicit request is worth a warning when there is no schema to act on.
  const askedForPipeline =
    opts.validate === true || opts.blankToNull === true || opts.coerce === true

  // No schema passed — take it from the registry, which Sierra's build fills
  // from db/schema.lite. This is why a resource file names a model and nothing
  // else: hand-writing the field shape here duplicated the .lite file and was
  // the only remaining place the two halves of an app could drift.
  //
  // Tried in order: the explicit model name, the service name, and the
  // conventional singular of the service name — so createResource('leads') and
  // createResource('leads', { model: 'Lead' }) both resolve.
  //
  // `model` is the override for everything the inflection rules cannot reach.
  // The common irregulars are in the table now (`people` does give `Person`),
  // so what is left is genuine ambiguity — `lens` is not the plural of `len`
  // and no rule can know — and a service deliberately named something other
  // than its model ('roster' over `model Person`).
  if (!schema) {
    const singular = singularize(serviceName)

    // Resolve the NAME, not just the shape. `model` defaults to the service
    // name, so without this `ctx.model` on a `statuses` resource read
    // 'statuses' — the service name wearing the label of the model name, which
    // is what this field is documented to be. It also normalises an accessor
    // spelling ({ model: 'person' }) to the declared 'Person'.
    const resolvedName = modelNameFor(model, serviceName, singular)
    if (resolvedName) {
      schema = schemaFor(resolvedName)
      model  = resolvedName
    }

    if (!schema && hasSchemas()) {
      const known   = Object.keys(allSchemas())
      const guess   = suggestModel(model) ?? suggestModel(serviceName)
      const example = guess ?? known[0] ?? 'ModelName'

      console.warn(
        `[resource:${serviceName}] no schema found for '${model}'. ` +
        `make() returns a bare object, fields is empty, and validate() reports nothing.\n` +
        `  Name the model explicitly: ` +
        `createResource('${serviceName}', { model: '${example}' })` +
        (guess ? `   ← '${guess}' looks like the one` : '') + `\n` +
        `  Known models: ${known.join(', ')}`
      )
    }
  }

  const client = getClient()
  if (!client) {
    console.warn(`[resource:${serviceName}] Junction client not ready — returning empty resource`)
    return _emptyResource(serviceName)
  }

  // Live hook map — mutated by resource.hooks() calls
  // Reassigned rather than mutated: `mergeHooks` answers a new map (`FJS-059`).
  let _hooks = mergeHooks({ before: {}, after: {}, around: {}, error: {} }, initialHooks)

  // Schema-driven make() or pass-through.
  //
  // `modelDef` is the definition make() and fields both read: a caller can pass
  // a whole document ($defs/definitions) or a single model definition, and the
  // registry hands back the latter.
  const modelDef = schema?.$defs?.[serviceName]
    ?? schema?.$defs?.[model]
    ?? schema?.definitions?.[serviceName]
    ?? schema?.definitions?.[model]
    ?? schema

  let make
  if (schema) {
    // x-relations is the ONLY place a relation exists on the client — a
    // belongsTo's local key is emitted as a plain integer — so the FK columns
    // have to be handed to make() rather than spotted in `properties`.
    const fkFields = (modelDef?.['x-relations'] ?? []).flatMap(r => r?.fields ?? [])
    make = createMakeFromSchema(modelDef?.properties ?? modelDef, undefined, undefined, fkFields)
  } else {
    make = (spec) => Object.assign({}, spec)
  }

  // Per-field rules — empty when there is no schema, so a resource without one
  // reports no constraints rather than pretending everything is optional.
  const fields    = schema ? buildFieldRules(modelDef)  : {}
  const relations = schema ? buildRelations(modelDef)   : {}
  const gate      = schema ? buildGate(modelDef)        : null
  const stateSpec = schema ? buildTransitions(modelDef) : null
  const versionOf = schema ? buildVersion(modelDef)     : null

  // Junction resource — wires WS push events → store automatically, scoped to
  // the query the store's last load() ran with. `fields` is what turns a wire
  // operand back into the value the column holds, so the matcher is built here
  // and not in Junction, which holds no schema. Declared after the rules for
  // that reason; nothing can push before the first load in any case.
  const junctionResource = client.resource(serviceName, idField, {
    match: (record, query) => matchesQuery(fields, record, query),
  })
  const { store, stale } = junctionResource

  // ── @version — the revision this screen actually read ───────────────────────
  // Litestone refuses a patch on a `@version` model unless it carries the
  // version that was read, so the client has to hand back the one it was given.
  // Kept per record rather than read off `store` because a form usually loads a
  // single record with get(), which does not populate the list store at all.
  //
  // Recorded from READS this resource performed: every call result, and a load
  // that was not superseded. Never from the store, and that is the whole of the
  // rule. A WS push reaches the store as an upsert and moves the number while
  // moving nothing the person is looking at, so a patch from a screen holding a
  // draft carried a revision nobody there had read and won the race the column
  // exists to lose — the other writer's change erased, with the guard in place
  // and no error anywhere.
  //
  // The cost is a 409 where a silent success used to be, and that 409 is the
  // correct answer: this screen is submitting values from an older revision. A
  // caller who has genuinely read the newer one sends it — an explicit version
  // always wins, and <Form record={row}> already edits the row whole.
  const _versions = new Map()

  function _rememberVersions(result) {
    if (!versionOf || !result) return
    const rows = Array.isArray(result) ? result
      : Array.isArray(result?.data) ? result.data
      : [result]
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const id = row[idField]
      if (id != null && Number.isInteger(row[versionOf])) _versions.set(id, row[versionOf])
    }
  }

  /**
   * Would the given level clear this model's gate for that operation?
   * A UI affordance only — see canAtLevel. The server enforces regardless.
   */
  function can(operation, level) {
    return canAtLevel(gate, operation, level)
  }

  /**
   * The record's legal next states, each flagged with whether `level` may take
   * it — the button list, straight off the schema. A UI affordance only; see
   * transitionsAt. Returns [] when the model declares no `@@transitions`.
   */
  function transitions(row, level) {
    return transitionsAt(stateSpec, row, level)
  }

  /**
   * Check a record against the schema. Always available; enforced automatically
   * unless the resource was created with `validate: false`.
   */
  function validate(data, mode = 'create') {
    return validateAgainstFields(fields, data, mode)
  }

  /**
   * Replace `''` with `null` on nullable fields. Always available; applied
   * automatically unless the resource was created with `blankToNull: false`.
   */
  function normalize(data) {
    return normalizeBlanks(fields, data)
  }

  /**
   * Cast the strings a DOM control produces into the schema's declared types.
   * Always available; applied automatically unless created with `coerce: false`.
   */
  function coerce(data) {
    return coerceToSchema(fields, data)
  }

  /**
   * Whatever a failed call threw → `{ fields, message }`, ready to hand to a
   * form. `fields` is keyed by field name for `<Field errors={…}>`.
   *
   * On the resource rather than only as a free function because a form has the
   * resource in hand and should not need to know which of the three wrapper
   * shapes it is unwrapping — that is one translation, and this is its owner.
   * `<Form>` calls exactly this.
   */
  function fieldErrors(err) {
    return toFieldErrors(err)
  }

  // Only when the caller explicitly asked. The three are on by default now, so
  // warning on the default would fire for every schemaless resource in the app
  // and say nothing the "no schema found for X" warning above has not already
  // said louder.
  if (!schema && askedForPipeline) {
    const on = [
      opts.validate    === true && 'validate',
      opts.blankToNull === true && 'blankToNull',
      opts.coerce      === true && 'coerce',
    ].filter(Boolean)
    console.warn(
      `[resource:${serviceName}] ${on.join(' / ')} set, but no schema resolved — ` +
      `there are no field rules to act on, so nothing will happen.`
    )
  }

  // ── _call — full 4-phase pipeline ──────────────────────────────────────────

  async function _call(method, id, data, query = {}, directives = {}) {
    const ctx = {
      service: serviceName,
      model,
      method,
      id:      id   ?? null,
      data:    data ?? null,
      query:   query,        // travels over the wire
      directives,            // limit / offset / orderBy / select — also the wire
      locals:  {},           // per-call scratch — never sent to server
      result:  null,
      error:   null,
    }

    // Collect around hooks for this method
    const aroundList = [
      ...(_hooks.around?.all     ?? []),
      ...(_hooks.around?.[method] ?? []),
    ]

    async function inner() {
      // before
      await runPhase(_hooks, 'before', method, ctx)

      // Blank → null and pre-flight validation — both opt-in, both after the
      // before-hooks: a hook that stamps a tenant id or coerces a field is part
      // of the payload, and acting on the pre-hook data would reject or rewrite
      // records the server would have accepted.
      //
      // Normalisation runs first so validation judges what will actually be
      // sent, not an intermediate form of it.
      // Coercion first: '' must still look blank to normalize() below, and
      // Number('') is 0 — so this deliberately leaves empty strings alone.
      if (autoCoerce && (method === 'create' || method === 'patch')) {
        ctx.data = coerce(ctx.data)
      }

      if (autoBlank && (method === 'create' || method === 'patch')) {
        ctx.data = normalize(ctx.data)
      }

      if (autoValidate && (method === 'create' || method === 'patch')) {
        const problems = validate(ctx.data, method === 'create' ? 'create' : 'patch')
        if (problems.length) throw new ResourceValidationError(serviceName, problems)
      }

      // @version rides along on a patch. A caller who set it explicitly wins —
      // that is someone doing their own concurrency control. With no remembered
      // version the patch goes up without one and the server says so, which is
      // a better failure than inventing a number that would silently win a race.
      if (versionOf && method === 'patch' && ctx.data && typeof ctx.data === 'object'
          && ctx.data[versionOf] == null) {
        const known = _versions.get(ctx.id)
        if (known != null) ctx.data = { ...ctx.data, [versionOf]: known }
      }

      // network call
      const proxy = client.service(serviceName)
      switch (method) {
        case 'find':    ctx.result = await proxy.find(ctx.query, ctx.directives);          break
        case 'get':     ctx.result = await proxy.get(ctx.id ?? ctx.query, ctx.directives); break
        case 'create':  ctx.result = await proxy.create(ctx.data);          break
        case 'patch':   ctx.result = await proxy.patch(ctx.id, ctx.data);   break
        case 'remove':  ctx.result = await proxy.remove(ctx.id);            break
        case 'restore': ctx.result = await proxy.restore(ctx.id);           break
        // A custom service method — anything the server declared that is not
        // CRUD. invoke() applies the same transport rule as every other service
        // call: the socket when one is connected, HTTP when it is not.
        //
        // This used to call proxy.call(), the explicit WS escape hatch. That was
        // WS-or-nothing by name, and with no socket it recursed inside the
        // client and never settled. `call` is still on the proxy below for a
        // caller that wants to force the socket.
        default:        ctx.result = await proxy.invoke(method, ctx.id, ctx.data, ctx.query); break
      }

      // Record before the after-hooks, so a hook that reads the version off the
      // resource sees the one that just came back rather than the previous read.
      _rememberVersions(ctx.result)

      // after
      await runPhase(_hooks, 'after', method, ctx)
    }

    try {
      await runAroundHooks(aroundList, ctx, inner)
    } catch (err) {
      ctx.error = err

      const errorList = [
        ...(_hooks.error?.all     ?? []),
        ...(_hooks.error?.[method] ?? []),
      ]

      if (errorList.length) {
        for (const hook of errorList) await hook(ctx)
        // error hook cleared ctx.error — treat as recovered
        if (!ctx.error) return ctx.result
      }

      throw ctx.error ?? err
    }

    return ctx.result
  }

  // ── service proxy ──────────────────────────────────────────────────────────

  // params is Junction's FindParams — { limit, offset, orderBy, select,
  // populate }. It is
  // threaded to the client proxy, which serializes it for whichever transport
  // is live. It used to be accepted here and dropped on the floor, so paging an
  // ordered list through a resource silently returned the server's default page.
  const service = {
    find:    (query, directives) => _call('find',    null,      null,  query ?? {}, directives ?? {}),
    get:     (id, directives)    => _call('get',     id,        null,  {},          directives ?? {}),
    create:  (data)          => _call('create',  null,          data,  {}),
    patch:   (id, data)      => _call('patch',   id,            data,  {}),
    remove:  (id)            => _call('remove',  id,            null,  {}),
    restore: (id)            => _call('restore', id,            null,  {}),

    /** create if no id, patch if has id */
    upsert: (data) => data[idField]
      ? _call('patch',   data[idField], data, {})
      : _call('create',  null,          data, {}),

    /**
     * fetch options list — uses optionsQuery by default.
     * optionsQuery is `{ query, params }`; params carries the FindParams a
     * select list usually wants (orderBy: 'name', a limit above the default page).
     */
    getOptions: (query, directives) => _call(
      'find', null, null,
      query  ?? optionsQuery?.query  ?? {},
      directives ?? optionsQuery?.directives ?? {},
    ),

    /**
     * Call a custom service method by name — one the server declared that is
     * not CRUD.
     *
     *   orders.service.invoke('pay', 3)
     *   → POST /api/orders/3   X-Service-Method: pay
     *
     * `id` may be null for a call about the whole COLLECTION rather than one
     * row, which posts to the service root:
     *
     *   servers.service.invoke('feed', null, null, { limit: 50 })
     *   → POST /api/servers?limit=50   X-Service-Method: feed
     *
     * The server has always supported that — the bridge dispatches on the
     * X-Service-Method header before it looks at `params.id` — but this layer
     * interpolated the id unconditionally, so the only way to reach one was to
     * invent a throwaway id and post to `/{service}/null`.
     *
     * Runs the resource's hook pipeline like any other call. Coercion,
     * blank-stripping and validation are deliberately NOT applied: those are
     * defined against the model's own fields for create/patch payloads, and an
     * method's body is whatever that method declares.
     */
    invoke: (name, id, data, query) => _call(name, id ?? null, data ?? null, query ?? {}),

    /** real-time push event subscription */
    on:   (event, fn) => client.service(serviceName).on(event, fn),

    /** explicit WS call (bypasses HTTP) */
    call: (method, id, data) => client.service(serviceName).call(method, id, data),
  }

  // context — metadata for hooks and components
  const context = { model, service: serviceName, idField }

  // load() — HTTP find + populates store.
  //
  // Its rows count as a read by this screen, so their versions are recorded —
  // but only when the load was not superseded, which is the same stamp junction
  // applies to the store itself (`FJS-082`): a slower first request still
  // returns its rows to the caller that awaited them and must not leave their
  // versions behind as current. The stamp is repeated here rather than read off
  // junction because a store notification carries no provenance — a set() from
  // a winning load and an upsert() from a WS push arrive as the same event, and
  // only one of the two is something this screen read.
  //
  // The query becomes the store's filter for as long as those rows are in it: a
  // pushed record outside it is not added, and one a patch has just moved out of
  // it is removed (`FJS-011`). A record the schema cannot judge — a `select`
  // that dropped the filtered column, a filter over a relation — reloads rather
  // than being guessed at.
  let _loadIssued = 0
  async function load(query, directives) {
    const stamp = ++_loadIssued
    const rows  = await junctionResource.load(query ?? {}, directives)
    if (stamp === _loadIssued) _rememberVersions(rows)
    return rows
  }

  /**
   * The version this resource last READ for a record — the value a patch will
   * carry. `null` when the model declares no `@version`, or when nothing has
   * been read yet.
   *
   * A WS push does not move it. Nothing on this screen has read the pushed
   * revision, and answering with it is what erased a concurrent write.
   *
   * Exported for the case a component wants to show it, or wants to pass an
   * explicit one after resolving a conflict by hand.
   */
  function version(idOrRow) {
    if (!versionOf) return null
    const id = idOrRow != null && typeof idOrRow === 'object' ? idOrRow[idField] : idOrRow
    return _versions.get(id) ?? null
  }

  /**
   * The two revisions behind a stale write — what this screen submitted, and
   * what the row is at now — or `null` for any other failure. What a *reload /
   * overwrite* prompt needs, where `fieldErrors()` gives the sentence.
   */
  function conflict(err) { return toConflict(err) }

  // hooks() — add hooks after creation, merged in order
  function addHooks(incoming) {
    _hooks = mergeHooks(_hooks, incoming)
  }

  // ── The generated form ──────────────────────────────────────────────────────
  //
  // The field SET is the last thing a form still restates about a model, and
  // these two are what let a component stop restating it. They live on the
  // resource rather than in the UI kit on purpose: `@frontierjs/ui` peers only
  // on mesa and css, so a form component that had to import Sierra to know
  // which control a `Float` gets would invert the dependency. It asks the
  // resource instead, and the table itself has one home in field-rules.js.

  /**
   * Every writable field of this model, in schema order, each with the control
   * it gets. `only` narrows and reorders, `except` removes.
   *
   * An entry whose `control` is null is still IN the list, carrying a `reason`
   * — an array column, a `Json` document, a name that is not a field. Dropping
   * those quietly is exactly the failure a generated form is supposed to end:
   * a column that never appears and nothing saying so.
   */
  function formFields(opts) {
    // The model name travels with the list: a registered control is handed
    // `{ field, model }`, which is what lets an app claim `Order.notes` rather
    // than every markdown column in the app.
    return formFieldList(fields, { ...opts, model })
  }

  // One request per (field, query) for the life of the resource. A form with
  // three pickers over the same model still asks three times — they are three
  // different columns and may be filtered differently — but a re-render does
  // not ask again, which is what a component looping over fields would do.
  const _options = new Map()

  /**
   * The rows a foreign key's picker offers — `[{ value, label }]`.
   *
   * The relation already says which model answers (`x-relations` → `references`),
   * the registry says which service that model is served under, and the related
   * model's own fields say which column a person recognises. So a picker over
   * `customerId` needs no name written anywhere:
   *
   *   const rows = await orders.options('customerId')
   *
   * `labelField` states the shown column, `query`/`directives` are passed to the
   * related service's `getOptions`, and `reload: true` bypasses the cache.
   *
   * A field with no relation answers `[]` and says why — it is a question with
   * no meaning, not an empty list.
   */
  function options(fieldName, { labelField, query, directives, limit = 100, reload = false } = {}) {
    const ref = fields?.[fieldName]?.references
    if (!ref) {
      console.warn(
        `[${serviceName}] options('${fieldName}') — that field is not a foreign key, so there is ` +
        'nothing to offer. A picker comes from a relation; check the name against the model.',
      )
      return Promise.resolve([])
    }

    const key = `${fieldName}|${JSON.stringify(query ?? null)}|${labelField ?? ''}`
    if (!reload && _options.has(key)) return _options.get(key)

    const relatedService = serviceNameFor(ref.model) ?? ref.model
    const related        = createResource(relatedService, { model: ref.model })
    const shown          = labelField ?? labelFieldFor(related.fields, ref.field)

    const pending = related.service
      .getOptions(query ?? {}, directives ?? { limit, orderBy: shown })
      .then(res => {
        const rows = Array.isArray(res) ? res : (res?.data ?? [])
        return rows.map(row => ({
          value: row?.[ref.field],
          // The id is the honest fallback: a blank option is unpickable and a
          // guessed label is worse than a number.
          label: row?.[shown] ?? row?.[ref.field],
        }))
      })
      .catch(err => {
        // A picker whose rows fail to load must not take the form down with it.
        // The field still renders, empty, and the failure is said out loud.
        console.warn(`[${serviceName}] options('${fieldName}') failed — ${err?.message ?? err}`)
        _options.delete(key)
        return []
      })

    _options.set(key, pending)
    return pending
  }

  return {
    service, store, stale, make, load,
    fields, relations, gate, can, transitions, validate, normalize, coerce,
    version, versionField: versionOf, conflict,
    formFields, options,
    fieldErrors, context, hooks: addHooks,
  }
}

// ── Empty resource fallback ───────────────────────────────────────────────────

function _emptyResource(name) {
  const noop = () => Promise.reject(new Error(`[${name}] Junction client not available`))
  return {
    service: {
      find: noop, get: noop, create: noop, patch: noop,
      remove: noop, restore: noop, upsert: noop,
      on: () => {}, call: noop, getOptions: noop,
    },
    store:   { get: () => [], subscribe: fn => { fn([]); return () => {} }, set: () => {}, upsert: () => {}, place: () => {}, remove: () => {} },
    stale:   { get: () => 0, subscribe: fn => { fn(0); return () => {} }, bump: () => {}, reset: () => {} },
    make:    (spec) => Object.assign({}, spec),
    load:    async () => [],
    fields:    {},
    relations: {},
    formFields: () => [],
    options:    () => Promise.resolve([]),
    gate:        null,
    can:         () => true,
    transitions: () => [],
    validate:  () => [],
    normalize: (data) => data,
    coerce:    (data) => data,
    version:      () => null,
    versionField: null,
    conflict:     (err) => toConflict(err),
    fieldErrors: (err) => toFieldErrors(err),
    context: { model: name, service: name, idField: 'id' },
    hooks:   () => {},
  }
}
