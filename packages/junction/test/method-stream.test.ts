// test/method-stream.test.ts — a custom method declared `stream: true` (FJS-1420).
//
// The method is an async generator and each value it yields is a frame
// (`FJS-D1031`). Every frame goes through protect(), and the after chain runs
// once, on the last frame (`FJS-D854`) -- a field stripped only from the answer
// reached the caller in every frame before it. A wire that cannot stream
// answers the last frame alone, and an async generator nobody declared is
// still refused by name (`FJS-D853`).
//
// Asserted down each wire, because each one sends frames on its own side: the
// socket handler, the HTTP service route, and app.service() in process.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { createApp, createService, channels, defaultConfig } from '../index.ts'
import { protect } from '../src/core/hooks-builtin.ts'
import { createJunctionClient } from '../src/client/index.ts'
import { Forbidden } from '../src/core/errors.ts'

let app: any
let url: string
let overHttp: any
let overSocket: any

let afterRuns = 0
let refusedStarted = false
// Held by `paced` after its first frame, so a frame read before release proves
// it left while the method was still running.
let release: () => void = () => {}

const FRAMES = [
  { n: 1, text: 'a',   secret: 's1' },
  { n: 2, text: 'ab',  secret: 's2' },
  { n: 3, text: 'abc', secret: 's3' },
]
const SEEN = FRAMES.map(({ secret: _s, ...rest }) => rest)

beforeAll(async () => {
  app = createApp({
    logLevel: 'silent',
    config: { port: 0, http: { ...defaultConfig.http, drainTimeout: 250 } },
  } as never)
  app.configure(channels(() => {}) as never)
  app.services.register(createService({
    name:    'ticks',
    methods: [
      { method: 'ticker',  stream: true },
      { method: 'paced',   stream: true },
      { method: 'refused', stream: true },
      { method: 'flat',    stream: true },
      'undeclared',
      'plain',
    ],
    async *ticker()  { for (const f of FRAMES) yield { ...f } },
    async *paced()   {
      yield { n: 1 }
      await new Promise<void>((r) => { release = r })
      yield { n: 2 }
    },
    async *refused() { refusedStarted = true; yield { n: 1 } },
    async flat()     { return { n: 1 } },
    async *undeclared() { yield { n: 1 } },
    async plain()       { return { n: 9 } },
    hooks: {
      before: { refused: [() => { throw new Forbidden('not you') }] },
      after:  { ticker:  [protect('secret'), () => { afterRuns++ }] },
    },
  } as never))
  await app.start()

  url        = `http://127.0.0.1:${app.http.port}`
  overHttp   = createJunctionClient({ url })
  overSocket = createJunctionClient({ url })
  overSocket.connect()
  for (let i = 0; i < 100 && !overSocket._wsReady; i++) await new Promise(r => setTimeout(r, 50))
})

afterAll(async () => { await app?.stop() })

async function collect(call: AsyncIterable<unknown>): Promise<unknown[]> {
  const out: unknown[] = []
  for await (const f of call) out.push(f)
  return out
}

const post = (method: string, accept?: string) => fetch(`${url}/ticks`, {
  method:  'POST',
  headers: { 'content-type': 'application/json', 'x-service-method': method, ...(accept ? { accept } : {}) },
  body:    '{}',
})

describe('a streaming method over the socket', () => {

  test('the socket client really is on the socket', () => {
    expect(overSocket._wsReady).toBe(true)
  })

  test('frames arrive in order, and awaiting the call is the last', async () => {
    const call = overSocket.service('ticks').invoke('ticker')
    expect(await collect(call)).toEqual(SEEN)
    expect(await call).toEqual(SEEN[2])
  })

  test('protect() strips the field from every frame, and the after chain runs once', async () => {
    afterRuns = 0
    const frames = await collect(overSocket.service('ticks').invoke('ticker')) as Record<string, unknown>[]
    expect(frames).toHaveLength(3)
    for (const f of frames) expect('secret' in f).toBe(false)
    expect(afterRuns).toBe(1)
  })

  test('a refusal before the method sends no frame', async () => {
    refusedStarted = false
    const frames: unknown[] = []
    let failure: any
    try { for await (const f of overSocket.service('ticks').invoke('refused')) frames.push(f) }
    catch (err) { failure = err }
    expect(failure?.code).toBe(403)
    expect(frames).toEqual([])
    expect(refusedStarted).toBe(false)
  })
})

describe('a streaming method over HTTP', () => {

  test('asked for as text/event-stream, a frame leaves while the method still runs', async () => {
    const seen: unknown[] = []
    const call = overHttp.service('ticks').invoke('paced')
    for await (const f of call) {
      seen.push(f)
      if (seen.length === 1) release()
    }
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
    expect(await call).toEqual({ n: 2 })
  })

  test('the wire is frame events then the result', async () => {
    const res  = await post('ticker', 'text/event-stream')
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/)
    const body = await res.text()
    expect(body.match(/^event: frame$/gm)).toHaveLength(3)
    expect(body).toMatch(/^event: result$/m)
    expect(body).not.toContain('secret')
  })

  test('without that Accept, one ordinary answer: the last frame', async () => {
    const res = await post('ticker')
    expect(res.headers.get('content-type')).toMatch(/json/)
    expect(await res.json()).toEqual(SEEN[2])
  })

  test('a refusal before the first frame answers its own status, not a 200 stream', async () => {
    const res = await post('refused', 'text/event-stream')
    expect(res.status).toBe(403)
  })
})

describe('a wire that cannot stream, and what is refused', () => {

  test('in process, the call answers the last frame', async () => {
    afterRuns = 0
    expect(await app.service('ticks').call('ticker')).toEqual(SEEN[2])
    expect(afterRuns).toBe(1)
  })

  test('a method that is not a stream iterates its answer once, on either wire', async () => {
    expect(await collect(overHttp.service('ticks').invoke('plain'))).toEqual([{ n: 9 }])
    expect(await collect(overSocket.service('ticks').invoke('plain'))).toEqual([{ n: 9 }])
  })

  test('an async generator nobody declared is refused by name', async () => {
    await expect(app.service('ticks').call('undeclared')).rejects.toThrow(/an async iterable/)
  })

  test('a declared stream answering something else is refused by name', async () => {
    await expect(app.service('ticks').call('flat')).rejects.toThrow(/declares stream: true/)
  })
})
