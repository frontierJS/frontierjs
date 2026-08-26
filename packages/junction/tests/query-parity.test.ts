// tests/query-parity.test.ts — the same filter, down both transports.
//
// The socket was always the correct half. `buildWsQuery` spreads filters into a
// JSON frame, so a boolean stayed a boolean and an operator object stayed an
// object; the HTTP leg `String()`d every scalar, `JSON.stringify`d every
// container and dropped `null` outright, and nothing on the far side turned any
// of it back. So an app worked until its socket dropped, and then silently
// filtered on text: `live: true` matched no rows, `{ id: { in: [1,2] } }`
// matched no rows, and `archivedAt: null` asked for every row instead of the
// null ones (`FJS-450`).
//
// Nothing here restates the encoding — that is `@frontierjs/toolbelt/query`'s
// own spec. What is asserted is that the two transports AGREE, which no unit
// test on either side can see.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { createJunctionClient }      from '../src/client/index.ts'

const PORT = 3487

/** typeof + value, so `5` and `"5"` cannot compare equal. */
const shape = (o: Record<string, unknown>) => Object.fromEntries(
  Object.entries(o ?? {}).map(([k, v]) => [k, `${typeof v}:${JSON.stringify(v)}`]))

let app: any
let overHttp: any
let overSocket: any

beforeAll(async () => {
  app = createApp({
    config: { port: PORT, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http } },
  } as never)
  app.configure(channels() as never)
  app.services.register(createService({
    name:    'probe',
    find:    async (ctx: any) => [{ transport: ctx.transport, q: shape(ctx.query) }],
    methods: ['find'],
  } as never))
  await app.start()

  overHttp   = createJunctionClient({ url: `http://127.0.0.1:${PORT}` })
  overSocket = createJunctionClient({ url: `http://127.0.0.1:${PORT}` })
  overSocket.connect()
  for (let i = 0; i < 100 && !overSocket._wsReady; i++) await new Promise(r => setTimeout(r, 50))
})

afterAll(async () => { await app?.stop() })

const ask = async (client: any, filter: Record<string, unknown>) => {
  const out = await client.service('probe').find(filter)
  return out.data[0]
}

const FILTERS: Array<[string, Record<string, unknown>]> = [
  ['a number',            { qty: 5 }],
  ['a boolean',           { live: true }],
  ['a false boolean',     { live: false }],
  ['null',                { archivedAt: null }],
  ['an operator object',  { id: { in: [1, 2] } }],
  ['a range',             { qty: { gte: 3, lt: 10 } }],
  ['an array',            { tag: ['x', 'y'] }],
  ['a leading-zero code', { sku: '007' }],
  ['numeric text',        { code: '5' }],
  ['text',                { status: 'active' }],
  ['an empty string',     { q: '' }],
]

describe('a filter means the same thing on both transports', () => {

  test('the two clients really are on different transports', async () => {
    expect((await ask(overHttp,   { a: 1 })).transport).toBe('http')
    expect((await ask(overSocket, { a: 1 })).transport).toBe('websocket')
  })

  test.each(FILTERS)('%s', async (_label, filter) => {
    const http = await ask(overHttp,   filter)
    const ws   = await ask(overSocket, filter)
    expect(http.q).toEqual(ws.q)
  })

  test('and the socket half is the one that was already right', async () => {
    // Pinning the VALUES too, not just agreement — two transports that agree on
    // the wrong answer is the failure this file is one half of.
    const { q } = await ask(overHttp, {
      qty: 5, live: true, archivedAt: null, sku: '007', code: '5', id: { in: [1, 2] },
    })
    expect(q).toEqual({
      qty:        'number:5',
      live:       'boolean:true',
      archivedAt: 'object:null',
      sku:        'string:"007"',
      code:       'string:"5"',
      id:         'object:{"in":[1,2]}',
    })
  })
})
