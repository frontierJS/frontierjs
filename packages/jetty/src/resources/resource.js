// resource.js — createResource for jetty.
//
// API mirrors @frontierjs/sierra/junction/resource.js exactly:
//   createResource('leads', schema, opts)
//   createResource('leads', opts)              // opts.schema optional
//   createResource({ service, model, schema, hooks, idField, optionsQuery })
//
// Returns: { service, store, make, load, context, hooks }
//
// Sierra's transport: client.service(name).find/get/create/...
// Jetty's transport:  harbor.request('service:call', { service, method, args })
//
// Push-event store population:
//   Sierra: client.resource(name, idField) auto-wires WS push events to its store
//   Jetty:  this module subscribes to harbor channels named `${name}:created`,
//           `${name}:patched`, `${name}:removed` and updates the store.
//
// See docs/future-refactors.md for the planned Option B extraction. Until that
// lands, this file is the canonical jetty-side implementation. Drift between
// here and Sierra's resource.js is the risk — if you change one, audit the
// other.

import { getActivePort }                     from './active-port.js'
import { createMakeFromSchema }              from './make-from-schema.js'
import { createStore }                       from './store.js'
import { runPhase, runAroundHooks, mergeHooks } from './hooks.js'

/**
 * Create a resource wrapper for a remote service, routed through harbor.
 *
 * Signatures (all mirror Sierra):
 *   createResource('leads', LeadSchema, { hooks, idField })
 *   createResource('leads', { schema, hooks, idField })
 *   createResource({ service, model, schema, hooks, idField, optionsQuery })
 *
 * @returns {{
 *   service: object,
 *   store:   ReturnType<typeof createStore>,
 *   make:    (spec?: object) => object,
 *   load:    (query?: object) => Promise<any>,
 *   context: { model: string, service: string, idField: string },
 *   hooks:   (incoming: object) => void,
 * }}
 */
export function createResource(nameOrSpec, schemaOrOpts = {}, maybeOpts = {}) {
  // Argument normalization (matches Sierra).
  let serviceName, model, optionsQuery, initialHooks, schema, idField

  if (typeof nameOrSpec === 'string') {
    serviceName = nameOrSpec
    if (looksLikeSchema(schemaOrOpts)) {
      schema       = schemaOrOpts
      initialHooks = maybeOpts.hooks       ?? {}
      idField      = maybeOpts.idField     ?? 'id'
      model        = maybeOpts.model       ?? serviceName
      optionsQuery = maybeOpts.optionsQuery
    } else {
      const opts   = schemaOrOpts
      schema       = opts.schema
      initialHooks = opts.hooks       ?? {}
      idField      = opts.idField     ?? 'id'
      model        = opts.model       ?? serviceName
      optionsQuery = opts.optionsQuery
    }
  } else {
    serviceName  = nameOrSpec.service
    model        = nameOrSpec.model        ?? serviceName
    optionsQuery = nameOrSpec.optionsQuery
    initialHooks = nameOrSpec.hooks        ?? {}
    schema       = nameOrSpec.schema
    idField      = nameOrSpec.idField      ?? 'id'
  }

  // Live hook map, mutable via the returned `hooks` callback.
  const _hooks = { before: {}, after: {}, around: {}, error: {} }
  mergeHooks(_hooks, initialHooks)

  // Schema-driven make() or pass-through.
  let make
  if (schema) {
    const properties = extractProperties(schema, serviceName, model)
    make = createMakeFromSchema(properties)
  } else {
    make = (spec) => Object.assign({}, spec)
  }

  // Local store, populated by load() and harbor channel:event push messages.
  const store = createStore({ idField })

  // Subscribe to push events. Idempotent — channels.subscribe in PagePort is
  // refcount-aware, so multiple resources subscribing to overlapping channels
  // is fine. We only subscribe lazily on first port availability to avoid
  // racing with auto-gen registration order.
  let _eventSubsAttached = false
  function attachEventSubs() {
    if (_eventSubsAttached) return
    const port = getActivePort()
    if (!port) return
    _eventSubsAttached = true

    // Channel naming convention: `<service>:<event>`. Harbor's job is to wire
    // these up to whatever Junction-side mechanism produces them. We assume
    // the standard Feathers/Junction event names.
    port.subscribe(`${serviceName}:created`, (record) => store.upsert(record))
    port.subscribe(`${serviceName}:patched`, (record) => store.upsert(record))
    port.subscribe(`${serviceName}:updated`, (record) => store.upsert(record))
    port.subscribe(`${serviceName}:removed`, (record) => {
      const id = record?.[idField]
      if (id != null) store.remove(id)
    })
  }

  // --- the call pipeline ---

  async function _call(method, id, data, query = {}) {
    // If the port isn't ready yet (e.g. resource imported during SSR / pre-mount),
    // throw a clear error rather than hanging. Apps should call resources from
    // within component lifecycle, not at module top level, when the port is ready.
    const port = getActivePort()
    if (!port) {
      throw new Error(
        `[resource:${serviceName}] no active port — call resource methods after the page mounts`
      )
    }

    // Lazy subscribe on first use.
    attachEventSubs()

    const ctx = {
      service: serviceName,
      model,
      method,
      id:      id   ?? null,
      data:    data ?? null,
      query,             // travels over the wire
      params:  {},       // client-side only — never sent to server
      result:  null,
      error:   null,
    }

    const aroundList = [
      ...(_hooks.around?.all      ?? []),
      ...(_hooks.around?.[method] ?? []),
    ]

    async function inner() {
      // before
      await runPhase(_hooks, 'before', method, ctx)

      // network call (via harbor)
      ctx.result = await dispatch(port, serviceName, method, ctx)

      // after
      await runPhase(_hooks, 'after', method, ctx)
    }

    try {
      await runAroundHooks(aroundList, ctx, inner)
    } catch (err) {
      ctx.error = err
      const errorList = [
        ...(_hooks.error?.all      ?? []),
        ...(_hooks.error?.[method] ?? []),
      ]
      if (errorList.length) {
        for (const hook of errorList) await hook(ctx)
        if (!ctx.error) return ctx.result // hook recovered
      }
      throw ctx.error ?? err
    }

    return ctx.result
  }

  // --- service proxy (mirrors Sierra's surface) ---

  const service = {
    find:    (query, _params) => _call('find',    null, null, query ?? {}),
    get:     (id)             => _call('get',     id,   null, {}),
    create:  (data)           => _call('create',  null, data, {}),
    patch:   (id, data)       => _call('patch',   id,   data, {}),
    remove:  (id)             => _call('remove',  id,   null, {}),
    restore: (id)             => _call('restore', id,   null, {}),

    /** create if no id, patch if has id */
    upsert: (data) => data?.[idField]
      ? _call('patch',  data[idField], data, {})
      : _call('create', null,          data, {}),

    /** fetch options list — uses optionsQuery by default */
    getOptions: (query) => _call('find', null, null, query ?? optionsQuery?.query ?? {}),

    /** subscribe to a server-pushed event for this service */
    on(event, handler) {
      const port = getActivePort()
      if (!port) {
        console.warn(`[resource:${serviceName}] .on(${event}) called before port active — skipping`)
        return () => {}
      }
      return port.subscribe(`${serviceName}:${event}`, handler)
    },

    /** explicit untyped call — bypasses the standard methods */
    call: (method, id, data) => _call(method, id, data, {}),
  }

  // load() — populate the local store via service.find
  async function load(query) {
    return store.populate(service, query ?? {})
  }

  // hooks() — append hooks after creation
  function addHooks(incoming) {
    mergeHooks(_hooks, incoming)
  }

  const context = { model, service: serviceName, idField }

  return { service, store, make, load, context, hooks: addHooks }
}

// --- internal helpers ---

function looksLikeSchema(x) {
  if (!x || typeof x !== 'object') return false
  return '$defs' in x || 'definitions' in x || 'properties' in x
}

function extractProperties(schema, serviceName, model) {
  return schema?.$defs?.[serviceName]?.properties
      ?? schema?.$defs?.[model]?.properties
      ?? schema?.definitions?.[serviceName]?.properties
      ?? schema?.definitions?.[model]?.properties
      ?? schema?.properties
      ?? schema
}

/**
 * Send the call through harbor and unwrap the response. Format matches Phase 2's
 * harbor message router:
 *   send: service:call { service, method, args, _requestId }
 *   recv: response:<id> { value | _error }
 */
async function dispatch(port, serviceName, method, ctx) {
  // Build the args object based on method semantics.
  // Harbor's router forwards `args` to adapter.call(service, method, args) —
  // the adapter is responsible for mapping that onto the wire format.
  let args
  switch (method) {
    case 'find':              args = { query: ctx.query };                       break
    case 'get':                args = { id: ctx.id ?? ctx.query };                break
    case 'create':             args = { data: ctx.data };                         break
    case 'patch':              args = { id: ctx.id, data: ctx.data };             break
    case 'remove':             args = { id: ctx.id };                             break
    case 'restore':            args = { id: ctx.id };                             break
    default:                   args = { id: ctx.id, data: ctx.data, method };     break
  }

  return port.request('service:call', {
    service: serviceName,
    method,
    args,
  })
}
