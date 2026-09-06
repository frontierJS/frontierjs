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
//   Jetty:  this module takes ONE subscription — to the channel named for the
//           service — and the wire event decides what happens to the store.
//           `removed` removes; anything else is a record, graded against the
//           query `load()` asked for (`@frontierjs/toolbelt/match`): in the
//           filter it is upserted, out of it removed, undecidable it reloads.
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
// The pure halves are `@frontierjs/toolbelt` and are shared rather than copied
// — `/hooks`, `/jsonschema` (`FJS-059`) and `/match` (`FJS-493`). What is left
// here is the ORCHESTRATION, which is genuinely jetty's: Sierra calls
// `client.service(name)`, this calls `harbor.request('service:call')`. Do not
// resync the two; move the next pure piece down instead.

import { getActivePort }                        from './active-port.js'
import { createStore }                          from './store.js'
import { runPhase, runAroundHooks, mergeHooks,
         hookContext, answered, hookChainMessage } from '@frontierjs/toolbelt/hooks'
import { createMakeFromSchema, fieldShapes }    from '@frontierjs/toolbelt/jsonschema'
import { matchesQuery }                         from '@frontierjs/toolbelt/match'

/**
 * Thrown when a hook pipeline ends with nobody having produced an answer — an
 * `around` that forgot `next()`, an `around` that swallowed the failure, or an
 * `error` hook that cleared `ctx.error` and set no result.
 *
 * Sierra throws the same sentence from a class of its own; the words have one
 * owner in `@frontierjs/toolbelt/hooks` and the class does not, because each
 * package's errors are its own surface.
 */
export class ResourceHookError extends Error {
  constructor(service, method, phase, cause) {
    super(hookChainMessage(service, method, phase))
    this.name    = 'ResourceHookError'
    this.service = service
    this.method  = method
    this.phase   = phase
    // The failure the error hook discarded. Without it the original is gone.
    if (cause !== undefined) this.cause = cause
  }
}

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

  // What `matchesQuery` reads, and all it reads: field name → { type }. Built
  // once from the schema this resource was given, `{}` where it was given none
  // — which is exactly what Sierra falls back to on a schema-registry miss, and
  // degrades exactly one way: a string operand against a numeric column reads
  // as no match, where the server's type affinity would have matched. A caller
  // filtering an Int column from a URL should pass the schema.
  let _fields = null
  function fieldRules() {
    if (_fields) return _fields
    if (!schema) return (_fields = {})
    const modelDef = extractModelDef(schema, serviceName, model)
    return (_fields = fieldShapes(modelDef, (ref) => resolveAgainst(schema, ref)))
  }

  // A record this store cannot grade means asking the server again, and a burst
  // of pushes is one question rather than N: they arrive together, and every
  // answer but the last is thrown away by the one after it. Coalesced onto a
  // microtask, and a reload already in flight is left to finish — its rows are
  // newer than the event that asked for this one.
  let _reloading = false
  let _reloadQueued = false
  function scheduleReload() {
    if (_reloadQueued || _reloading) return
    const query = store.query()
    if (query === null) return   // nothing has loaded yet; there is nothing to refresh
    _reloadQueued = true
    queueMicrotask(async () => {
      _reloadQueued = false
      _reloading = true
      try { await load(query, _lastParams) }
      catch (e) { console.warn(`[resource:${serviceName}] reload after an undecidable push failed:`, e?.message ?? e) }
      finally { _reloading = false }
    })
  }

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
      // applies, and the reason a REMOVE has to be recognized explicitly above.
      if (!method) return

      // …and a record is an announcement about a ROW, while this store is the
      // answer to a QUERY. Nothing on the wire says a row has left a filter —
      // there is no such event — so upserting whatever arrives put a row the
      // list had just filtered OUT straight back into it (`FJS-493`).
      //
      // `null` is *cannot decide from this record*: the filter names a column a
      // `select` dropped, or a relation, or is `$search`. Reloading is the only
      // honest answer and it is coalesced, because a burst of pushes would
      // otherwise be a burst of requests.
      const verdict = matchesQuery(fieldRules(), record, store.query() ?? {})
      if (verdict === true)  store.upsert(record)
      else if (verdict === false) {
        const id = record?.[idField]
        if (id != null) store.remove(id)
      } else scheduleReload()
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

    // `hookContext`, not a literal: `result` remembers whether anything set it,
    // which is the only thing separating a legitimate `null` from a pipeline no
    // hook completed. See the throw after runAroundHooks.
    const ctx = hookContext({
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
    })

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
        if (!ctx.error) {
          // Recovered from what? A hook that clears the error and sets no
          // result says the call succeeded and hands back the `null` the
          // context was born with. The original failure rides on `cause`.
          if (!answered(ctx)) throw new ResourceHookError(serviceName, method, 'error', err)
          return ctx.result // hook recovered
        }
      }
      throw ctx.error ?? err
    }

    // Nothing threw and nothing answered: an `around` that returned without
    // calling `next()`, or caught the failure and did not rethrow. Both used to
    // resolve the call to `null`, which a screen reads as an answer.
    if (!answered(ctx)) throw new ResourceHookError(serviceName, method, 'around')

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
  // `_lastParams` is remembered for the same reason the store remembers the
  // query: a reload after an undecidable push has to ask the question this list
  // was filled by, and a page-2 list refilled at page 1 is a different answer.
  let _lastParams = {}
  async function load(query, params) {
    _lastParams = params ?? {}
    return store.populate(service, query ?? {}, _lastParams)
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
