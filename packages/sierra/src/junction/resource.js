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
 *     findParams: object,   // Junction FindParams — { limit, offset, orderBy, select }
 *     params:  object,      // client-side only — never sent to the server
 *     result:  any,         // populated after a successful call
 *     error:   Error | null // populated in error phase
 *   }
 *
 * params boundary:
 *   ctx.params is a free-form bucket for UI hooks to communicate within a
 *   single pipeline — loading state, local flags, component refs.
 *   It never leaves the browser. ctx.query is what goes over the wire.
 *
 *   ctx.findParams is the separate, structured half of the wire request — the
 *   FindParams object Junction's client serializes into $limit/$offset/
 *   $orderBy/$select for both HTTP and WebSocket. Hooks set pagination here:
 *
 *     before: { find: [ctx => { ctx.findParams.limit = 50 }] }
 *
 * Return shapes — READ THIS BEFORE .map()
 *
 *   The service methods are a PASS-THROUGH of Junction's browser client. What
 *   the API returns is what you get here; Sierra does not reshape it. The rule
 *   is Junction's, stated once and applied everywhere: a list keeps its
 *   envelope (it carries total/limit/offset, which have nowhere else to live),
 *   a single record unwraps to the record.
 *
 *     service.find(query, params)  → ListResult — { kind:'list', object, data, total, limit, offset }
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
 *     load(query, params)          → the rows (and sets store to the rows)
 *     store.get()                  → the rows
 *     createStore(svc).find(...)   → returns the raw result; store.get() is rows
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
  schemaFor, modelNameFor, hasSchemas, allSchemas, resolveRef, suggestModel,
} from './schema-registry.js'
import {
  derefFieldSchema, buildFieldRules, buildRelations, buildGate, canAtLevel,
  validateAgainstFields, normalizeBlanks, coerceToSchema, ResourceValidationError,
} from './field-rules.js'

// Re-exported so `sierra/junction` stays the one import for resource work.
export {
  buildFieldRules, buildRelations, buildGate, canAtLevel,
  validateAgainstFields, normalizeBlanks, coerceToSchema, ResourceValidationError,
}

// ── Hook runners ──────────────────────────────────────────────────────────────

async function runHooks(list, ctx) {
  if (!list?.length) return
  for (const hook of list) await hook(ctx)
}

// around hooks receive (ctx, next) — compose into a nested chain
async function runAroundHooks(list, ctx, inner) {
  if (!list?.length) return inner()
  let i = 0
  async function next() {
    const hook = list[i++]
    if (!hook) return inner()
    return hook(ctx, next)
  }
  return next()
}

async function runPhase(hookMap, phase, method, ctx) {
  const p = hookMap?.[phase]
  if (!p) return
  await runHooks(p.all, ctx)
  await runHooks(p[method], ctx)
}

// ── createMakeFromSchema ──────────────────────────────────────────────────────

/**
 * Build a make() factory from Litestone JSON schema properties.
 *
 * Pass the properties object from the model definition:
 *   const { properties } = jsonSchema.definitions['leads']
 *   const make = createMakeFromSchema(properties)
 *
 * @param {object} properties   — JSON schema properties for the model
 * @param {string[]} [skip]     — server-managed fields to exclude from make()
 * @param {(ref: string) => object|null} [resolve]
 *        `$ref` resolver, defaulting to the registry the build populates.
 */
export function createMakeFromSchema(
  properties,
  skip = ['id', 'createdAt', 'updatedAt'],
  resolve = resolveRef,
) {
  const typeDefaults = {
    string:  '',
    integer: 0,
    number:  0,
    boolean: false,
    array:   [],
    object:  {},
  }

  const fieldDefaults = {}

  for (const [key, raw] of Object.entries(properties ?? {})) {
    if (skip.includes(key)) continue

    // Not a field definition. Reached when a caller hands us something that is
    // not a properties map at all — an enum def used to arrive here and throw
    // on the `in` check below.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue

    // Enum and @type(T) fields arrive as {$ref}. Without following it there is
    // no `type` to read, and every such field silently defaulted to null.
    const def = derefFieldSchema(raw, resolve)

    // Explicit default wins
    if ('default' in def) {
      fieldDefaults[key] = def.default
      continue
    }

    // An enum with no @default has no blank value that is a member of it.
    // '' would be as invalid as null, and picking the first member would invent
    // a choice the user never made — so leave it unset for the form to fill.
    if (Array.isArray(def.enum)) {
      fieldDefaults[key] = null
      continue
    }

    // Resolve type — handle nullable anyOf and array forms
    let type = def.type
    if (!type && def.anyOf) {
      const nonNull = def.anyOf.find(t => t.type !== 'null')
      type = nonNull?.type
    }
    if (Array.isArray(type)) {
      type = type.find(t => t !== 'null')
    }

    // date-time strings → undefined (don't guess a value)
    if (type === 'string' && def.format === 'date-time') {
      fieldDefaults[key] = undefined
      continue
    }

    fieldDefaults[key] = type in typeDefaults ? typeDefaults[type] : null
  }

  return function make(spec) {
    const instance = {}
    for (const key in fieldDefaults) {
      // Clone arrays and objects so instances don't share references
      const val = fieldDefaults[key]
      instance[key] = Array.isArray(val) ? [] : (val !== null && typeof val === 'object') ? {} : val
    }
    return Object.assign(instance, spec ?? {})
  }
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

    async find(query, params) {
      const result = await service.find(query, params)
      store.set(Array.isArray(result) ? result : result?.data ?? [])
      return result
    },
  }

  return store
}

// ── mergeHooks ────────────────────────────────────────────────────────────────

function mergeHooks(target, incoming) {
  for (const phase of ['before', 'after', 'around', 'error']) {
    if (!incoming[phase]) continue
    if (!target[phase]) target[phase] = {}
    for (const method of Object.keys(incoming[phase])) {
      target[phase][method] = [
        ...(target[phase][method] ?? []),
        ...(incoming[phase][method] ?? []),
      ]
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
 * Returns { service, store, make, load, fields, relations, gate, can,
 *           validate, normalize, coerce, context, hooks }
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
 * ── opts.coerce ────────────────────────────────────────────────────────────
 * `coerce: true` casts the strings a DOM control produces into the types the
 * schema declares, before every create and patch.
 *
 *   createResource('leads', { coerce: true })
 *
 * `el.value` is a string for every control there is — `<input type="number">`
 * and `<select>` included — and Mesa's bindInput passes it through unchanged,
 * correctly, because it has no idea what the field is. So a form bound to
 * make() sends `"42"` for a Float and `"1"` for an Int, and the server (and
 * `validate`) reject both. Only the schema knows what they were meant to be.
 *
 * A form bound to DOM inputs almost certainly wants this. Default OFF, for the
 * same reason as the others: it changes what is sent.
 *
 * ── opts.blankToNull ───────────────────────────────────────────────────────
 * `blankToNull: true` applies that normalisation automatically before every
 * create and patch.
 *
 *   createResource('leads', { blankToNull: true })
 *
 * A text input cannot produce "no value" — an untouched box submits '' — so
 * without this a form writes '' into a column the schema declared nullable.
 * SQLite does not treat those as the same: `String? @unique` accepts any number
 * of NULLs but rejects a second '', and `WHERE col IS NULL` never matches ''.
 * The form keeps binding to a string; the wire carries the distinction.
 *
 * Default OFF, because it changes what is stored.
 *
 * ── opts.validate ──────────────────────────────────────────────────────────
 * `validate: true` also runs that check automatically before every create and
 * patch, throwing ResourceValidationError instead of making the request.
 *
 *   createResource('leads', { validate: true })
 *
 * Default OFF. The server validates regardless — Junction derives its rules
 * from the same .lite file — so this is about failing in the browser, before a
 * round trip, rather than about being the thing that says no. Turning it on
 * changes where an invalid payload surfaces, which is why existing resources
 * are not opted in for you.
 *
 * It runs AFTER the before-hooks, so a hook that completes the record (stamping
 * a tenant id, coercing a field) is reflected in what gets checked. A throw
 * lands in the error phase like any other failure, so an `error` hook can
 * present it or recover from it.
 */
export function createResource(nameOrSpec, schemaOrOpts = {}, maybeOpts = {}) {
  let serviceName, model, optionsQuery, initialHooks, schema, idField,
      autoValidate, autoBlank, autoCoerce

  if (typeof nameOrSpec === 'string') {
    serviceName = nameOrSpec
    // createResource('leads', schema, opts)  or  createResource('leads', opts)
    if (schemaOrOpts && (schemaOrOpts.$defs || schemaOrOpts.definitions || schemaOrOpts.properties)) {
      // second arg looks like a schema
      schema       = schemaOrOpts
      initialHooks = maybeOpts.hooks    ?? {}
      idField      = maybeOpts.idField  ?? 'id'
      model        = maybeOpts.model    ?? serviceName
      optionsQuery = maybeOpts.optionsQuery
      autoValidate = maybeOpts.validate === true
      autoBlank    = maybeOpts.blankToNull === true
      autoCoerce   = maybeOpts.coerce === true
    } else {
      // second arg is opts
      const opts   = schemaOrOpts
      schema       = opts.schema
      initialHooks = opts.hooks    ?? {}
      idField      = opts.idField  ?? 'id'
      model        = opts.model    ?? serviceName
      optionsQuery = opts.optionsQuery
      autoValidate = opts.validate === true
      autoBlank    = opts.blankToNull === true
      autoCoerce   = opts.coerce === true
    }
  } else {
    // object form
    serviceName  = nameOrSpec.service
    model        = nameOrSpec.model        ?? serviceName
    optionsQuery = nameOrSpec.optionsQuery
    initialHooks = nameOrSpec.hooks        ?? {}
    schema       = nameOrSpec.schema
    idField      = nameOrSpec.idField      ?? 'id'
    autoValidate = nameOrSpec.validate === true
    autoBlank    = nameOrSpec.blankToNull === true
    autoCoerce   = nameOrSpec.coerce === true
  }

  // No schema passed — take it from the registry, which Sierra's build fills
  // from db/schema.lite. This is why a resource file names a model and nothing
  // else: hand-writing the field shape here duplicated the .lite file and was
  // the only remaining place the two halves of an app could drift.
  //
  // Tried in order: the explicit model name, the service name, and the
  // conventional singular of the service name — so createResource('leads') and
  // createResource('leads', { model: 'Lead' }) both resolve.
  //
  // `model` is the override for everything the registry's plural rules cannot
  // reach. English irregulars are the obvious case — no rule turns 'people'
  // into 'Person' — but it equally covers a service deliberately named
  // something other than its model ('roster' over `model Person`).
  if (!schema) {
    const singular = serviceName.endsWith('ies')
      ? serviceName.slice(0, -3) + 'y'
      : serviceName.endsWith('s') ? serviceName.slice(0, -1) : serviceName

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
  const _hooks = { before: {}, after: {}, around: {}, error: {} }
  mergeHooks(_hooks, initialHooks)

  // Junction resource — wires WS push events → store automatically
  const junctionResource = client.resource(serviceName, idField)
  const { store } = junctionResource

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
    make = createMakeFromSchema(modelDef?.properties ?? modelDef)
  } else {
    make = (spec) => Object.assign({}, spec)
  }

  // Per-field rules — empty when there is no schema, so a resource without one
  // reports no constraints rather than pretending everything is optional.
  const fields    = schema ? buildFieldRules(modelDef) : {}
  const relations = schema ? buildRelations(modelDef)  : {}
  const gate      = schema ? buildGate(modelDef)       : null

  /**
   * Would the given level clear this model's gate for that operation?
   * A UI affordance only — see canAtLevel. The server enforces regardless.
   */
  function can(operation, level) {
    return canAtLevel(gate, operation, level)
  }

  /**
   * Check a record against the schema. Always available; only enforced
   * automatically when the resource was created with `validate: true`.
   */
  function validate(data, mode = 'create') {
    return validateAgainstFields(fields, data, mode)
  }

  /**
   * Replace `''` with `null` on nullable fields. Always available; only applied
   * automatically when the resource was created with `blankToNull: true`.
   */
  function normalize(data) {
    return normalizeBlanks(fields, data)
  }

  /**
   * Cast the strings a DOM control produces into the schema's declared types.
   * Always available; only applied automatically with `coerce: true`.
   */
  function coerce(data) {
    return coerceToSchema(fields, data)
  }

  if (!schema && (autoValidate || autoBlank || autoCoerce)) {
    const on = [autoValidate && 'validate', autoBlank && 'blankToNull', autoCoerce && 'coerce'].filter(Boolean)
    console.warn(
      `[resource:${serviceName}] ${on.join(' / ')} set, but no schema resolved — ` +
      `there are no field rules to act on, so nothing will happen.`
    )
  }

  // ── _call — full 4-phase pipeline ──────────────────────────────────────────

  async function _call(method, id, data, query = {}, findParams = {}) {
    const ctx = {
      service: serviceName,
      model,
      method,
      id:      id   ?? null,
      data:    data ?? null,
      query:   query,        // travels over the wire
      findParams,            // limit / offset / orderBy / select — also the wire
      params:  {},           // client-side only — never sent to server
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

      // network call
      const proxy = client.service(serviceName)
      switch (method) {
        case 'find':    ctx.result = await proxy.find(ctx.query, ctx.findParams);          break
        case 'get':     ctx.result = await proxy.get(ctx.id ?? ctx.query, ctx.findParams); break
        case 'create':  ctx.result = await proxy.create(ctx.data);          break
        case 'patch':   ctx.result = await proxy.patch(ctx.id, ctx.data);   break
        case 'remove':  ctx.result = await proxy.remove(ctx.id);            break
        case 'restore': ctx.result = await proxy.restore(ctx.id);           break
        default:        ctx.result = await proxy.call(method, ctx.id, ctx.data); break
      }

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

  // params is Junction's FindParams — { limit, offset, orderBy, select }. It is
  // threaded to the client proxy, which serializes it for whichever transport
  // is live. It used to be accepted here and dropped on the floor, so paging an
  // ordered list through a resource silently returned the server's default page.
  const service = {
    find:    (query, params) => _call('find',    null,          null,  query ?? {}, params ?? {}),
    get:     (id, params)    => _call('get',     id,            null,  {},          params ?? {}),
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
    getOptions: (query, params) => _call(
      'find', null, null,
      query  ?? optionsQuery?.query  ?? {},
      params ?? optionsQuery?.params ?? {},
    ),

    /** real-time push event subscription */
    on:   (event, fn) => client.service(serviceName).on(event, fn),

    /** explicit WS call (bypasses HTTP) */
    call: (method, id, data) => client.service(serviceName).call(method, id, data),
  }

  // context — metadata for hooks and components
  const context = { model, service: serviceName, idField }

  // load() — HTTP find + populates store
  async function load(query, params) {
    return junctionResource.load(query ?? {}, params)
  }

  // hooks() — add hooks after creation, merged in order
  function addHooks(incoming) {
    mergeHooks(_hooks, incoming)
  }

  return {
    service, store, make, load,
    fields, relations, gate, can, validate, normalize, coerce,
    context, hooks: addHooks,
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
    store:   { get: () => [], subscribe: fn => { fn([]); return () => {} }, set: () => {}, upsert: () => {}, remove: () => {} },
    make:    (spec) => Object.assign({}, spec),
    load:    async () => [],
    fields:    {},
    relations: {},
    gate:      null,
    can:       () => true,
    validate:  () => [],
    normalize: (data) => data,
    coerce:    (data) => data,
    context: { model: name, service: name, idField: 'id' },
    hooks:   () => {},
  }
}
