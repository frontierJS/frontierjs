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
import { schemaFor, hasSchemas, allSchemas } from './schema-registry.js'

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
 */
export function createMakeFromSchema(properties, skip = ['id', 'createdAt', 'updatedAt']) {
  const typeDefaults = {
    string:  '',
    integer: 0,
    number:  0,
    boolean: false,
    array:   [],
    object:  {},
  }

  const fieldDefaults = {}

  for (const [key, def] of Object.entries(properties ?? {})) {
    if (skip.includes(key)) continue

    // Explicit default wins
    if ('default' in def) {
      fieldDefaults[key] = def.default
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
 * Returns { service, store, make, load, context, hooks }
 *   service — pass-through of the Junction client: find() gives the list
 *             envelope, single-record methods give the record. See "Return
 *             shapes" in the module header.
 *   store   — holds ROWS, never an envelope. Subscribe for renders.
 *   load    — populates store and resolves to the rows.
 *   make    — schema-seeded factory for a blank record.
 *   hooks() — add hooks after creation.
 */
export function createResource(nameOrSpec, schemaOrOpts = {}, maybeOpts = {}) {
  let serviceName, model, optionsQuery, initialHooks, schema, idField

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
    } else {
      // second arg is opts
      const opts   = schemaOrOpts
      schema       = opts.schema
      initialHooks = opts.hooks    ?? {}
      idField      = opts.idField  ?? 'id'
      model        = opts.model    ?? serviceName
      optionsQuery = opts.optionsQuery
    }
  } else {
    // object form
    serviceName  = nameOrSpec.service
    model        = nameOrSpec.model        ?? serviceName
    optionsQuery = nameOrSpec.optionsQuery
    initialHooks = nameOrSpec.hooks        ?? {}
    schema       = nameOrSpec.schema
    idField      = nameOrSpec.idField      ?? 'id'
  }

  // No schema passed — take it from the registry, which Sierra's build fills
  // from db/schema.lite. This is why a resource file names a model and nothing
  // else: hand-writing the field shape here duplicated the .lite file and was
  // the only remaining place the two halves of an app could drift.
  //
  // Tried in order: the explicit model name, the service name, and the
  // conventional singular of the service name — so createResource('leads') and
  // createResource('leads', { model: 'Lead' }) both resolve.
  if (!schema) {
    const singular = serviceName.endsWith('ies')
      ? serviceName.slice(0, -3) + 'y'
      : serviceName.endsWith('s') ? serviceName.slice(0, -1) : serviceName
    schema = schemaFor(model, serviceName, singular) ?? undefined

    if (!schema && hasSchemas()) {
      console.warn(
        `[resource:${serviceName}] no schema found for model '${model}'. ` +
        `make() will return a bare object. Known models: ` +
        `${Object.keys(allSchemas()).join(', ')}`
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

  // Schema-driven make() or pass-through
  let make
  if (schema) {
    const properties = schema?.$defs?.[serviceName]?.properties
      ?? schema?.$defs?.[model]?.properties
      ?? schema?.definitions?.[serviceName]?.properties
      ?? schema?.definitions?.[model]?.properties
      ?? schema?.properties
      ?? schema
    make = createMakeFromSchema(properties)
  } else {
    make = (spec) => Object.assign({}, spec)
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

  return { service, store, make, load, context, hooks: addHooks }
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
    context: { model: name, service: name, idField: 'id' },
    hooks:   () => {},
  }
}
