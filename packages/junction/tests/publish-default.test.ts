// tests/publish-default.test.ts
//
// FJS-334. Junction had two ways to broadcast and both were per service:
// `channel:` on the definition, and a publish() hook in `after`. Feathers has a
// third that Junction had no equal for — `app.publish(fn)`, one catch-all
// deciding where EVERY service event goes, which is how a tenant-shaped app
// writes "everything a caller may hear goes to their own account channel" once
// instead of once per service.
//
// The natural workaround is not merely undocumented, it is REFUSED:
// `after: { all: [publish(fn)] }` trips refuseDoubleBroadcast for every service
// that also declares `channel:` (see double-broadcast.test.ts), which is most of
// them. So the catch-all had no spelling at all.
//
// `app.channels.publishDefault(fn)` is that spelling, and it is a DEFAULT rather
// than a second broadcaster: consulted only where a service declares nothing, so
// it composes with `channel:` instead of racing it and cannot put one record on
// the wire twice.
//
// The manager here is the REAL one, not a stub with a `publish` that records —
// the whole question is which channel the frame is resolved onto, and a stub
// that ignores the resolver answers it by construction.

import { describe, test, expect } from 'bun:test'
import { createService, callService } from '../src/core/service.ts'
import { createChannelManager, publish, channels } from '../src/transport/channels.ts'
import { createApp } from '../src/core/app.ts'
import type { ServiceContext } from '../src/transport/bridge.ts'

type Manager = ReturnType<typeof createChannelManager>

// A connection whose socket keeps every frame, joined to one channel. The frame
// is what a browser would receive, so an assertion on it is an assertion about
// the wire rather than about our own bookkeeping.
function subscriber(manager: Manager, channelName: string) {
  const frames: string[] = []
  const conn = {
    id:     `c-${channelName}`,
    socket: { send: (d: string) => { frames.push(d); return 1 }, close: () => {}, readyState: 1 },
    data:   {},
  }
  manager.channel(channelName).join(conn as never)
  return { frames, events: () => frames.map(f => (JSON.parse(f) as { event: string }).event) }
}

function ctx(manager: Manager, method: string, over: Record<string, unknown> = {}): ServiceContext {
  return {
    service: 'posts', method, id: 1, data: { title: 'x' },
    params: {}, query: {}, directives: {}, auth: {}, client: {},
    locals: { __channels: manager }, app: {},
    // Non-null result reads as "a before hook already answered" and skips the
    // method — the same trap event-origin.test.ts documents.
    result: null, error: null,
    ...over,
  } as unknown as ServiceContext
}

const svc = (over: Record<string, unknown> = {}) => createService({
  name:   'posts',
  create: async () => ({ id: 1, title: 'x' }),
  ...over,
} as never)

describe('the app-level default publisher', () => {

  test('a service declaring nothing broadcasts on the default', async () => {
    const manager = createChannelManager()
    const all = subscriber(manager, 'all')
    manager.publishDefault(() => manager.channel('all'))

    await callService(svc(), ctx(manager, 'create'))

    expect(all.events()).toEqual(['posts created'])
  })

  test('with no default registered it still broadcasts nothing', async () => {
    // The ruled behaviour (DECISIONS.md § API design, 2026-08-02) and the whole
    // reason this is a default rather than an on-by-default: a broadcast does
    // not re-evaluate @@allow per subscriber.
    const manager = createChannelManager()
    const all = subscriber(manager, 'all')

    await callService(svc(), ctx(manager, 'create'))

    expect(all.frames).toHaveLength(0)
  })

  test('a service that declares channel: is not asked the default', async () => {
    const manager = createChannelManager()
    const all  = subscriber(manager, 'all')
    const mine = subscriber(manager, 'posts')
    manager.publishDefault(() => manager.channel('all'))

    await callService(svc({ channel: 'posts' }), ctx(manager, 'create'))

    // The point of "a default, not a second broadcaster": one frame, and it went
    // where the service said.
    expect(mine.events()).toEqual(['posts created'])
    expect(all.frames).toHaveLength(0)
  })

  test('channel: false opts out of the default too', async () => {
    const manager = createChannelManager()
    const all = subscriber(manager, 'all')
    manager.publishDefault(() => manager.channel('all'))

    await callService(svc({ channel: false }), ctx(manager, 'create'))

    expect(all.frames).toHaveLength(0)
  })

  test('the default decides per record — returning null skips that one', async () => {
    // Why the string form is refused: one name for every service in the app is
    // the shape that hands a subscriber rows no policy would have let them read.
    const manager = createChannelManager()
    const all = subscriber(manager, 'all')
    manager.publishDefault((data) =>
      (data as { title?: string }).title === 'x' ? null : manager.channel('all'))

    await callService(svc(), ctx(manager, 'create'))

    expect(all.frames).toHaveLength(0)
  })

  test('registering one returns an unsubscribe that takes it back', async () => {
    const manager = createChannelManager()
    const all = subscriber(manager, 'all')
    const off = manager.publishDefault(() => manager.channel('all'))

    await callService(svc(), ctx(manager, 'create'))
    expect(all.frames).toHaveLength(1)

    off()
    await callService(svc(), ctx(manager, 'create'))
    expect(all.frames).toHaveLength(1)
  })

  test('it does not trip the double-broadcast refusal', () => {
    // A publish() HOOK beside channel: is still refused, and must be — both
    // send. The default is not a hook and never runs beside a declaration, so
    // nothing here changes for refuseDoubleBroadcast.
    const manager = createChannelManager()
    manager.publishDefault(() => null)

    expect(() => createService({ name: 'posts', model: 'Post', channel: 'posts' }).pipelines())
      .not.toThrow()
    expect(() => createService({
      name: 'posts', model: 'Post', channel: 'posts',
      hooks: { after: { create: [publish(() => null)] } },
    }).pipelines()).toThrow(/declares channel: and also runs a publish\(\) hook/)
  })
})

describe('describe() says where a service broadcasts', () => {

  // A function cannot cross the wire, so the description is a summary — and
  // `null` (declares nothing, asks the default) is not `false` (refuses it).
  test('the four states', () => {
    expect(createService({ name: 'a', model: 'A', channel: 'posts' } as never).describe().channel).toBe('posts')
    expect(createService({ name: 'b', model: 'B', channel: () => null } as never).describe().channel).toBe(true)
    expect(createService({ name: 'c', model: 'C', channel: false } as never).describe().channel).toBe(false)
    expect(createService({ name: 'd', model: 'D' } as never).describe().channel).toBe(null)
  })
})

describe('the fall-through report', () => {

  async function bootWith(
    setup:    (a: never) => void,
    services: Array<Record<string, unknown>>
  ): Promise<string[]> {
    const app  = createApp()
    for (const s of services) app.services.register(createService(s as never))
    app.configure(channels(setup as never))

    const lines: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => { lines.push(args.join(' ')) }
    try { await app._startForTest() } finally { console.warn = original }
    return lines.filter(l => l.includes('publishDefault'))
  }

  test('names the services that will broadcast without having said so', async () => {
    const lines = await bootWith(
      (a: never) => { (a as unknown as { channels: Manager }).channels.publishDefault(() => null) },
      [{ name: 'posts', model: 'Post' }, { name: 'notes', model: 'Note' }],
    )
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('posts')
    expect(lines[0]).toContain('notes')
  })

  test('silent with no default registered — that is the ruled state', async () => {
    // Reporting it there would fire on nearly every service in every app, which
    // is how a warning gets trained out.
    const lines = await bootWith(() => {}, [{ name: 'posts', model: 'Post' }])
    expect(lines).toHaveLength(0)
  })

  test('it extinguishes itself — channel: false drops a service from the list', async () => {
    const lines = await bootWith(
      (a: never) => { (a as unknown as { channels: Manager }).channels.publishDefault(() => null) },
      [{ name: 'posts', model: 'Post', channel: false }, { name: 'notes', model: 'Note', channel: 'notes' }],
    )
    expect(lines).toHaveLength(0)
  })
})
