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
// Return shapes — same contract as Sierra, see its resource.js header:
//   service.find(query, params) / getOptions()  → the list envelope
//                                                 { kind, object, data, total, limit, offset }
//   service.get/create/patch/remove/restore     → the record
//   load(query, params)                         → the ROWS (and sets the store)
//   store.get()                                 → the ROWS, never an envelope
//
// The rows live at `.data` on a find. Use load()/store for rendering a list,
// and service.find() when you need `total` for a pager. jetty's store accepts
// a bare array too, since an adapter is free to hand one back.
//
// See docs/future-refactors.md for the planned Option B extraction. Until that
// lands, this file is the canonical jetty-side implementation. Drift between
// here and Sierra's resource.js is the risk — if you change one, audit the
// other.

import { getActivePort }                        from './active-port.js'
import { createStore }                          from './store.js'
import { runPhase, runAroundHooks, mergeHooks } from '@frontierjs/toolbelt/hooks'
import { createMakeFromSchema }                 from '@frontierjs/toolbelt/jsonschema'

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
 *   load:    (query?: object, params?: object) => Promise<object[]>,
 *   context: { model: string, service: string, idField: string },
 *   hooks:   (incoming: object) => void,
 * }}
 */
// `posts created` → `created`. Junction's browser client splits a wire event on
// a space into (service, method), and this has to agree with it. Anything that
// does not split that way answers null rather than guessing — including an event
// for another service, which a channel is not required to keep out.
export function wireEventMethod(event, serviceName) {
  if (typeof event !== 'string') return null
  const parts = event.split(' ')
  if (parts.length !== 2) return null
  const [service, method] = parts
  return service === serviceName && method ? method : null
}

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

  // Live hook map, replaced by the returned `hooks` callback. Reassigned rather
  // than mutated: `mergeHooks` answers a new map (`FJS-059`).
  let _hooks = mergeHooks({ before: {}, after: {}, around: {}, error: {} }, initialHooks)

  // Schema-driven make() or pass-through.
  let make
  if (schema) {
    const modelDef = extractModelDef(schema, serviceName, model)
    // Two things `properties` alone cannot answer, and both were wrong while
    // this was a hand copy of Sierra's (`FJS-059`). An enum or a `@type(T)`
    // field arrives as a bare `{$ref}`, so without a resolver it has no `type`
    // to read; and `x-relations` is the ONLY place a relation exists on the
    // client — a belongsTo's local key is emitted as a plain integer, so a
    // foreign key seeded `0` reaches the server as customer #0.
    const fkFields = (modelDef?.['x-relations'] ?? []).flatMap((r) => r?.fields ?? [])
    make = createMakeFromSchema(modelDef?.properties ?? modelDef, {
      resolve:     (ref) => resolveAgainst(schema, ref),
      foreignKeys: fkFields,
    })
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

    // ONE subscription, to the CHANNEL, and the event decides what to do with
    // what arrives. This subscribed to four composed names — `posts:created`,
    // `posts:patched`, … — which was wrong twice over (`FJS-059`):
    //
    //   · A colon is the IN-PROCESS BUS spelling. The wire carries a space
    //     (`posts created`), and the separator is the discriminator rather than
    //     decoration — DECISIONS.md, 2026-08-02.
    //   · A channel and an event are not the same thing. In Junction you join
    //     `posts` and RECEIVE `posts created`; there is no channel per event, so
    //     none of the four could ever have matched.
    //
    // The past-tense names are Junction's own `AUTO_EVENT_MAP`, exported so a
    // consumer does not restate them. Nothing here composes a name any more —
    // it reads the one that arrived.
    port.subscribe(serviceName, (record, meta) => {
      const method = wireEventMethod(meta?.event, serviceName)
      if (method === 'removed') {
        const id = record?.[idField]
        if (id != null) store.remove(id)
        return
      }
      // created / updated / patched / restored, and a custom action, all mean
      // "here is a record" — the same fallback Junction's own browser client
      // applies, and the reason a REMOVE has to be recognised explicitly above.
      if (method) store.upsert(record)
    })
  }

  // --- the call pipeline ---

  async function _call(method, id, data, query = {}, directives = {}) {
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
      query,             // filters — travels over the wire
      directives,        // limit / offset / orderBy / select — also the wire
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

  // params is Junction's FindParams — { limit, offset, orderBy, select }. It
  // rides ctx.directives and is handed to the adapter alongside the query.
  // find() used to name the argument `_params` and drop it on the floor, so
  // paging an ordered list through a jetty resource silently returned the
  // server's default page. Same bug lived in Sierra's copy of this file.
  const service = {
    find:    (query, params) => _call('find',    null, null, query ?? {}, params ?? {}),
    get:     (id, params)    => _call('get',     id,   null, {},          params ?? {}),
    create:  (data)          => _call('create',  null, data, {}),
    patch:   (id, data)      => _call('patch',   id,   data, {}),
    remove:  (id)            => _call('remove',  id,   null, {}),
    restore: (id)            => _call('restore', id,   null, {}),

    /** create if no id, patch if has id */
    upsert: (data) => data?.[idField]
      ? _call('patch',  data[idField], data, {})
      : _call('create', null,          data, {}),

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

    /**
     * Subscribe to a server-pushed event for this service — `on('created', fn)`,
     * matching Junction's own `client.service(name).on(event, fn)`.
     *
     * The event is FILTERED here rather than composed into a subscription name.
     * It used to subscribe to `${serviceName}:${event}`, a channel that does not
     * exist: you join `posts` and receive `posts created` (`FJS-059`).
     */
    on(event, handler) {
      const port = getActivePort()
      if (!port) {
        console.warn(`[resource:${serviceName}] .on(${event}) called before port active — skipping`)
        return () => {}
      }
      return port.subscribe(serviceName, (data, meta) => {
        if (wireEventMethod(meta?.event, serviceName) === event) handler(data, meta)
      })
    },

    /** explicit untyped call — bypasses the standard methods */
    call: (method, id, data) => _call(method, id, data, {}),
  }

  // load() — populate the local store via service.find.
  // store.populate already accepted a params argument; load() never passed one,
  // so the store could only ever hold the server's default page.
  async function load(query, params) {
    return store.populate(service, query ?? {}, params ?? {})
  }

  // hooks() — append hooks after creation
  function addHooks(incoming) {
    _hooks = mergeHooks(_hooks, incoming)
  }

  const context = { model, service: serviceName, idField }

  return { service, store, make, load, context, hooks: addHooks }
}

// --- internal helpers ---

function looksLikeSchema(x) {
  if (!x || typeof x !== 'object') return false
  return '$defs' in x || 'definitions' in x || 'properties' in x
}

function extractModelDef(schema, serviceName, model) {
  return schema?.$defs?.[serviceName]
      ?? schema?.$defs?.[model]
      ?? schema?.definitions?.[serviceName]
      ?? schema?.definitions?.[model]
      ?? schema
}

/**
 * `$ref` → the definition it names, against whatever document was handed in.
 *
 * Sierra reads a registry its build populates; jetty has no such registry —
 * a resource is given the schema document directly — so the lookup is the
 * document's own table. An unresolvable ref answers null, which the kit reads
 * as *cannot follow* and falls back to the field's own keywords.
 */
function resolveAgainst(schema, ref) {
  if (typeof ref !== 'string') return null
  const name = ref.replace(/^#\/(\$defs|definitions)\//, '')
  const def = schema?.$defs?.[name] ?? schema?.definitions?.[name]
  return def && typeof def === 'object' ? def : null
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
  //
  // `params` is Junction's FindParams and is kept STRUCTURED here rather than
  // flattened into $limit/$offset/... Flattening is a wire concern and the
  // adapter owns the wire; doing it here would hardcode one adapter's dialect
  // into the resource layer. Omitted entirely when empty so adapters that
  // ignore it see the same args they always did.
  const params = ctx.directives && Object.keys(ctx.directives).length > 0
    ? ctx.directives
    : null

  let args
  switch (method) {
    case 'find':               args = { query: ctx.query };                       break
    case 'get':                args = { id: ctx.id ?? ctx.query };                break
    case 'create':             args = { data: ctx.data };                         break
    case 'patch':              args = { id: ctx.id, data: ctx.data };             break
    case 'remove':             args = { id: ctx.id };                             break
    case 'restore':            args = { id: ctx.id };                             break
    default:                   args = { id: ctx.id, data: ctx.data, method };     break
  }
  if (params) args.params = params

  return port.request('service:call', {
    service: serviceName,
    method,
    args,
  })
}
