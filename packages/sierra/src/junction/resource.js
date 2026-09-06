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
 *   to SHAPE the answer, never which records. Junction's client serializes it
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
  schemaFor, updateSchemaFor, modelNameFor, serviceNameFor, hasSchemas, allSchemas, resolveRef, suggestModel,
} from './schema-registry.js'
import {
  derefFieldSchema, buildFieldRules, buildRelations, buildGate, canAtLevel,
  buildTransitions, transitionsAt, buildVersion, isStaleWrite, STALE_WRITE_MESSAGE, toConflict,
  validateAgainstFields, normalizeBlanks, coerceToSchema, stripReadOnly, ResourceValidationError, ResourceHookError,
  toFieldErrors, controlFor, defaultControlFor, formFieldList, labelFieldFor, labelFieldInfo, matchesQuery, sealedFor,
  registerControl, unregisterControl, registeredControls,
} from './field-rules.js'
import { singularize } from '@frontierjs/toolbelt/inflect'
import { runPhase, runAroundHooks, mergeHooks, hookContext, answered } from '@frontierjs/toolbelt/hooks'
import { createMakeFromSchema as makeFromSchema } from '@frontierjs/toolbelt/jsonschema'

// Re-exported so `sierra/junction` stays the one import for resource work.
export {
  buildFieldRules, buildRelations, buildGate, canAtLevel,
  buildTransitions, transitionsAt, buildVersion, isStaleWrite, STALE_WRITE_MESSAGE, toConflict,
  validateAgainstFields, normalizeBlanks, coerceToSchema, stripReadOnly, ResourceValidationError, ResourceHookError,
  toFieldErrors, controlFor, defaultControlFor, formFieldList, labelFieldFor, labelFieldInfo, matchesQuery, sealedFor,
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

// The two `labelFieldInfo` tiers that are guesses rather than conventions. A
// model whose display column came from either has not said which one it is.
const WEAK_LABEL = new Set(['scan', 'fallback'])

// How many read rows one resource keeps as a patch baseline. Nothing reads more
// than one at a time; the cap is here so a list screen paging a large table
// cannot grow the map for the life of the tab. A miss costs a patch that
// carries the whole record, which is what every patch carried before.
const READ_CACHE_MAX = 200

// ── The identity epoch ────────────────────────────────────────────────────────
//
// **Nothing a resource holds may outlive the person it was read for.**
//
// A Resource is created once, at import, in a resource file's `<script module>`
// (Invariant 18), so everything it caches lives for the life of the TAB while
// the principal is a thing that changes inside it — a sign-out, a "switch
// account" button, a shared terminal, a support agent. Three caches were on the
// wrong side of that line and all three are read before anything asks the
// server again:
//
//   the live store  — a mounted list renders the previous person's rows until
//                     their own `load()` resolves, and a layout that loads once
//                     and outlives navigations makes that window arbitrarily long
//   `_read`         — `version(id)` answers a revision the current caller never
//                     read, which is the provenance failure `FJS-341` is about
//   `_options`      — worse than a window, because a picker never asks again:
//                     the second caller is offered a row their own row policy
//                     hides, by id and by label, which for a `Customer` is a
//                     person's name. Steady state, not a race.
//
// This package already learned the rule once and wired half of it:
// `_tokenChanged` calls `invalidatePrefetch()` for `FJS-041` — *a payload
// prefetched as somebody else must not be served to whoever is here now* — and
// the three siblings were never joined to it (`FJS-786`).
//
// **The cache stays useful WITHIN a session**, which is the half a fix that
// simply deleted it would fail: an epoch is bumped on a change of identity and
// on nothing else, so a second render inside one session is still a hit and
// costs no request.
//
// Sierra's junction module calls this from `_tokenChanged`. It is exported
// rather than subscribed to from here because this module holds no client:
// `getClient()` is imported from there, and a listener registered in the other
// direction would be a second owner of *when the identity changed*.
const _liveResources = new Set()

/**
 * Drop everything every live resource is holding on behalf of the previous
 * principal — the live store, the remembered revisions, the cached picker
 * lists, and the ids this resource has read.
 *
 * Called on a token change, in either direction. Not on a reconnect and not on
 * a navigation: those do not change who is asking.
 */
export function resetResourcesForIdentityChange() {
  for (const reset of _liveResources) {
    try { reset() } catch (err) {
      // One resource must not stop the others being cleared, and a resource
      // left holding the previous person's rows is exactly the failure this
      // exists to end — so it is said out loud rather than swallowed.
      console.warn(`[resource] could not clear a resource on the identity change — ${err?.message ?? err}`)
    }
  }
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
 * Returns { service, store, make, load, save, fields, relations, gate, can,
 *           transitions, validate, normalize, coerce, fieldErrors, context,
 *           hooks }
 *   service  — pass-through of the Junction client: find() gives the list
 *              envelope, single-record methods give the record. See "Return
 *              shapes" in the module header.
 *   store    — holds ROWS, never an envelope. Subscribe for renders.
 *   load     — populates store and resolves to the rows.
 *   make     — schema-seeded factory for a blank record.
 *   save     — write a record: create when the model's id field is absent,
 *              patch when it is present. The one owner of that decision — see
 *              save() below. `<Form>` calls exactly this.
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
 * ── opts.detailQuery / opts.optionsQuery ───────────────────────────────────
 * The two reads a resource answers for its own callers, declared once beside
 * the model rather than restated per call site. Both are `{ query, directives }`
 * — filters, and how much of the answer in what order (Invariant 10).
 *
 *   detailQuery  — what `get(id)` asks for when the caller states no
 *                  directives: the include/select shape a detail view needs.
 *   optionsQuery — what `getOptions()` asks for: the thin list a picker wants,
 *                  usually `{ directives: { orderBy: 'name', limit: 500 } }`.
 *
 * Named `detailQuery` rather than the plain `query` the shape was read from,
 * because `query` means FILTERS everywhere else in this repo and a key that
 * means two things at one boundary is the trap Invariant 10 exists to close.
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
 *
 * **`model: null`** turns that warning off, and it is a statement rather than a
 * mute: this service has no model. A resource over a status read, a
 * cross-tenant tier or a projection built from several tables has nothing in
 * the schema to resolve, and saying so is what keeps the warning meaningful
 * for the resource that is merely misspelt.
 */
export function createResource(nameOrSpec, schemaOrOpts = {}, maybeOpts = {}) {
  let serviceName, model, optionsQuery, detailQuery, initialHooks, schema, idField, opts

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
    detailQuery  = opts.detailQuery
  } else {
    // object form
    opts         = nameOrSpec
    serviceName  = opts.service
    model        = opts.model        ?? serviceName
    optionsQuery = opts.optionsQuery
    detailQuery  = opts.detailQuery
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

  // `model: null` is a service DECLARING that it has no model — a status read
  // over configuration, a tier that answers across tenants, a projection
  // assembled from several tables. It is not the same as a model the rules
  // failed to find, which is what the warning below exists for, and without a
  // way to say it every such resource warns on every boot forever: the app
  // that has three of them teaches everyone to read past the one warning that
  // means something.
  const modelless = opts.model === null

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
  // The UPDATE-mode definition of the same model, when the registry has one.
  // A schema passed by hand carries one mode and this stays null, which reads
  // as *the two modes agree* — the behavior before `FJS-807`.
  let updateModel = null

  if (!schema) {
    const singular = singularize(serviceName)

    // Resolve the NAME, not just the shape. `model` defaults to the service
    // name, so without this `ctx.model` on a `statuses` resource read
    // 'statuses' — the service name wearing the label of the model name, which
    // is what this field is documented to be. It also normalizes an accessor
    // spelling ({ model: 'person' }) to the declared 'Person'.
    const resolvedName = modelNameFor(model, serviceName, singular)
    if (resolvedName) {
      schema      = schemaFor(resolvedName)
      updateModel = updateSchemaFor(resolvedName)
      model       = resolvedName
    }

    if (!schema && hasSchemas() && !modelless) {
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

  // ── The two write modes ─────────────────────────────────────────────────────
  //
  // A create schema and an update schema are different documents, and three of
  // the differences are about a write this pipeline is making rather than about
  // the shape of the model: `@immutable` is `readOnly` on an update and writable
  // on a create, a sealing `@immutable` carries `x-litestone-seal` instead, and
  // the `@version` column exists in the update schema alone.
  //
  // So a patch is judged against the update rules and a create against the
  // create ones. Which table each caller reads is stated at every use below
  // rather than resolved once, because the two answer differently for exactly
  // the fields where getting it wrong is silent: an `@immutable` column left in
  // a patch payload is refused BY NAME by the Data boundary — the person told
  // to leave out a field they never assembled — and `make()` handed the update
  // table would offer no box to type an `@immutable` value into at all, so the
  // model would be uncreatable through a generated form (`FJS-807`).
  //
  // `formFields()` stays on the CREATE table: one resource serves both a create
  // screen and an edit screen and the field SET is the same question for both.
  // What an edit form needs beyond it is which columns are frozen for the row
  // it opened on, and that is `sealedFields(record)`.
  const updateFields = schema ? buildFieldRules(updateModel ?? modelDef) : {}

  /** Which rule table judges this method's payload. */
  function rulesFor(method) {
    return method === 'patch' ? updateFields : fields
  }
  const relations = schema ? buildRelations(modelDef)   : {}
  const gate      = schema ? buildGate(modelDef)        : null
  const stateSpec = schema ? buildTransitions(modelDef) : null
  const versionOf = schema ? buildVersion(modelDef)     : null

  // Which column identifies a row of THIS model to a person — `@@label(field)`
  // in the seed, a guess otherwise. Resolved once here rather than per picker,
  // so a hand-written one and a generated one cannot disagree, and carried with
  // its `source` so a caller can say the answer was guessed.
  const labelInfo = labelFieldInfo(fields, idField, modelDef?.['x-label-field'])

  // Junction resource — wires WS push events → store automatically, scoped to
  // the query the store's last load() ran with. `fields` is what turns a wire
  // operand back into the value the column holds, so the matcher is built here
  // and not in Junction, which holds no schema. Declared after the rules for
  // that reason; nothing can push before the first load in any case.
  const junctionResource = client.resource(serviceName, idField, {
    match: (record, query) => matchesQuery(fields, record, query),
    // Which MODEL these rows are. Junction holds no schema and cannot derive it
    // from the service name, so two services over one model would otherwise be
    // two rows — the thing nodes exist to stop (`FJS-D138`).
    model,
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
  //
  // ── What it holds, and why it is bounded ──────────────────────────────────
  //
  // One entry per row this resource has read: the revision, and the row AS
  // READ. The row is the baseline `save()` patches against — see save() — and
  // is the one fact that makes *a patch of what changed* derivable rather than
  // something a caller has to declare.
  //
  // A `find()` stamps every row of every page, so this is capped: a list screen
  // paging a large table would otherwise accumulate one entry per row seen, for
  // the life of the tab, on a map only ever read for the row being edited
  // (`FJS-823`). Insertion-ordered eviction is the whole policy — a Map iterates
  // in insertion order, so the oldest key is `keys().next()`. Re-reading a row
  // re-inserts it, which is what keeps the row a form is sitting on alive
  // across a list refresh.
  //
  // The cap is per resource and is generous against a form: nothing reads more
  // than one row of this map at a time, and the failure of a miss is a patch
  // that carries the whole record — today's behavior, which is safe.
  const _read = new Map()

  function _remember(id, row) {
    if (_read.has(id)) _read.delete(id)
    _read.set(id, row)
    while (_read.size > READ_CACHE_MAX) _read.delete(_read.keys().next().value)
  }

  // The revision this resource last READ for a row, or null.
  function _readVersion(id) {
    if (!versionOf) return null
    const v = _read.get(id)?.[versionOf]
    return Number.isInteger(v) ? v : null
  }

  // ── Is the key the CALLER's to choose? ─────────────────────────────────────
  //
  // Litestone omits a server-assigned `@id` from the CREATE schema and offers a
  // caller-supplied one like any other column (`FJS-608`, `isServerAssignedId`
  // is the owner). So *is this key mine to type* is already on the wire, as the
  // presence of the id column in create mode, and nothing here has to restate
  // the three shapes litestone grades.
  //
  // It is the fact `save({ mode: 'auto' })` needs and did not have — see save().
  const callerSuppliedId = !!(schema && modelDef?.properties
    && Object.prototype.hasOwnProperty.call(modelDef.properties, idField))

  // The ids this resource has READ, on a model whose key the caller types.
  //
  // Only then, because a server-assigned key answers *does this row exist* by
  // being present at all and this set would grow one entry per row of every
  // page for nothing.
  const _seen = new Set()

  function _rememberRows(result) {
    if (!result) return
    const rows = Array.isArray(result) ? result
      : Array.isArray(result?.data) ? result.data
      : [result]
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const id = row[idField]
      if (id == null) continue
      if (callerSuppliedId) _seen.add(id)
      _remember(id, row)
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
    return validateAgainstFields(rulesFor(mode === 'patch' ? 'patch' : 'create'), data, mode)
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
    // `hookContext` rather than a literal: `result` remembers whether anything
    // ever set it, which is the only thing separating a legitimate `null` from
    // a pipeline no hook completed. See the throw after runAroundHooks.
    const ctx = hookContext({
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
    })

    // Did the server's half of this call complete? Read only by the catch
    // below, and never true for a read: `find` and `get` write nothing, so
    // "the write landed" is not a thing they can be half of.
    let committed = false

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
      // Normalization runs first so validation judges what will actually be
      // sent, not an intermediate form of it.
      // The server's own columns go first, so nothing below coerces, blanks or
      // validates a value that is not going to be sent. An edit form is handed
      // a row the server wrote, and that row carries every column the caller
      // could READ — `@system`, `@generated`, `@from`, a tenancy stamp — which
      // the Data boundary refuses by name. The person then sees a 403 about a
      // column that is not on their screen.
      //
      // The version column is `readOnly` and is the one that must travel; the
      // block below is what puts it back on when the caller did not state one.
      //
      // Judged against the rules for THIS method: `@immutable` is `readOnly` on
      // a patch and writable on a create, so a create judged by the update
      // table could not be made and a patch judged by the create table sends a
      // column the boundary refuses by name (`FJS-807`).
      const rules = rulesFor(method)

      if (method === 'create' || method === 'patch') {
        ctx.data = stripReadOnly(rules, ctx.data, { keep: versionOf ? [versionOf] : [] })
      }

      // Coercion first: '' must still look blank to normalize() below, and
      // Number('') is 0 — so this deliberately leaves empty strings alone.
      if (autoCoerce && (method === 'create' || method === 'patch')) {
        ctx.data = coerceToSchema(rules, ctx.data)
      }

      if (autoBlank && (method === 'create' || method === 'patch')) {
        ctx.data = normalizeBlanks(rules, ctx.data)
      }

      if (autoValidate && (method === 'create' || method === 'patch')) {
        const problems = validateAgainstFields(rules, ctx.data, method === 'create' ? 'create' : 'patch')
        if (problems.length) throw new ResourceValidationError(serviceName, problems)
      }

      // @version rides along on a patch. A caller who set it explicitly wins —
      // that is someone doing their own concurrency control. With no remembered
      // version the patch goes up without one and the server says so, which is
      // a better failure than inventing a number that would silently win a race.
      if (versionOf && method === 'patch' && ctx.data && typeof ctx.data === 'object'
          && ctx.data[versionOf] == null) {
        const known = _readVersion(ctx.id)
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

      // The write LANDED. Everything below this line can still throw, and a
      // caller told only that the call failed presses Save again and makes a
      // second row (`FJS-823`). The flag is set here rather than in the catch
      // because here is the only place that knows the difference.
      if (method !== 'find' && method !== 'get') committed = true

      // Record before the after-hooks, so a hook that reads the version off the
      // resource sees the one that just came back rather than the previous read.
      _rememberRows(ctx.result)

      // after
      await runPhase(_hooks, 'after', method, ctx)
    }

    try {
      await runAroundHooks(aroundList, ctx, inner)
    } catch (err) {
      // A failure AFTER the row was written is a different failure, and the
      // caller cannot tell them apart from the outside: an `after` hook whose
      // analytics call throws once shows "save failed" over a row that exists,
      // and the person presses Save again. Marked on the error so
      // `toFieldErrors` can say which one it is and `<Form>` can stop offering
      // the button.
      if (committed && err && typeof err === 'object') {
        err.committed = true
        if (err.result === undefined) err.result = ctx.result
      }

      ctx.error = err

      const errorList = [
        ...(_hooks.error?.all     ?? []),
        ...(_hooks.error?.[method] ?? []),
      ]

      if (errorList.length) {
        for (const hook of errorList) await hook(ctx)
        // error hook cleared ctx.error — treat as recovered
        if (!ctx.error) {
          // Recovered from what, though? A hook that clears the error and sets
          // no result says the call succeeded and hands back the `null` the
          // context was born with. The original failure is gone by then, so
          // it is carried on `cause` — losing it is what makes this shape take
          // an afternoon.
          if (!answered(ctx)) throw new ResourceHookError(serviceName, method, 'error', err)
          return ctx.result
        }
      }

      throw ctx.error ?? err
    }

    // Nothing threw and nothing answered: an `around` hook returned without
    // calling `next()`, or caught the failure and did not rethrow. Both are
    // ordinary mistakes and both used to resolve the call to `null`, which a
    // screen reads as an answer — `(await r.service.find()).data` throws in the
    // app's own code, one hop away, naming nothing that is wrong.
    if (!answered(ctx)) throw new ResourceHookError(serviceName, method, 'around')

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

    /**
     * One record. With no directives stated, the resource's own `detailQuery`
     * answers — the include/select shape a detail view needs, declared once
     * beside the model instead of at every call site.
     */
    get:     (id, directives)    => _call('get',     id,        null,
                                          detailQuery?.query      ?? {},
                                          directives ?? detailQuery?.directives ?? {}),
    create:  (data)          => _call('create',  null,          data,  {}),
    patch:   (id, data)      => _call('patch',   id,            data,  {}),
    remove:  (id)            => _call('remove',  id,            null,  {}),
    restore: (id)            => _call('restore', id,            null,  {}),

    /**
     * Create or patch, deciding the same way `save()` does — `_writeMode` is
     * the one owner, so a caller reaching the service proxy and a caller
     * reaching `save()` cannot get different answers about one payload. This
     * tested the id for TRUTHINESS, which additionally reads `0` as absent.
     */
    upsert: (data) => _writeMode(data) === 'patch'
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
    if (stamp === _loadIssued) _rememberRows(rows)
    return rows
  }

  /**
   * Grow the window — the live list's answer to paging (`FJS-D145`).
   *
   *   await orders.load(page.query, page.directives)
   *   // ... a "load more" button
   *   await orders.more()
   *
   * A keyset scan resuming from the edge of what this list already holds, so
   * it cannot skip a row or serve one twice the way an offset does under a
   * list that is being written to — which is the case this framework is best
   * at and was worst for. The cursor is minted by the server and handed back
   * verbatim; nothing here constructs one.
   *
   * **Growing is not a chance to ask a different question**: the query and the
   * directives are the last `load()`'s, because a cursor minted under one
   * ordering names no position in another. A different filter or a different
   * sort is a `load()`.
   *
   * Answers the rows it added — `[]` when there is nothing past the window.
   * `hasMore()` is the same question asked before pressing.
   */
  async function more() {
    const rows = await junctionResource.more()
    _rememberRows(rows)
    return rows
  }

  /**
   * One row, live — the same nodes the list is a view over, filtered to one.
   *
   * `service.get(id)` answers a plain object no announcement can reach, which
   * is why every detail screen went stale the moment somebody else wrote the
   * row (`FJS-518`). This subscribes to the row instead:
   *
   *   const row = orders.record(page.params.id)
   *   $: order  = useStore(row)          // moves on a push, with no reload
   *   await row.ready                    // if the first read must be awaited
   *
   * The first read goes through this resource's own `_call('get')`, so its
   * hooks run, its coercion applies and the `@version` it returns is
   * remembered — Junction keeps only the rule about WHEN to read, which is
   * *when nothing has read this row yet*.
   *
   * **A push does not move the remembered version**, and that is the whole of
   * why the node and the view are separate things. `FJS-341` was a live store
   * answering with a revision nobody on the screen had read, which won the race
   * `@version` exists to lose. The value on screen moves; what this screen has
   * READ does not.
   *
   * **`{ composed: true }` where this service's `get()` answers more than the
   * row** — an `include:`, a count assembled per call, a child list. A node
   * holds one shape and a push carries the row alone, so watching one there
   * drops the children at the first announcement (`FJS-533`); declaring it
   * makes the node the trigger and re-runs this read instead.
   */
  function record(id, opts = {}) {
    return junctionResource.record(id, {
      // The same read `service.get(id)` makes, `detailQuery` included: a
      // resource that declares the include shape a detail view needs declares
      // it once, and a record view is a detail view.
      load: () => _call('get', id, null,
                        opts.query      ?? detailQuery?.query      ?? {},
                        opts.directives ?? detailQuery?.directives ?? {}),
      composed: opts.composed === true,
    })
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
    return _readVersion(id)
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

  /**
   * Which columns are frozen FOR THIS ROW.
   *
   * Two ways a column gets here and they are one question — *may this row still
   * accept a value for this field* — asked of the model's UPDATE schema:
   *
   *   `@immutable`            — frozen the moment the row exists
   *   `@immutable` + `@seals` — frozen once the row reaches a sealing state
   *
   * The method keeps the narrower name it was given: `@frontierjs/ui` already
   * calls it through `lockedBy(form, name)`, which is the general word, and
   * renaming the resource verb is a cross-package edit. The seal was only ever
   * the half that could not be answered from the schema alone.
   *
   * Until `FJS-807` this answered `[]` for every row of every model, because
   * the build shipped the CREATE schema and neither marker exists in it.
   *
   * Reached through the resource rather than imported, like `formFields` and
   * `options`, because `@frontierjs/ui` peers only on mesa and css and the rule
   * belongs to `sealedFor`. Answering a LIST rather than a predicate is what
   * keeps it one call per render instead of one per field.
   *
   * The row to ask about is the one that was READ, never the payload being
   * assembled: a save that issues the document and edits it in the same
   * submit is legitimate — the boundary grades against the STORED state — and
   * reading the payload's own state column would drop that edit in silence.
   *
   * No record answers `[]`, deliberately: a create form is making a draft.
   */
  function sealedFields(record) {
    if (!record) return []
    const out = []
    for (const [name, rule] of Object.entries(updateFields)) {
      // The version column is `readOnly` and is the one that MUST travel, which
      // is the same exception `stripReadOnly`'s keep list exists for. A caller
      // deleting it from the payload turns every optimistic write into one the
      // server refuses for having no revision.
      if (name === versionOf) continue

      // Frozen because the column may be written once — `@immutable` on a model
      // that does not seal, which the update schema marks `readOnly` outright.
      // Read against the CREATE table so a column that was never writable at
      // all (`@system`, `@generated`, `@computed`, `@from`, a tenancy stamp) is
      // not reported here: those are not frozen for this row, they are the
      // server's on every row, and a form never offered a box for them.
      if (rule?.readOnly && !fields[name]?.readOnly) { out.push(name); continue }

      // Frozen because the row has REACHED the state that seals it — the
      // answer no schema can carry, which is why it is asked of the record.
      if (sealedFor(rule, record)) out.push(name)
    }
    return out
  }

  // One request per (field, query) for the life of the resource. A form with
  // three pickers over the same model still asks three times — they are three
  // different columns and may be filtered differently — but a re-render does
  // not ask again, which is what a component looping over fields would do.
  const _options = new Map()

  // One report per field, not per call — `options()` runs on every render of a
  // form and the message is about the schema, which does not change between two
  // of them.
  const _labelWarned = new Set()

  // One related resource per (model, service), for the life of this one.
  //
  // `createResource` is not a cheap call and it is not a pure one: it makes a
  // junction resource, which makes a Store, binds it to the node registry,
  // opens the socket and registers a `resync` listener that nothing can remove
  // — junction's `resource()` hands back no dispose. So a picker that built one
  // per render left a listener per render behind it, and after a single
  // reconnect a form rendered 500 times fired 500 identical `find` requests
  // (measured: 501 listeners, +1.4 MB). Every throwaway also carried its own
  // `_options` and `_labelWarned`, so the label-guess warning documented as
  // once-per-field was once per render, masked only because the outer cache
  // short-circuits the REQUEST and never the construction.
  const _related = new Map()

  function relatedResource(service, modelName) {
    const key = `${modelName ?? ''}|${service}`
    let r = _related.get(key)
    if (!r) {
      r = createResource(service, { model: modelName })
      _related.set(key, r)
    }
    return r
  }

  /**
   * What a field's picker offers, and whether that is all of it.
   *
   * The relation already says which model answers (`x-relations` → `references`),
   * the registry says which service that model is served under, and the related
   * model's own fields say which column a person recognizes. So a picker over
   * `customerId` needs no name written anywhere:
   *
   *   const { options, total, truncated } = await orders.options('customerId')
   *
   * ─── Why an envelope and not the rows ──────────────────────────────────────
   *
   * This answered a bare array and capped it at 100, so a picker over a model
   * with more rows offered an alphabetical prefix and said nothing — the row a
   * person wanted was absent, and the screen was indistinguishable from one
   * where it had never been created (`FJS-391`). The count that settles it is
   * already on the wire, in the list envelope the service returns, and was
   * being dropped here. Returning it costs one property access at every call
   * site and makes the silence unrepresentable. Same split `find()` and
   * `findData()` already make one layer down.
   *
   * ─── search vs query ───────────────────────────────────────────────────────
   *
   * `query` is a FILTER — the standing narrowing a caller wants on this picker
   * (`{ active: true }`). `search` is what a person typed, applied as `contains`
   * on the label column, and it is a separate name because they compose: a
   * picker restricted to active customers still has to be searchable within
   * them. Sending `search` is what lets a relation larger than the cap be
   * reached at all, since the term goes to the SERVER rather than filtering the
   * hundred rows that already arrived.
   *
   * @param {string} fieldName
   * @param {object} [opts]
   * @param {string} [opts.labelField]  Column to show; defaults to the derived one.
   * @param {object} [opts.query]       Filter passed to the related service.
   * @param {string} [opts.search]      Free text, matched against the label column.
   * @param {object} [opts.directives]  Overrides limit/orderBy wholesale.
   * @param {number} [opts.limit=100]
   * @param {boolean} [opts.reload]     Bypass the cache.
   * @returns {Promise<{ options: Array<{value: unknown, label: unknown}>, total: number|null, truncated: boolean|null }>}
   *   `total` is null when the service reported none, and `truncated` is null
   *   with it — *unknown*, not *no*. A caller rendering "showing 12 of 400"
   *   has to be able to tell those apart.
   */
  function options(fieldName, { labelField, query, search, directives, limit = 100, reload = false } = {}) {
    const rule = fields?.[fieldName]

    // An enum's members are already on the rule, so this answers without a
    // request — but it answers a PROMISE, like the relation branch below.
    // One call shape for both is the whole point: a caller asking "what are
    // this field's options" cannot know which kind of field it has without
    // re-deriving the thing this function exists to decide, and a seam that
    // returns a value sometimes and a promise other times is one every caller
    // has to special-case.
    //
    // `rule.options` is the labeled list (@label on a member); `rule.enum` is
    // the bare codes. Falling back to the code as its own label is what a
    // control rendering a bare enum already shows.
    if (rule?.options || Array.isArray(rule?.enum)) {
      const all = rule.options ?? rule.enum.map(v => ({ value: v, label: v }))

      // A declared set is small and entirely in hand, so `search` is applied
      // here rather than sent anywhere — and `total` is the whole set, never a
      // page of it, so `truncated` is false rather than unknown.
      const opts = search
        ? all.filter(o => String(o.label ?? '').toLowerCase().includes(String(search).toLowerCase()))
        : all

      return Promise.resolve({ options: opts, total: all.length, truncated: false })
    }

    // ── a declared value set ─────────────────────────────────────────────
    // Asked before the foreign key, because a bound FK is both and the set is
    // the narrower, better-described answer: it names the column a person reads
    // and the scope the list is narrowed by.
    //
    // Every narrowing the set applies travels as a NAME — `$checkWhere`
    // validates a `$scope`, so it survives junction's autoFilter and litestone
    // compiles it — which is what makes the offered list the SAME list the Data
    // boundary will accept. A declared `where` is SQL and a browser may never
    // send SQL, so it mints a scope of its own at parse and arrives here as one
    // more name (`FJS-430`).
    const vs = rule?.values
    if (vs) {
      const shown = labelField ?? vs.label ?? vs.value
      const key   = search ? null : `${fieldName}|${JSON.stringify(query ?? null)}|${labelField ?? ''}`
      if (key && !reload && _options.has(key)) return _options.get(key)

      const setService = relatedResource(serviceNameFor(vs.model) ?? vs.model, vs.model)
      const pending = setService.service
        .getOptions(
          {
            ...(query ?? {}),
            ...(vs.scopes?.length ? { $scope: vs.scopes } : {}),
            ...(search ? { [shown]: { contains: String(search) } } : {}),
          },
          directives ?? { limit, orderBy: shown },
        )
        .then(res => {
          const rows  = Array.isArray(res) ? res : (res?.data ?? [])
          const opts  = rows.map(row => ({ value: row?.[vs.value], label: row?.[shown] ?? row?.[vs.value] }))
          const total = typeof res?.total === 'number' ? res.total : null
          return { options: opts, total, truncated: total == null ? null : total > opts.length }
        })
        .catch(err => {
          console.warn(`[${serviceName}] options('${fieldName}') — ${vs.set} failed to load: ${err?.message ?? err}`)
          if (key) _options.delete(key)
          return { options: [], total: null, truncated: null, error: `${vs.set} failed to load: ${err?.message ?? err}` }
        })

      if (key) _options.set(key, pending)
      return pending
    }

    const ref = rule?.references
    if (!ref) {
      console.warn(
        `[${serviceName}] options('${fieldName}') — that field is neither an enum nor a foreign ` +
        'key, so there is nothing to offer. A picker comes from a relation or a declared set; ' +
        'check the name against the model.',
      )
      return Promise.resolve({ options: [], total: 0, truncated: false,
        error: `'${fieldName}' is neither an enum, a declared value set nor a foreign key` })
    }

    // The cache is asked BEFORE anything is built, which is the order the value
    // set branch above already uses. It was the other way round here, so a
    // cached answer still cost a whole resource — see `relatedResource`.
    //
    // A searched result is NOT cached. The key would carry the term, so every
    // keystroke would leave an entry behind for the life of the resource, and
    // the answer is the one thing here guaranteed to be superseded a moment
    // later. The unsearched list is the one worth holding.
    const key = search ? null : `${fieldName}|${JSON.stringify(query ?? null)}|${labelField ?? ''}`
    if (key && !reload && _options.has(key)) return _options.get(key)

    const relatedService = serviceNameFor(ref.model) ?? ref.model
    const related        = relatedResource(relatedService, ref.model)
    const shown          = labelField ?? related.labelField

    // A guessed display column is the failure this cannot fix and can stop
    // hiding: *Ada, Ada, Ada* down a list of people, or `1, 2, 3`, both of
    // which look like a working picker. Only the two guessing tiers are said —
    // `name` and `title` are right often enough that warning about them would
    // teach everyone to skip the message. Once per field, not per call.
    if (!labelField && !_labelWarned.has(fieldName) && WEAK_LABEL.has(related.labelSource)) {
      _labelWarned.add(fieldName)
      console.warn(
        `[${serviceName}] options('${fieldName}') — ${related.labelSource === 'fallback'
          ? `${ref.model} has no readable string column, so every option is labeled with its id`
          : `showing ${ref.model}.${shown}, the first plain string column, which is a guess`}. ` +
        `Declare it: @@label(<column>) on model ${ref.model}.`,
      )
    }

    // `search` narrows on the column a person is reading, which is the same
    // column the list is ordered by — anything else would rank by one string
    // and match against another.
    const filter = {
      ...(query ?? {}),
      ...(search ? { [shown]: { contains: String(search) } } : {}),
    }

    const pending = related.service
      .getOptions(filter, directives ?? { limit, orderBy: shown })
      .then(res => {
        const rows = Array.isArray(res) ? res : (res?.data ?? [])
        const opts = rows.map(row => ({
          value: row?.[ref.field],
          // The id is the honest fallback: a blank option is unpickable and a
          // guessed label is worse than a number.
          label: row?.[shown] ?? row?.[ref.field],
        }))

        // An array answer carries no envelope, so there is no total to read —
        // reported as null rather than as the row count, which would claim the
        // list is complete every time it is capped.
        const total = typeof res?.total === 'number' ? res.total : null

        return { options: opts, total, truncated: total == null ? null : total > opts.length }
      })
      .catch(err => {
        // A picker whose rows fail to load must not take the form down with it.
        // The field still renders, empty, and the failure is said out loud.
        console.warn(`[${serviceName}] options('${fieldName}') failed — ${err?.message ?? err}`)
        if (key) _options.delete(key)
        // `error` is what separates *there are none* from *I could not ask*.
        // Both used to answer an empty list, and a person reads an empty picker
        // as the first one — which is how a service nobody could reach looked
        // like a shop with no variants in it (`FJS-570`).
        return { options: [], total: null, truncated: null, error: String(err?.message ?? err) }
      })

    if (key) _options.set(key, pending)
    return pending
  }


  // ── save — the one owner of "write this record" ────────────────────────────

  /** A text box cannot say "no value" and `make()` seeds `''`. Neither is an id. */
  const _blankId = (v) => v == null || v === ''

  /**
   * Create or patch — the one place the question is answered. `service.upsert`
   * reads it too, so the two verbs cannot drift.
   */
  function _writeMode(data) {
    const id = data?.[idField]
    if (_blankId(id)) return 'create'
    if (!callerSuppliedId) return 'patch'
    return _seen.has(id) ? 'patch' : 'create'
  }

  /**
   * Write a record and answer the row the server returned.
   *
   * `mode` decides which call it is: `auto` (the default) asks whether this row
   * already exists, and naming `create` or `patch` forces one. `upsert` is an
   * alias of `auto` — the two asked the same question, and keeping a second
   * word for it is how a caller ends up believing the server has an upsert
   * method it does not have.
   *
   * The id field is the schema's, never the literal `id`. That is the whole
   * reason this is a resource verb: `<Form>` and every hand-written save had to
   * answer the same question, and a caller answering it with `id` on a model
   * keyed by something else CREATES a duplicate row while looking like an edit
   * (`FJS-316`). One owner, per Invariant 4.
   *
   * ── How `auto` decides ────────────────────────────────────────────────────
   *
   * *Is the id present* is a sound proxy for *this row exists* only where the
   * SERVER assigns the key, and litestone deliberately emits a caller-supplied
   * `@id` in the create schema so a generated form has a box to type it into
   * (`FJS-608`). Reading presence there routed what the person had just typed
   * into a patch, so a generated create form over `Sku { code String @id }`
   * could never create a row — it threw *Unknown field 'id' in where* — and
   * left EMPTY it was worse, because `make()` seeds `''` and `'' != null`, so
   * the form issued a patch over the whole COLLECTION (`FJS-808`).
   *
   * So there are two questions and the schema says which one to ask:
   *
   *   server-assigned key — presence, as before. An id the caller did not have
   *                         and now does came from a row.
   *   caller-supplied key — has THIS resource read that id? Which is the fact
   *                         `auto` was trying to reconstruct: an edit form is
   *                         opened on a row this resource fetched, and a create
   *                         form is not. A miss creates, and a create over a key
   *                         that is already taken is refused by the uniqueness
   *                         of the key — loudly, and by the layer that owns it.
   *
   * A blank id is *absent* in both, and that is not a special case so much as
   * the correction of one: a text box cannot express "no value" and `make()`
   * seeds `''`, which is the same reason `blankToNull` exists.
   *
   * `mode: 'patch'` with no id is refused rather than sent. A patch with no id
   * is a write over every row the caller can reach, and nothing between a form
   * and the wire was standing in its way.
   *
   * ── What a patch CARRIES ──────────────────────────────────────────────────
   *
   * What CHANGED against the row this resource read — not the record it was
   * handed. `save()` is a record-shaped verb: `<Form record={row}>` hands back
   * the whole row, and sending it whole makes a PATCH a PUT. A column the
   * caller may write but the screen never showed — `formFields({ except })`, a
   * hand-written form, a column added to the `.lite` after the screen was
   * written — then rides along at the value it held when the form opened, and
   * overwrites whatever somebody else wrote to it while the form was open. The
   * other person's change is gone with nothing said (`FJS-809`).
   *
   * `@version` catches that and is the right answer where it is declared, but
   * it is opt-in — so before this, the correctness of every generated edit form
   * depended on the model author having declared a column, and nothing checked
   * it.
   *
   * The baseline is the row `_read` holds, which is the row this resource
   * fetched and never a WS push (see `_rememberRows`) — the same provenance
   * rule the version stamp follows, for the same reason. With no baseline the
   * whole record goes up, which is what every patch did before: a miss is
   * today's behavior and never a lost value.
   *
   * A key is compared and never tested for truthiness, so Invariant 9 holds: an
   * explicit `null` differs from a non-null baseline, travels, and clears. What
   * a diff does is OMIT a key — it never substitutes one.
   *
   * `service.patch(id, data)` is unchanged and is the escape: it sends what it
   * is handed. The line is that this verb takes a record and that one takes a
   * payload.
   *
   * Everything else is already the pipeline's: `_call` coerces, blank-strips
   * and validates a create/patch payload, stamps the `@version` this screen
   * read, and runs the resource's own hooks. So a caller writes
   * `resource.save(record)` and inherits all of it.
   */
  async function save(data, { mode = 'auto', optimistic = false } = {}) {
    const how = (mode === 'auto' || mode === 'upsert') ? _writeMode(data) : mode

    if (how === 'patch' && _blankId(data?.[idField])) throw new Error(
      `[${serviceName}] save({ mode: 'patch' }) needs a value for '${idField}' — the payload ` +
      `carries ${data?.[idField] === '' ? 'an empty one' : 'none'}, and a patch with no id is a ` +
      `write over every row this caller can reach. Pass the row's '${idField}', or save it as a ` +
      `create.`
    )

    if (how === 'create') {
      // A create cannot be optimistic here and saying so is better than
      // quietly not being one: there is no id, so there is no row to overlay,
      // and inventing a temporary one is a different feature with its own
      // question — what every view holding that id does when the real one
      // arrives.
      if (optimistic) throw new Error(
        `[${serviceName}] save({ optimistic }) needs an existing record — a create has no ` +
        `${idField} to show the change against. Save it, then edit it optimistically.`
      )
      return _call('create', null, data, {})
    }

    const id      = data?.[idField]
    const payload = _changed(id, data)

    return optimistic
      ? mutate(id, payload, () => _call('patch', id, payload, {}))
      : _call('patch', id, payload, {})
  }

  /**
   * The keys of `data` that differ from the row this resource read for `id`,
   * plus the two that always travel — the key itself, which addresses the write
   * and decides its mode, and the `@version` column, whose whole job is to ride
   * along on a patch.
   *
   * Unknown baseline → `data` unchanged. Comparison is `!==`, so a value that
   * is not a primitive is sent whenever the reference moved, which is every
   * time a control replaced it and never when nothing touched it: `<Form>`
   * rewrites the record as `{ ...record, [name]: value }`, so an untouched key
   * is still the identical reference the read produced.
   */
  function _changed(id, data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return data
    const base = _read.get(id)
    if (!base || typeof base !== 'object') return data

    const out = {}
    for (const key of Object.keys(data)) {
      if (key === idField || (versionOf && key === versionOf)) { out[key] = data[key]; continue }
      if (!(key in base) || base[key] !== data[key]) out[key] = data[key]
    }
    return out
  }

  // ── mutate — the write that shows before it lands ───────────────────────────

  /**
   * Apply `intent` to the row now, run the write, and take it back if the
   * write fails.
   *
   *   await orders.mutate(id, { status: 'paid' },
   *     () => orders.service.invoke('pay', id))
   *
   * The overlay sits on the row's NODE, so every view of that row moves at
   * once — this list, a second list with another filter, a detail screen open
   * on it — and an intent that moves a sort key re-places the row in an
   * ordered list. What is stored is the intent and never the value it
   * produced (`FJS-D138`).
   *
   * It is settled against the MUTATION rather than the row, which is what
   * makes it safe while somebody else is writing: their change moves the truth
   * underneath and this stays on top of it, and a rollback reveals what THEY
   * did rather than what was on screen when this started.
   *
   * `intent` is a partial over the row, or `null` to say the row is going.
   * `run` defaults to a patch of the intent through this resource's own
   * pipeline, so `mutate(id, { note })` is an optimistic patch and the second
   * argument is for a transition or a custom method, where the call is not a
   * patch and the intent is what the caller knows it will do.
   */
  function mutate(id, intent, run) {
    return junctionResource.mutate(
      id, intent,
      run ?? (() => _call('patch', id, intent, {}))
    )
  }

  // Everything above that belongs to the person who is signed in, dropped
  // together when that stops being the same person — see the identity epoch at
  // the top of this file. Registered last, so the closure names state that is
  // already built.
  //
  // `_related` and `_labelWarned` are deliberately NOT cleared: one is a
  // construction cache whose whole purpose is that a resource is built once,
  // and the other is a report about the SCHEMA. Neither holds a row.
  _liveResources.add(() => {
    _options.clear()
    _read.clear()
    _seen.clear()
    store.set([])
    stale.reset?.()
  })

  return {
    service, store, stale, make, load, save, record, mutate,
    more, hasMore: junctionResource.hasMore,
    fields, relations, gate, can, transitions, validate, normalize, coerce,
    version, versionField: versionOf, conflict,
    formFields, options, sealedFields,
    labelField: labelInfo.field, labelSource: labelInfo.source,
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
    more:    async () => [],
    hasMore: () => false,
    mutate:  (_id, _intent, run) => (run ? run() : noop()),
    record:  () => ({
      id: null,
      ready: Promise.resolve(null),
      get: () => null,
      subscribe: fn => { fn(null); return () => {} },
      refresh: async () => null,
      release: () => {},
    }),
    save:    noop,
    fields:    {},
    relations: {},
    formFields: () => [],
    // The envelope every caller destructures. A bare array here read back as
    // `r.options === undefined` and threw inside the render.
    options:    () => Promise.resolve({ options: [], total: 0, truncated: false }),
    labelField:  'id',
    labelSource: 'fallback',
    gate:        null,
    // Not routed through `canAtLevel`, and not because the answer for *no gate*
    // is in doubt. That function answers *does the declared gate admit this
    // level*, and permissive-when-unknown is right for it. The question here is
    // a different one — *can this resource do that* — and this resource can do
    // nothing: every verb above rejects with "Junction client not available".
    // Saying yes offered a prerendered page and an SSR pass every gated control
    // in the app, which is also what `session.level = 0` next door refuses to
    // do for a caller with no session.
    can:         () => false,
    transitions: () => [],
    // A create form is making a draft and nothing is sealed, which is the same
    // answer the real resource gives for no record. Missing entirely, it was
    // absorbed by one optional chain at `<Form>`'s only call site, and the next
    // caller written without one would have thrown on any form rendered before
    // `initJunction` — a prerendered island, an SSR pass (`FJS-823`).
    sealedFields: () => [],
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
