// test/read-only-copy.test.ts
//
// Outpost sets FRONTIER_READ_ONLY_COPY on a copy's container and routes no
// copy until its API answers with `x-frontier-read-only` (`FJS-D1996`). The
// claims: every answer carries it, a route's and the ones that never reach a
// route (a 404, a refused body); none carries it without the var; and a value
// that is not an ISO time refuses the start rather than serving writable.
// And a copy starts nothing on its own clock: no scheduler, no plugin work().

import { describe, it, expect, afterEach } from 'bun:test'
import { createApp } from '../src/core/app.ts'
import { READ_ONLY_HEADER } from '../src/transport/http.ts'
import { createLogger, type LogEntry } from '../src/core/logger.ts'

const AS_OF = '2026-11-05T03:00:00.000Z'
const clearEnv = () => { delete process.env.FRONTIER_READ_ONLY_COPY }
afterEach(clearEnv)

const started = async () => {
  const app = createApp({ logLevel: 'silent' })
  app.get('/ping', (ctx: any) => ctx.json({ ok: true }))
  app.post('/echo', (ctx: any) => ctx.json(ctx.data))
  await app._startForTest()
  return app
}

const answers = async (app: any) => [
  await app.http.fetch(new Request('http://localhost/ping')),
  await app.http.fetch(new Request('http://localhost/nowhere')),
  await app.http.fetch(new Request('http://localhost/echo', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
  })),
]

describe('a read-only copy', () => {
  it('states its as-of time on every answer', async () => {
    process.env.FRONTIER_READ_ONLY_COPY = AS_OF
    const app = await started()
    const res = await answers(app)
    expect(res.map(r => r.status)).toEqual([200, 404, 400])
    for (const r of res) expect(r.headers.get(READ_ONLY_HEADER)).toBe(AS_OF)
    await app.stop()
  })

  it('states nothing when the var is unset', async () => {
    clearEnv()
    const app = await started()
    for (const r of await answers(app)) expect(r.headers.has(READ_ONLY_HEADER)).toBe(false)
    await app.stop()
  })

  it('refuses to start on a value that is not an ISO time', async () => {
    process.env.FRONTIER_READ_ONLY_COPY = 'yesterday'
    const app = createApp({ logLevel: 'silent' })
    await expect(app._startForTest()).rejects.toThrow(/FRONTIER_READ_ONLY_COPY="yesterday" is not an ISO time/)
  })

  it('starts no scheduler and no plugin work(), and says so', async () => {
    const run = async () => {
      const lines: LogEntry[] = []
      const worked: string[] = []
      const app = createApp({ logger: createLogger({ level: 'debug', writers: [e => { lines.push(e) }] }) })
      app.configure({ name: 'relay', work: () => { worked.push('relay') } } as never)
      app.configure({ name: 'quiet' } as never)
      let fired = false
      app.scheduler.once(1, () => { fired = true })
      await app._startForTest()
      await Bun.sleep(30)
      await app.stop()
      return { fired, worked, said: lines.map(l => l.message).filter(m => /read-only copy/.test(m)) }
    }

    clearEnv()
    expect(await run()).toEqual({ fired: true, worked: ['relay'], said: [] })

    process.env.FRONTIER_READ_ONLY_COPY = AS_OF
    expect(await run()).toEqual({
      fired: false, worked: [],
      said: [`[Junction] read-only copy as of ${AS_OF}: no scheduler, and no work() from relay.`],
    })
  })
})
