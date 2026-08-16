// Phase 3 unit tests — Resources.
//
// Coverage:
//   - createMakeFromSchema: types, defaults, anyOf, nullable, date-time, skip, clone semantics
//   - createStore: subscribe/upsert/remove/populate/notify
//   - hooks (mergeHooks, runPhase, runAroundHooks, runHooks)
//   - createResource: argument normalization, dispatch via mock port,
//     hook pipeline (before/after/around/error), error recovery,
//     channel subscription auto-wiring, push event store updates
//   - login/logout (mocked port)
//   - getConnectionState reflects port lifecycle + session events
//   - useStore fallback (no Mesa runtime) — Mesa-runtime path covered manually
//     when Mesa is linked

let pass = 0
let fail = 0
function ok(msg)        { pass++; console.log('  ✓', msg) }
function bad(msg, info) { fail++; console.log('  ✗', msg); if (info) console.log('     →', info) }
function group(name)    { console.log(`\n[${name}]`) }

// --- mock PagePort ---
//
// Just enough surface to drive resources: send + on (for channel:event) +
// onDisconnect + onReconnect + subscribe + request. The real PagePort tests
// (Phase 1/2.5) cover the underlying behavior; here we focus on resources.

function mockPagePort() {
  const handlers       = new Map()
  const subscriptions  = new Map() // channel → handler
  const lifecycleHooks = { disconnect: new Set(), reconnect: new Set() }
  let _requestHandlers = []  // shifts out as requests come in
  const _sentMessages  = []

  const port = {
    type: 'dock', id: 'dock', session: null,
    send(type, payload) { _sentMessages.push({ type, payload }); return true },
    on(type, fn) {
      let set = handlers.get(type)
      if (!set) { set = new Set(); handlers.set(type, set) }
      set.add(fn)
      return () => set.delete(fn)
    },
    off(type, fn) { handlers.get(type)?.delete(fn) },
    onDisconnect(fn) { lifecycleHooks.disconnect.add(fn); return () => lifecycleHooks.disconnect.delete(fn) },
    onReconnect(fn)  { lifecycleHooks.reconnect.add(fn);  return () => lifecycleHooks.reconnect.delete(fn) },
    subscribe(channel, handler) {
      subscriptions.set(channel, handler)
      return () => subscriptions.delete(channel)
    },
    async request(type, payload, opts) {
      // Test injects expected responses via _enqueueResponse.
      const responder = _requestHandlers.shift()
      if (!responder) {
        throw new Error(`mockPagePort: unexpected request "${type}" — no responder enqueued`)
      }
      return responder(type, payload, opts)
    },

    // Test helpers
    _emit(type, payload) {
      const set = handlers.get(type)
      if (!set) return
      for (const fn of set) fn(payload, { type, payload })
    },
    // (channel, data, event) — a channel carries MANY events, and `event` is the
    // wire name Junction sends: `widgets created`, space-separated, past tense.
    // The mock used to take only a channel, which is how a test came to pin the
    // bug: it asserted four subscriptions to names the server never publishes.
    _emitChannel(channel, data, event) {
      const handler = subscriptions.get(channel)
      if (handler) handler(data, { channel, data, event })
    },
    _emitDisconnect() { for (const fn of lifecycleHooks.disconnect) fn() },
    _emitReconnect()  { for (const fn of lifecycleHooks.reconnect) fn() },
    _enqueueResponse(fn) { _requestHandlers.push(fn) },
    _sentMessages: () => _sentMessages,
    _activeSubscriptions: () => [...subscriptions.keys()],
  }

  return port
}

// --- createMakeFromSchema ---

group('createMakeFromSchema')
{
  const { createMakeFromSchema } = await import('../src/resources/make-from-schema.js')

  // Basic types
  {
    const make = createMakeFromSchema({
      name:   { type: 'string' },
      age:    { type: 'integer' },
      score:  { type: 'number' },
      active: { type: 'boolean' },
      tags:   { type: 'array' },
      meta:   { type: 'object' },
    })
    const inst = make()
    if (inst.name === '' && inst.age === 0 && inst.score === 0 && inst.active === false) ok('basic primitives default correctly')
    if (Array.isArray(inst.tags) && inst.tags.length === 0) ok('array defaults to []')
    if (typeof inst.meta === 'object' && inst.meta !== null) ok('object defaults to {}')
  }

  // Skipped fields (id, createdAt, updatedAt by default)
  {
    const make = createMakeFromSchema({
      id:        { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
      name:      { type: 'string' },
    })
    const inst = make()
    if (!('id' in inst) && !('createdAt' in inst) && !('updatedAt' in inst)) ok('default skip omits id/createdAt/updatedAt')
    if (inst.name === '') ok('non-skipped field defaults still populated')
  }

  // Custom skip
  {
    const make = createMakeFromSchema(
      { secret: { type: 'string' }, name: { type: 'string' } },
      ['secret']
    )
    if (!('secret' in make())) ok('custom skip honored')
  }

  // Explicit default wins
  {
    const make = createMakeFromSchema({ status: { type: 'string', default: 'pending' } })
    if (make().status === 'pending') ok('explicit default beats type default')
  }

  // anyOf nullable
  {
    const make = createMakeFromSchema({
      bio: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    })
    if (make().bio === '') ok('anyOf [string|null] resolves to non-null type')
  }

  // type as array (nullable shorthand)
  {
    const make = createMakeFromSchema({
      bio: { type: ['string', 'null'] },
    })
    if (make().bio === '') ok('type: [string, null] picks non-null')
  }

  // date-time → undefined
  {
    const make = createMakeFromSchema({
      due: { type: 'string', format: 'date-time' },
    }, [])
    if (make().due === undefined) ok('date-time string defaults to undefined')
  }

  // spec override
  {
    const make = createMakeFromSchema({ name: { type: 'string' }, age: { type: 'integer' } })
    const inst = make({ name: 'Alice', age: 30 })
    if (inst.name === 'Alice' && inst.age === 30) ok('make(spec) merges spec over defaults')
  }

  // Each instance gets its own arrays/objects (no shared refs)
  {
    const make = createMakeFromSchema({ tags: { type: 'array' }, meta: { type: 'object' } })
    const a = make()
    const b = make()
    a.tags.push('x')
    a.meta.foo = 1
    if (b.tags.length === 0 && !('foo' in b.meta)) ok('arrays/objects cloned per instance')
    else bad('shared refs detected', `b.tags=${JSON.stringify(b.tags)}, b.meta=${JSON.stringify(b.meta)}`)
  }

  // Unknown type → null
  {
    const make = createMakeFromSchema({ weird: { type: 'unknown-type' } })
    if (make().weird === null) ok('unknown type → null')
  }

  // Empty/missing properties
  {
    const make = createMakeFromSchema(undefined)
    if (typeof make === 'function' && Object.keys(make()).length === 0) ok('empty properties produces no-op make')
  }
}

// --- createStore ---

group('createStore')
{
  const { createStore } = await import('../src/resources/store.js')

  {
    const store = createStore({ initial: [{ id: 1, name: 'Alice' }] })
    if (store.get().length === 1) ok('initial seeds data')

    let lastValue = null
    const off = store.subscribe((v) => { lastValue = v })
    if (lastValue?.length === 1) ok('subscribe fires immediately with current value')

    store.upsert({ id: 2, name: 'Bob' })
    if (lastValue.length === 2) ok('upsert appends new record')

    store.upsert({ id: 1, name: 'Alice (updated)' })
    if (lastValue.length === 2 && lastValue[0].name === 'Alice (updated)') ok('upsert replaces existing by id')

    store.remove(1)
    if (lastValue.length === 1 && lastValue[0].id === 2) ok('remove drops by id')

    store.remove(999) // no-op for missing id
    if (lastValue.length === 1) ok('remove of missing id is no-op')

    store.set([])
    if (lastValue.length === 0) ok('set replaces wholesale')

    off()
    store.upsert({ id: 99 })
    if (lastValue.length === 0) ok('unsubscribe stops notifications')
  }

  // populate via service.find
  {
    const store = createStore()
    const service = { find: async () => [{ id: 1 }, { id: 2 }, { id: 3 }] }
    await store.populate(service)
    if (store.get().length === 3) ok('populate via service.find seeds store')
  }

  // populate w/ paged response (data field)
  {
    const store = createStore()
    const service = { find: async () => ({ data: [{ id: 5 }], total: 1 }) }
    await store.populate(service)
    if (store.get().length === 1 && store.get()[0].id === 5) ok('populate handles { data, total } shape')
  }

  // custom idField
  {
    const store = createStore({ idField: 'uuid', initial: [{ uuid: 'a' }, { uuid: 'b' }] })
    store.remove('a')
    if (store.get().length === 1 && store.get()[0].uuid === 'b') ok('custom idField for remove')
  }
}

// --- hooks ---

group('hooks')
{
  const { mergeHooks, runPhase, runAroundHooks, runHooks } = await import('../src/resources/hooks.js')

  // mergeHooks order
  {
    const target = { before: { all: [() => 'A'] } }
    mergeHooks(target, { before: { all: [() => 'B'], find: [() => 'F'] } })
    if (target.before.all.length === 2 && target.before.all[0]() === 'A' && target.before.all[1]() === 'B') ok('mergeHooks preserves existing-then-new order')
    if (target.before.find.length === 1) ok('mergeHooks adds new method-specific lists')
  }

  // runPhase calls all then method
  {
    const order = []
    const map = {
      before: {
        all:  [(c) => order.push(`all-${c.method}`)],
        find: [(c) => order.push(`find-${c.method}`)],
      },
    }
    await runPhase(map, 'before', 'find', { method: 'find' })
    if (JSON.stringify(order) === '["all-find","find-find"]') ok('runPhase fires all-hooks before method-hooks')
  }

  // runHooks empty
  {
    let ran = 0
    await runHooks([], {})
    await runHooks(null, {})
    await runHooks(undefined, {})
    if (ran === 0) ok('runHooks no-ops on empty/null/undefined')
  }

  // runAroundHooks composes nested chain
  {
    const order = []
    const list = [
      async (ctx, next) => { order.push('A:before'); await next(); order.push('A:after') },
      async (ctx, next) => { order.push('B:before'); await next(); order.push('B:after') },
    ]
    await runAroundHooks(list, {}, async () => { order.push('inner') })
    if (JSON.stringify(order) === '["A:before","B:before","inner","B:after","A:after"]') ok('runAroundHooks composes onion-style')
  }

  // around can short-circuit by not calling next()
  {
    let innerRan = false
    await runAroundHooks([
      async () => { /* don't call next */ },
    ], {}, async () => { innerRan = true })
    if (!innerRan) ok('around hook can short-circuit by skipping next()')
  }
}

// --- createResource ---

group('createResource — argument forms + service proxy')
{
  // We need to register a port in active-port before createResource works.
  const { _registerActivePort } = await import('../src/resources/active-port.js')
  const { createResource } = await import('../src/resources/resource.js')

  const port = mockPagePort()
  _registerActivePort(port)

  // Form 1: createResource('leads', schema, opts)
  {
    const schema = {
      $defs: {
        leads: {
          properties: { name: { type: 'string' }, status: { type: 'string', default: 'new' } },
        },
      },
    }
    const r = createResource('leads', schema, { idField: 'id' })
    if (r.context.service === 'leads' && r.context.idField === 'id') ok('form 1: name + schema + opts')
    if (r.make().status === 'new') ok('form 1: schema-driven make() works')
  }

  // Form 2: createResource('leads', { schema, hooks })
  {
    const r = createResource('jobs', { schema: { properties: { title: { type: 'string' } } } })
    if (r.make().title === '') ok('form 2: name + opts (with schema)')
  }

  // Form 3: object form
  {
    const r = createResource({ service: 'tasks', model: 'Task', schema: { properties: { name: { type: 'string' } } } })
    if (r.context.service === 'tasks' && r.context.model === 'Task') ok('form 3: object form')
  }

  // No schema — make returns Object.assign({}, spec)
  {
    const r = createResource('plain')
    const inst = r.make({ a: 1 })
    if (inst.a === 1 && Object.keys(inst).length === 1) ok('no schema → make is pass-through')
  }

  // Service surface present
  {
    const r = createResource('plain')
    const expected = ['find', 'get', 'create', 'patch', 'remove', 'restore', 'upsert', 'getOptions', 'on', 'call']
    let allPresent = true
    for (const m of expected) {
      if (typeof r.service[m] !== 'function') {
        bad(`service.${m} missing`)
        allPresent = false
        break
      }
    }
    if (allPresent) ok('service has all 10 expected methods')
  }
}

group('createResource — dispatch through harbor port')
{
  const { _registerActivePort } = await import('../src/resources/active-port.js')
  const { createResource } = await import('../src/resources/resource.js')

  const port = mockPagePort()
  _registerActivePort(port)
  const r = createResource('leads')

  // service.find → request('service:call', { service:'leads', method:'find', args:{query:...}})
  {
    port._enqueueResponse((type, payload) => {
      if (type !== 'service:call') return Promise.reject(new Error('wrong type'))
      if (payload.service !== 'leads' || payload.method !== 'find') return Promise.reject(new Error('wrong target'))
      if (JSON.stringify(payload.args.query) !== '{"status":"active"}') return Promise.reject(new Error('wrong args'))
      return [{ id: 1, name: 'Acme' }]
    })
    const result = await r.service.find({ status: 'active' })
    if (result?.length === 1 && result[0].id === 1) ok('find → service:call w/ query in args')
  }

  // service.get
  {
    port._enqueueResponse((type, payload) => {
      if (payload.method !== 'get' || payload.args.id !== 7) return Promise.reject(new Error('wrong'))
      return { id: 7, name: 'Bob' }
    })
    const result = await r.service.get(7)
    if (result?.id === 7) ok('get → service:call w/ id in args')
  }

  // service.create
  {
    port._enqueueResponse((type, payload) => {
      if (payload.method !== 'create' || payload.args.data?.name !== 'New') return Promise.reject(new Error('wrong'))
      return { id: 99, name: 'New' }
    })
    const result = await r.service.create({ name: 'New' })
    if (result?.id === 99) ok('create → service:call w/ data in args')
  }

  // service.patch
  {
    port._enqueueResponse((type, payload) => {
      if (payload.method !== 'patch' || payload.args.id !== 1 || payload.args.data?.name !== 'P') return Promise.reject(new Error('wrong'))
      return { id: 1, name: 'P' }
    })
    const result = await r.service.patch(1, { name: 'P' })
    if (result?.name === 'P') ok('patch → service:call w/ id+data in args')
  }

  // service.upsert (no id → create)
  {
    port._enqueueResponse((type, payload) => {
      if (payload.method !== 'create') return Promise.reject(new Error('expected create for upsert without id'))
      return { id: 5, name: 'X' }
    })
    const result = await r.service.upsert({ name: 'X' })
    if (result?.id === 5) ok('upsert without id → create')
  }

  // service.upsert (with id → patch)
  {
    port._enqueueResponse((type, payload) => {
      if (payload.method !== 'patch' || payload.args.id !== 5) return Promise.reject(new Error('expected patch'))
      return { id: 5, name: 'X2' }
    })
    const result = await r.service.upsert({ id: 5, name: 'X2' })
    if (result?.name === 'X2') ok('upsert with id → patch')
  }

  // service.on(event, handler) → port.subscribe(`<service>:<event>`, handler)
  {
    let received = null
    r.service.on('custom-event', (data) => { received = data })
    if (port._activeSubscriptions().includes('leads:custom-event')) ok('service.on subscribes to <service>:<event>')

    port._emitChannel('leads', { foo: 1 }, 'leads custom-event')
    if (received?.foo === 1) ok('service.on handler fires on channel:event')
  }
}

group('createResource — hook pipeline')
{
  const { _registerActivePort } = await import('../src/resources/active-port.js')
  const { createResource } = await import('../src/resources/resource.js')

  const port = mockPagePort()
  _registerActivePort(port)

  // before + after fire in order around the call
  {
    const order = []
    const r = createResource('items', {
      hooks: {
        before: { find: [(c) => { order.push('before'); c.query.injected = 1 }] },
        after:  { find: [(c) => { order.push('after'); c.result.push({ id: 99 }) }] },
      },
    })

    port._enqueueResponse((type, payload) => {
      // verify before hook ran (injected query property visible to dispatch)
      if (payload.args.query.injected !== 1) return Promise.reject(new Error('before hook did not run'))
      order.push('call')
      return [{ id: 1 }]
    })

    const result = await r.service.find({ status: 'active' })
    if (JSON.stringify(order) === '["before","call","after"]') ok('before → call → after order')
    if (result.length === 2 && result[1].id === 99) ok('after hook can mutate ctx.result')
  }

  // around hook wraps everything (entry + exit)
  {
    const order = []
    const r = createResource('z', {
      hooks: {
        around: { all: [async (c, next) => { order.push('enter'); await next(); order.push('exit') }] },
        before: { all: [(c) => order.push('before')] },
        after:  { all: [(c) => order.push('after')] },
      },
    })
    port._enqueueResponse(() => { order.push('call'); return null })
    await r.service.find({})
    if (JSON.stringify(order) === '["enter","before","call","after","exit"]') ok('around wraps before+call+after')
  }

  // error hook can recover (clear ctx.error, resource returns ctx.result)
  {
    const r = createResource('e', {
      hooks: {
        error: { all: [(c) => { c.error = null; c.result = { fallback: true } }] },
      },
    })
    port._enqueueResponse(() => Promise.reject(new Error('boom')))
    const result = await r.service.find({})
    if (result?.fallback === true) ok('error hook recovery returns ctx.result')
  }

  // error hook can re-throw (leave ctx.error set, propagates up)
  {
    const r = createResource('e2', {
      hooks: {
        error: { all: [(c) => { /* don't clear */ }] },
      },
    })
    port._enqueueResponse(() => Promise.reject(new Error('still bad')))
    try {
      await r.service.find({})
      bad('error hook did not propagate')
    } catch (e) {
      if (e.message === 'still bad') ok('error hook propagates when not cleared')
    }
  }

  // resource.hooks() merges after creation
  {
    const order = []
    const r = createResource('m', { hooks: { before: { all: [() => order.push('first')] } } })
    r.hooks({ before: { all: [() => order.push('second')] } })
    port._enqueueResponse(() => null)
    await r.service.find({})
    if (JSON.stringify(order) === '["first","second"]') ok('resource.hooks() appends in order')
  }
}

group('createResource — channel push events update store')
{
  const { _registerActivePort } = await import('../src/resources/active-port.js')
  const { createResource } = await import('../src/resources/resource.js')

  const port = mockPagePort()
  _registerActivePort(port)
  const r = createResource('widgets')

  // ONE subscription, to the CHANNEL. This asserted four — `widgets:created`,
  // `widgets:patched`, … — names Junction has never published: a colon is the
  // in-process BUS spelling, the wire carries a space, and a channel is not an
  // event anyway (you join `widgets` and receive `widgets created`). The test
  // passed, which is how it came to pin the bug rather than catch it (FJS-059).
  port._enqueueResponse(() => [{ id: 1, name: 'a' }])
  await r.service.find({})

  const subs = port._activeSubscriptions()
  if (subs.length === 1 && subs[0] === 'widgets') {
    ok('lazy subscribe attaches ONE subscription, to the channel')
  } else {
    bad('expected exactly one subscription to "widgets"', JSON.stringify(subs))
  }

  if (!subs.some((c) => c.includes(':'))) ok('no colon-spelled channel is subscribed to')
  else bad('a colon-spelled channel survived', JSON.stringify(subs))

  // Push event → store.upsert. The EVENT decides, not the channel.
  let storeData = null
  r.store.subscribe((d) => { storeData = d })

  port._emitChannel('widgets', { id: 2, name: 'b' }, 'widgets created')
  if (storeData?.find((x) => x.id === 2)) ok('widgets created → store.upsert')

  port._emitChannel('widgets', { id: 2, name: 'B' }, 'widgets patched')
  if (storeData?.find((x) => x.id === 2)?.name === 'B') ok('widgets patched → store.upsert (replaces)')

  port._emitChannel('widgets', { id: 2 }, 'widgets removed')
  if (!storeData?.find((x) => x.id === 2)) ok('widgets removed → store.remove')

  // THE REGRESSION THIS CLOSES. Every event arrived on one channel, so a
  // subscriber that cannot read the event name upserts whatever it is handed —
  // and a delete comes back onto the screen and stays until reload.
  port._emitChannel('widgets', { id: 3, name: 'c' }, 'widgets created')
  port._emitChannel('widgets', { id: 3 }, 'widgets removed')
  if (!storeData?.find((x) => x.id === 3)) ok('a remove is not mistaken for an upsert')
  else bad('remove was upserted — the event name is being ignored')

  // The bus spelling must not be honoured on the wire, or the two vocabularies
  // are interchangeable and the separator stops discriminating anything.
  port._emitChannel('widgets', { id: 4 }, 'widgets:created')
  if (!storeData?.find((x) => x.id === 4)) ok('the colon spelling is not accepted from the wire')
  else bad('a colon-spelled wire event was accepted')

  // An event for another service, which a channel is not required to keep out.
  port._emitChannel('widgets', { id: 5 }, 'gadgets created')
  if (!storeData?.find((x) => x.id === 5)) ok('an event for another service is ignored')
  else bad('an event for another service was applied')
}

group('the wire event names are Junction\'s, not a restatement of them')
{
  // The defect FJS-059 named was a VOCABULARY drift: jetty spoke a set of event
  // names Junction does not publish, and nothing could notice, because both
  // sides were only ever asserted against themselves.
  //
  // So this asks Junction. Its `AUTO_EVENT_MAP` is exported for exactly this —
  // "the channel publisher must agree with it" — and read here out of the
  // source, because jetty's tests run on plain node and that file is TypeScript.
  // A relative path, not the package name: `bun install` copies a workspace dep,
  // so an import by name would check the last install's snapshot.
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')

  const here = dirname(fileURLToPath(import.meta.url))
  const src  = readFileSync(join(here, '..', '..', 'junction', 'src', 'core', 'service.ts'), 'utf8')

  const decl = src.match(/export const AUTO_EVENT_MAP[^{]*\{([^}]*)\}/)
  const pairs = decl ? [...decl[1].matchAll(/(\w+)\s*:\s*'([^']+)'/g)].map((m) => [m[1], m[2]]) : []

  if (pairs.length >= 5) ok(`read ${pairs.length} auto-event names out of Junction`)
  else bad('could not read AUTO_EVENT_MAP from Junction — has it moved or changed shape?', decl ? decl[1] : 'no match')

  const { wireEventMethod } = await import('../src/resources/resource.js')

  // Every past-tense name Junction publishes must split back out of a wire
  // event the way this package reads it.
  let allSplit = true
  for (const [, pastTense] of pairs) {
    if (wireEventMethod(`widgets ${pastTense}`, 'widgets') !== pastTense) {
      allSplit = false
      bad(`wireEventMethod did not recover '${pastTense}'`, `widgets ${pastTense}`)
    }
  }
  if (allSplit && pairs.length) ok('every Junction auto-event splits back to its method')

  // And the store's REMOVE branch has to be keyed on the name Junction actually
  // sends for a remove. Hard-coding 'removed' here would restate the map again;
  // this reads it.
  const removeName = pairs.find(([method]) => method === 'remove')?.[1]
  if (removeName === 'removed') ok(`Junction publishes a remove as '${removeName}'`)
  else bad('Junction publishes a remove under a name this package does not handle', String(removeName))

  // The bus spelling is not the wire spelling, and must not split.
  if (wireEventMethod('widgets:created', 'widgets') === null) ok('the colon spelling does not split')
  else bad('a colon-spelled event split as though it were a wire event')

  if (wireEventMethod('widgets created', 'gadgets') === null) ok('another service\'s event does not split')
  if (wireEventMethod(undefined, 'widgets') === null) ok('a missing event name answers null rather than guessing')
}

group('createResource — load() populates store')
{
  const { _registerActivePort } = await import('../src/resources/active-port.js')
  const { createResource } = await import('../src/resources/resource.js')

  const port = mockPagePort()
  _registerActivePort(port)
  const r = createResource('items')

  port._enqueueResponse(() => [{ id: 1 }, { id: 2 }, { id: 3 }])
  const result = await r.load()
  if (result.length === 3 && r.store.get().length === 3) ok('load() sets store from find result')
}

group('createResource — no port active')
{
  const { _registerActivePort } = await import('../src/resources/active-port.js')
  const { createResource } = await import('../src/resources/resource.js')

  _registerActivePort(null)
  const r = createResource('orphan')

  try {
    await r.service.find({})
    bad('expected throw when no port active')
  } catch (e) {
    if (/no active port/.test(e.message)) ok('clear error when port not active')
    else bad('error message wrong', e.message)
  }
}

// --- login / logout ---

group('login / logout')
{
  const { _registerActivePort, login, logout } = await import('../src/resources/active-port.js')

  const port = mockPagePort()
  _registerActivePort(port)

  port._enqueueResponse((type, payload) => {
    if (payload.service === 'auth' && payload.method === 'login' && payload.args.email === 'a@b') {
      return { token: 'T', user: { id: 1, email: 'a@b' } }
    }
    return Promise.reject(new Error('wrong'))
  })
  const session = await login({ email: 'a@b', password: 'x' })
  if (session?.user?.id === 1) ok('login → service:call(auth, login) returns session')

  port._enqueueResponse((type, payload) => {
    if (payload.method === 'logout') return { ok: true }
    return Promise.reject(new Error('wrong'))
  })
  const logoutResult = await logout()
  if (logoutResult?.ok) ok('logout → service:call(auth, logout)')

  // No port → throws
  _registerActivePort(null)
  try { await login({}); bad('login w/o port should throw') }
  catch (e) {
    if (/no active port/.test(e.message)) ok('login throws clearly when no port')
  }
}

// --- connection state tracking ---

group('connection state')
{
  const { _registerActivePort, getConnectionState, onConnectionChange } = await import('../src/resources/active-port.js')

  const port = mockPagePort()
  _registerActivePort(port)

  let state = getConnectionState()
  if (state.connected === true) ok('connected = true after register')

  // Simulate harbor session message
  port._emit('session', { user: { id: 5 }, authenticated: true })
  state = getConnectionState()
  if (state.authenticated === true && state.user?.id === 5) ok('session message updates auth state')

  // Simulate disconnect
  port._emitDisconnect()
  state = getConnectionState()
  if (state.connected === false) ok('disconnect flips connected')

  // Reconnect
  port._emitReconnect()
  state = getConnectionState()
  if (state.connected === true) ok('reconnect flips connected back')

  // onConnectionChange fires
  let lastState = null
  const off = onConnectionChange((s) => { lastState = s })
  if (lastState?.connected === true) ok('onConnectionChange fires immediately with current')

  port._emit('schema', { version: 'v1', schema: {} })
  if (lastState?.schema?.version === 'v1') ok('schema message threads through state')

  off()
}

// --- useStore fallback (no Mesa runtime in sandbox) ---

group('useStore fallback')
{
  const { useStore } = await import('../src/resources/mesa-bridge.js')
  const { createStore } = await import('../src/resources/store.js')

  const store = createStore({ initial: [{ id: 1 }] })
  const wrapped = await useStore(store)

  if (typeof wrapped.get === 'function' && wrapped.value?.length === 1) ok('useStore returns get + value getter')

  store.upsert({ id: 2 })
  if (wrapped.value.length === 2) ok('useStore tracks store updates')

  wrapped.unsubscribe()
  store.upsert({ id: 3 })
  // After unsubscribe, value getter returns the last known value (no further updates)
  if (wrapped.value.length === 2) ok('useStore unsubscribe stops updates')
}

// --- FindParams threading ---
//
// service.find used to be written `(query, _params) => _call(...)` — the
// second argument was accepted and dropped, so paging or ordering a list
// through a jetty resource silently returned the server's default page.
// Sierra's copy of this file carried the identical bug.

group('createResource — FindParams reach the adapter')
{
  const { _registerActivePort } = await import('../src/resources/active-port.js')
  const { createResource } = await import('../src/resources/resource.js')

  const port = mockPagePort()
  _registerActivePort(port)

  // find(query, params) puts params on args, structured — not flattened.
  {
    let seen = null
    port._enqueueResponse((_t, payload) => { seen = payload.args; return [] })
    const r = createResource('leads')
    await r.service.find({ status: 'new' }, { limit: 25, offset: 50, orderBy: 'name' })

    if (JSON.stringify(seen?.query) === '{"status":"new"}') ok('find keeps query as filters only')
    if (seen?.params?.limit === 25 && seen?.params?.offset === 50 && seen?.params?.orderBy === 'name') {
      ok('find forwards FindParams to the adapter')
    } else bad('find forwards FindParams to the adapter', JSON.stringify(seen))
  }

  // Omitted when empty, so adapters that ignore params see the old args.
  {
    let seen = null
    port._enqueueResponse((_t, payload) => { seen = payload.args; return [] })
    const r = createResource('leads')
    await r.service.find({ status: 'new' })
    if (!('params' in (seen ?? {}))) ok('find omits params entirely when none are given')
    else bad('find omits params entirely when none are given', JSON.stringify(seen))
  }

  // get(id, params)
  {
    let seen = null
    port._enqueueResponse((_t, payload) => { seen = payload.args; return { id: '1' } })
    const r = createResource('leads')
    await r.service.get('1', { select: ['id', 'name'] })
    if (JSON.stringify(seen?.params?.select) === '["id","name"]') ok('get forwards FindParams')
    else bad('get forwards FindParams', JSON.stringify(seen))
  }

  // getOptions falls back to optionsQuery.params
  {
    let seen = null
    port._enqueueResponse((_t, payload) => { seen = payload.args; return [] })
    const r = createResource({
      service: 'categories',
      optionsQuery: { query: { active: true }, params: { orderBy: 'name', limit: 500 } },
    })
    await r.service.getOptions()
    if (JSON.stringify(seen?.query) === '{"active":true}' && seen?.params?.limit === 500) {
      ok('getOptions falls back to optionsQuery.params')
    } else bad('getOptions falls back to optionsQuery.params', JSON.stringify(seen))
  }

  // A before hook can set pagination, same as Sierra.
  {
    let seen = null
    port._enqueueResponse((_t, payload) => { seen = payload.args; return [] })
    const r = createResource('leads', {
      hooks: { before: { find: [ctx => { ctx.directives.limit = 5 }] } },
    })
    await r.service.find({})
    if (seen?.params?.limit === 5) ok('a before hook can set ctx.directives.limit')
    else bad('a before hook can set ctx.directives.limit', JSON.stringify(seen))
  }

  // load(query, params) — store.populate accepted params all along; load
  // never passed any, so the store could only hold the default page.
  {
    let seen = null
    port._enqueueResponse((_t, payload) => { seen = payload.args; return [{ id: 1 }, { id: 2 }] })
    const r = createResource('leads')
    const rows = await r.load({ status: 'new' }, { limit: 2 })

    if (seen?.params?.limit === 2) ok('load forwards FindParams')
    else bad('load forwards FindParams', JSON.stringify(seen))
    if (Array.isArray(rows) && rows.length === 2) ok('load resolves to the rows, matching Sierra')
    else bad('load resolves to the rows, matching Sierra', JSON.stringify(rows))
    if (r.store.get().length === 2) ok('load populates the store')
  }

  // The store holds rows whether find returns an array or a list envelope.
  {
    port._enqueueResponse(() => ({
      kind: 'list', object: 'leads', errors: [],
      data: [{ id: 7 }], total: 99, limit: 1, offset: 0,
    }))
    const r = createResource('leads')
    const rows = await r.load({})
    if (Array.isArray(rows) && rows[0]?.id === 7) ok('load unwraps a list envelope to rows')
    else bad('load unwraps a list envelope to rows', JSON.stringify(rows))
    if (r.store.get()[0]?.id === 7) ok('store holds rows, not the envelope')
  }
}

// --- summary ---

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
