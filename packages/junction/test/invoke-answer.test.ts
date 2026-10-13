// test/invoke-answer.test.ts — what a custom method's caller is handed.
//
// A custom method answering an array reached `invoke()` as the list envelope
// `{ kind: 'list', data }`, and one answering an object arrived bare. So the
// caller had to know which the method returned before it could read the answer,
// and app code hedged every call with `answer?.data ?? answer` -- 28 sites
// across the apps, two of them in basecamp guarding with `Array.isArray` first.
// The envelope carried nothing for it: a list exists to hold total/limit/offset,
// and a bare array has none (`FJS-D937`).
//
// Asserted down every path a call takes, because each one unwraps on its own
// side: the bridge for HTTP, the channel handler for the socket, and
// `app.service()` in process.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { createJunctionClient } from '../src/client/index.ts'

let app: any
let overHttp: any
let overSocket: any

const ROWS = [{ id: 1 }, { id: 2 }]

beforeAll(async () => {
  app = createApp({
    config: { port: 0, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http, drainTimeout: 250 } },
  } as never)
  app.configure(channels(() => {}) as never)
  app.services.register(createService({
    name:    'words',
    methods: ['find', 'chapter', 'stats', 'page', 'bulk'],
    async find()    { return ROWS },
    async chapter() { return ROWS },
    async stats()   { return { count: 2 } },
    async page()    { return { data: ROWS, total: 9 } },
    async bulk()    { return { data: ROWS, errors: [{ data: { id: 3 }, error: { name: 'BadRequest', message: 'no' } }] } },
  } as never))
  await app.start()

  const url  = `http://127.0.0.1:${app.http.port}`
  overHttp   = createJunctionClient({ url })
  overSocket = createJunctionClient({ url })
  overSocket.connect()
  for (let i = 0; i < 100 && !overSocket._wsReady; i++) await new Promise(r => setTimeout(r, 50))
})

afterAll(async () => { await app?.stop() })

const PATHS: Array<[string, (method: string) => Promise<unknown>]> = [
  ['HTTP',       m => overHttp.service('words').invoke(m)],
  ['WebSocket',  m => overSocket.service('words').invoke(m)],
  ['in process', m => app.service('words').call(m)],
]

describe('invoke() answers what the method returned', () => {

  test('the socket client really is on the socket', () => {
    expect(overSocket._wsReady).toBe(true)
  })

  test.each(PATHS)('%s: an array arrives as the array', async (_label, call) => {
    expect(await call('chapter')).toEqual(ROWS)
  })

  test.each(PATHS)('%s: an object arrives as the object', async (_label, call) => {
    expect(await call('stats')).toEqual({ count: 2 })
  })

  test.each(PATHS)('%s: { data, total } from a custom method keeps every key', async (_label, call) => {
    expect(await call('page')).toEqual({ data: ROWS, total: 9 })
  })

  test.each(PATHS)('%s: the bulk partial-write protocol is still the list envelope', async (_label, call) => {
    const r = await call('bulk') as { kind: string; data: unknown[]; errors: unknown[] }
    expect(r.kind).toBe('list')
    expect(r.data).toEqual(ROWS)
    expect(r.errors).toHaveLength(1)
  })
})

describe('find is unchanged — a page keeps its envelope', () => {

  test.each([
    ['HTTP',      () => overHttp.service('words').find()],
    ['WebSocket', () => overSocket.service('words').find()],
  ])('%s', async (_label, call) => {
    expect(await call()).toMatchObject({ kind: 'list', object: 'words', data: ROWS })
  })
})
