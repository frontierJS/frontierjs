// tests/event-origin.test.ts
//
// A mutation is announced ONCE, in callService, and fans out to two consumers:
// the in-process bus (server-side reactions) and the channel manager (browsers).
//
// They used to be independent origins. callService emitted 'posts:created' on
// app.events; a separately-wired publish() after-hook put 'posts created' on the
// wire. Consequences, in order of how much they cost:
//
//   • two places derived the event name, and they disagreed — the wire got
//     present tense while every listener expected past tense
//   • ctx.dispatch = false suppressed the socket but NOT the bus, so a hook
//     that deliberately withheld a broadcast still handed the record to every
//     server-side subscriber, webhook fan-out included
//   • an app that forgot to wire the hook had half a real-time layer, silently
//
// Broadcasting is opt-in: `channel:` on the service. Off by default because
// @@allow row policies are enforced when a row is READ, and a broadcast does
// not re-evaluate them per subscriber. Feathers splits the same way — its core
// publishes nothing without a publisher; its generator writes one for you, as
// `fli make:*` now does.

import { describe, test, expect } from 'bun:test'
import { createService, callService } from '../src/core/service.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

// Captures both consumers so a test can assert they agree.
function harness() {
  const bus:      Array<{ event: string; data: unknown }> = []
  const channels: Array<{ event: string; data: unknown }> = []

  const events  = { emit: (event: string, data: unknown) => { bus.push({ event, data }) } }
  const manager = {
    channel: (name: string) => ({ name }),
    publish: async (event: string, data: unknown) => { channels.push({ event, data }) },
  }
  return { bus, channels, events, manager }
}

function ctx(h: ReturnType<typeof harness>, method: string, over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'posts', method, id: 1, data: { title: 'x' },
    params: {}, query: {}, directives: {}, auth: {}, client: {},
    locals: { __channels: h.manager }, app: {},
    // result MUST be null, not absent: runPipeline treats a non-null result as
    // "a before hook already answered" and skips the method entirely.
    result: null, error: null,
    ...over,
  } as unknown as ServiceContext
}

const svc = (over: Record<string, unknown> = {}) => createService({
  name:   'posts',
  create: async () => ({ id: 1, title: 'x' }),
  patch:  async () => ({ id: 1, title: 'y' }),
  remove: async () => ({ id: 1 }),
  find:   async () => [{ id: 1 }],
  get:    async () => ({ id: 1 }),
  ...over,
} as never)

describe('one decision, two consumers', () => {

  test('a write announces on both, with names that agree', async () => {
    const h = harness()
    await callService(svc({ channel: 'posts' }), ctx(h, 'create'), undefined, h.events)

    expect(h.bus).toHaveLength(1)
    expect(h.channels).toHaveLength(1)
    // Colon for the in-process bus, space for the wire — different separators,
    // same past-tense verb, derived in one place from AUTO_EVENT_MAP.
    expect(h.bus[0]!.event).toBe('posts:created')
    expect(h.channels[0]!.event).toBe('posts created')
    expect(h.bus[0]!.data).toEqual(h.channels[0]!.data)
  })

  test.each([
    ['create', 'posts:created', 'posts created'],
    ['patch',  'posts:patched', 'posts patched'],
    ['remove', 'posts:removed', 'posts removed'],
  ])('%s → %s / %s', async (method, busName, wireName) => {
    const h = harness()
    await callService(svc({ channel: 'posts' }), ctx(h, method), undefined, h.events)
    expect(h.bus[0]!.event).toBe(busName)
    expect(h.channels[0]!.event).toBe(wireName)
  })

  test('reads announce nothing', async () => {
    // Why this is per-method and not an `all` hook: `after: { all: [publish] }`
    // would broadcast every find to every connected socket.
    const h = harness()
    await callService(svc({ channel: 'posts' }), ctx(h, 'find'), undefined, h.events)
    await callService(svc({ channel: 'posts' }), ctx(h, 'get'),  undefined, h.events)
    expect(h.bus).toHaveLength(0)
    expect(h.channels).toHaveLength(0)
  })

  test('a failed write announces nothing', async () => {
    const h = harness()
    const failing = svc({ channel: 'posts', create: async () => { throw new Error('nope') } })
    await callService(failing, ctx(h, 'create'), undefined, h.events).catch(() => {})
    expect(h.bus).toHaveLength(0)
    expect(h.channels).toHaveLength(0)
  })
})

describe('ctx.dispatch is one switch for both', () => {

  test('false suppresses the bus as well as the socket', async () => {
    // THE regression this refactor exists for. Suppression used to reach only
    // the channel path, so withholding a broadcast still leaked the record to
    // every server-side subscriber.
    const h = harness()
    const s = svc({
      channel: 'posts',
      hooks: { after: { create: [function suppress(c: ServiceContext) { c.dispatch = false }] } },
    })
    await callService(s, ctx(h, 'create'), undefined, h.events)

    expect(h.bus).toHaveLength(0)
    expect(h.channels).toHaveLength(0)
  })

  test('a value replaces the payload for both', async () => {
    const h = harness()
    const s = svc({
      channel: 'posts',
      hooks: { after: { create: [function redact(c: ServiceContext) {
        c.dispatch = { id: 1, title: '[redacted]' }
      }] } },
    })
    await callService(s, ctx(h, 'create'), undefined, h.events)

    expect(h.bus[0]!.data).toEqual({ id: 1, title: '[redacted]' })
    expect(h.channels[0]!.data).toEqual({ id: 1, title: '[redacted]' })
  })
})

describe('broadcasting is opt-in', () => {

  test('no channel declared → bus only, no socket traffic', async () => {
    const h = harness()
    await callService(svc(), ctx(h, 'create'), undefined, h.events)

    expect(h.bus).toHaveLength(1)      // server-side reactions still work
    expect(h.channels).toHaveLength(0) // nothing reaches a browser
  })

  test('channel: false is an explicit opt-out', async () => {
    const h = harness()
    await callService(svc({ channel: false }), ctx(h, 'create'), undefined, h.events)
    expect(h.channels).toHaveLength(0)
  })

  test('the function form picks the target per call', async () => {
    const h = harness()
    const seen: unknown[] = []
    const s = svc({
      channel: (rows: unknown, c: ServiceContext) => { seen.push([rows, c.service]); return { name: 'scoped' } },
    })
    await callService(s, ctx(h, 'create'), undefined, h.events)

    expect(h.channels).toHaveLength(1)
    // The manager invokes the resolver; this asserts it was handed through.
    expect(h.channels[0]!.event).toBe('posts created')
  })

  test('no channels plugin loaded → no crash, bus unaffected', async () => {
    const h = harness()
    const bare = ctx(h, 'create', { locals: {} })
    await callService(svc({ channel: 'posts' }), bare, undefined, h.events)
    expect(h.bus).toHaveLength(1)
    expect(h.channels).toHaveLength(0)
  })
})

describe('bulk writes announce once per record', () => {

  test('three rows → three events on each consumer', async () => {
    // Feathers' behaviour, and required by the browser store: created/patched/
    // removed handlers each take ONE record, so a single event carrying an
    // array would land as one malformed upsert. Bulk create only started
    // working recently, which is what made this path reachable.
    const h = harness()
    const s = svc({
      channel: 'posts',
      create:  async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
    })
    await callService(s, ctx(h, 'create'), undefined, h.events)

    expect(h.bus).toHaveLength(3)
    expect(h.channels).toHaveLength(3)
    expect(h.bus.map(e => (e.data as { id: number }).id)).toEqual([1, 2, 3])
    expect(h.bus.every(e => e.event === 'posts:created')).toBe(true)
  })

  test('an empty bulk result announces nothing', async () => {
    const h = harness()
    await callService(svc({ channel: 'posts', create: async () => [] }), ctx(h, 'create'), undefined, h.events)
    expect(h.bus).toHaveLength(0)
  })
})

describe('`channel` as an option does not steal `publish` as an action name', () => {

  test('a service can still have a publish() action', async () => {
    // The reason the option is `channel` and not `publish`: publishing a draft
    // is an ordinary action, and the openapi suite has a posts service with
    // exactly that. A noun cannot collide with a verb.
    let called = false
    const s = createService({
      name: 'posts',
      channel: 'posts',
      async publish() { called = true; return { published: true } },
    } as never)

    const h = harness()
    const c = ctx(h, 'publish')
    await callService(s, c, undefined, h.events)

    expect(called).toBe(true)
    // An action IS a write, so it announces under its own name (see below).
    expect(h.bus).toHaveLength(1)
    expect(h.bus[0]!.event).toBe('posts:publish')
  })
})

describe('a custom action announces too', () => {
  // Until 2026-08-06 only AUTO_EVENT_MAP counted, so an action changed a row
  // and told nobody. Proved against `example/`: a watcher tab saw `orders
  // created` and `orders removed` cross the socket and never saw the `pay` in
  // between, while the row it was looking at silently became stale. The browser
  // client had listened for action events since it was written — its '*'
  // handler upserts any non-CRUD event — so only the server half was missing.

  const acting = (over: Record<string, unknown> = {}) => svc({
    channel: 'posts',
    archive: async () => ({ id: 1, archived: true }),
    ...over,
  })

  test('announces on both, under its own name, no past tense invented', async () => {
    const h = harness()
    await callService(acting(), ctx(h, 'archive'), undefined, h.events)

    expect(h.bus).toHaveLength(1)
    expect(h.channels).toHaveLength(1)
    expect(h.bus[0]!.event).toBe('posts:archive')
    expect(h.channels[0]!.event).toBe('posts archive')
    // The record, so the client's '*' handler can upsert it.
    expect(h.channels[0]!.data).toEqual({ id: 1, archived: true })
    expect(h.bus[0]!.data).toEqual(h.channels[0]!.data)
  })

  test('`ctx.dispatch = false` is how a read-shaped action opts out', async () => {
    // search/stats/export return rows they did not write. One switch, the same
    // one that suppresses any other broadcast — and it suppresses BOTH
    // consumers, which is the whole point of one origin.
    const h = harness()
    await callService(acting(), ctx(h, 'archive', { dispatch: false }), undefined, h.events)

    expect(h.bus).toHaveLength(0)
    expect(h.channels).toHaveLength(0)
  })

  test('`ctx.dispatch = value` reshapes an action payload as it does a write', async () => {
    const h = harness()
    await callService(acting(), ctx(h, 'archive', { dispatch: { id: 1 } }), undefined, h.events)

    expect(h.channels[0]!.data).toEqual({ id: 1 })
  })

  test('a failed action announces nothing', async () => {
    const h = harness()
    const boom = acting({ archive: async () => { throw new Error('nope') } })
    await callService(boom, ctx(h, 'archive'), undefined, h.events).catch(() => {})

    expect(h.bus).toHaveLength(0)
    expect(h.channels).toHaveLength(0)
  })

  test('a read still announces nothing — find and get are excluded by name', async () => {
    const h = harness()
    await callService(acting(), ctx(h, 'find'), undefined, h.events)
    await callService(acting(), ctx(h, 'get'),  undefined, h.events)

    expect(h.bus).toHaveLength(0)
    expect(h.channels).toHaveLength(0)
  })

  test('no `channel:` still means no broadcast, action or not', async () => {
    const h = harness()
    await callService(acting({ channel: undefined }), ctx(h, 'archive'), undefined, h.events)

    expect(h.channels).toHaveLength(0)
    expect(h.bus).toHaveLength(1)      // server-side reactions still work
  })
})
