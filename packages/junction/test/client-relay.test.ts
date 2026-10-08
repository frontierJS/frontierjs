// test/client-relay.test.ts — a client whose connection is somebody else's.
//
// An extension page cannot keep a socket: MV3 puts the connection in the
// service worker, and the page reaches it over a port. Such a page still needs
// the whole client — `resource()`'s live store, its matching, `stale`, the
// nodes — because that is what a Resource is built on, and a second copy of it
// for the page is the fork `FJS-D650` removed. So the page's client RELAYS:
// each call goes out as the frame the socket would have carried, the holder
// makes it with `forward()`, and pushes come back through `receive()`.
//
// Both ends are real clients over a real app. The relay function here is the
// whole of the port, minus serialization — jetty's own suite drives that half.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { createJunctionClient, type RelayedCall } from '../src/client/index.ts'

const ROOM = 'items-room'

let app: any
let url = ''
const rows: Array<Record<string, unknown>> = []

beforeAll(async () => {
  app = createApp({
    config: { port: 0, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http } },
  } as never)
  app.configure(channels((a: any) => {
    a.channels.on('connection', (_s: unknown, conn: unknown) => { a.channel(ROOM).join(conn) })
  }) as never)
  app.services.register(createService({
    name:    'items',
    methods: ['find', 'create'],
    async find(ctx: any) {
      const limit = ctx.directives?.limit ?? rows.length
      return rows.filter(r => ctx.query?.status === undefined || r.status === ctx.query.status)
        .slice(0, limit)
        .map(r => ({ ...r, transport: ctx.transport }))
    },
    async create(ctx: any) {
      const row = { id: rows.length + 1, ...ctx.data }
      rows.push(row)
      return row
    },
  } as never))
  await app.start()
  url = `http://127.0.0.1:${app.http.port}`
})

afterAll(async () => { await app?.stop() })

/** A holder on the given transport, and a page relaying to it. */
async function pair({ socket }: { socket: boolean }) {
  const holder: any = createJunctionClient({ url })
  if (socket) {
    holder.connect()
    for (let i = 0; i < 100 && !holder._wsReady; i++) await new Promise(r => setTimeout(r, 20))
    if (!holder._wsReady) throw new Error('holder socket never came up')
  }
  const sent: RelayedCall[] = []
  const page: any = createJunctionClient({
    relay: (call) => { sent.push(call); return holder.forward(call) },
  })
  holder.on('event', (event: string, data: unknown) => page.receive({ type: 'event', event, data }))
  page.receive({ type: 'connected' })
  return { holder, page, sent, close: () => holder.disconnect() }
}

describe('a relayed call is the call the holder would have made', () => {

  test('over the holder\'s socket, filters and directives arrive intact', async () => {
    rows.length = 0
    rows.push({ id: 1, status: 'paid' }, { id: 2, status: 'paid' }, { id: 3, status: 'draft' })
    const { page, sent, close } = await pair({ socket: true })

    const res = await page.service('items').find({ status: 'paid' }, { limit: 1 })
    expect(res.data).toEqual([{ id: 1, status: 'paid', transport: 'websocket' }])
    expect(res.total ?? res.data.length).toBeGreaterThan(0)
    // The frame is junction's own spelling — no envelope invented for the relay.
    expect(sent[0]).toMatchObject({ service: 'items', method: 'find', id: null, data: null })
    close()
  })

  test('over HTTP, when the holder has no socket, the same question gets the same rows', async () => {
    rows.length = 0
    rows.push({ id: 1, status: 'paid' }, { id: 2, status: 'paid' }, { id: 3, status: 'draft' })
    const { page } = await pair({ socket: false })

    const res = await page.service('items').find({ status: 'paid' }, { limit: 1 })
    expect(res.data).toEqual([{ id: 1, status: 'paid', transport: 'http' }])
  })

  test('a write relays and answers the record', async () => {
    rows.length = 0
    const { page, close } = await pair({ socket: true })
    const made = await page.service('items').create({ status: 'paid' })
    expect(made).toMatchObject({ id: 1, status: 'paid' })
    close()
  })
})

describe('a push reaches the relayed client\'s live store', () => {

  test('an event the holder hears lands in the page\'s resource store', async () => {
    rows.length = 0
    rows.push({ id: 1, status: 'paid' })
    const { page, close } = await pair({ socket: true })

    const { store, load } = page.resource('items')
    await load()
    expect(store.get().map((r: any) => r.id)).toEqual([1])

    app.channel(ROOM).send('items created', { id: 2, status: 'paid' })
    for (let i = 0; i < 50 && store.get().length < 2; i++) await new Promise(r => setTimeout(r, 20))
    expect(store.get().map((r: any) => r.id)).toEqual([1, 2])
    close()
  })

  test('a second `connected` is a reconnect, and emits resync', () => {
    const page: any = createJunctionClient({ relay: async () => null })
    let n = 0
    page.on('resync', () => { n++ })
    page.receive({ type: 'connected' })
    page.receive({ type: 'connected' })
    expect(n).toBe(1)
  })
})

describe('what only HTTP can carry is refused by name', () => {

  test('a findFirst, which travels as a URL', async () => {
    const page: any = createJunctionClient({ relay: async () => null })
    await expect(page.service('items').get({ status: 'paid' })).rejects.toThrow(/cannot be relayed/)
  })

  test('a raw route, which is HTTP by definition', async () => {
    const page: any = createJunctionClient({ relay: async () => null })
    await expect(page.fetch('/exports/orders')).rejects.toThrow(/cannot be relayed/)
  })

  test('connect() opens nothing — the holder owns the socket', () => {
    const page: any = createJunctionClient({ relay: async () => null })
    page.connect()
    expect(page._ws).toBeNull()
  })
})
