/**
 * test/event-stream.test.js
 *
 * `readEvents` against a REAL junction `ctx.sse()` stream (FJS-1581). The two
 * halves share toolbelt's `/sse` kit, and this is the file that proves they
 * meet over a socket: the session reaches an authenticated stream through
 * `sierraFetch`, leaving the loop is a hang-up the server hears, and a response
 * that is not a stream is refused rather than read as an empty one.
 *
 * The Junction app is a bun subprocess (`fixtures/event-stream-server.ts`)
 * because junction is Bun-only and this suite runs under node.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { configureFetch, sierraFetch, readEvents } from '../src/fetch/index.js'

const PKG      = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const API_PORT = 7925
const API      = `http://127.0.0.1:${API_PORT}`

let server

async function waitFor(url, ms = 20000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`[event-stream] nothing answered ${url} within ${ms}ms`)
}

beforeAll(async () => {
  // A port that already answers is another process, and this suite would
  // grade that one (FJS-740).
  const taken = await fetch(`${API}/ping`).then(() => true, () => false)
  if (taken) throw new Error(`[event-stream] ${API_PORT} already answers — stop whatever holds it`)
  server = spawn('bun', ['test/fixtures/event-stream-server.ts', String(API_PORT)], {
    cwd: PKG, stdio: 'ignore',
  })
  await waitFor(`${API}/ping`)
}, 30000)

afterAll(() => { server?.kill() })

async function collect(res) {
  const out = []
  for await (const e of readEvents(res)) out.push(e)
  return out
}

describe('readEvents over a real ctx.sse() stream', () => {

  test('reads every frame the server wrote, with the session sierraFetch attached', async () => {
    configureFetch({ baseUrl: API, client: { token: 'good', origin: API } })
    const events = await collect(await sierraFetch('/stream'))
    expect(events).toEqual([
      { event: 'land',    data: { hits: ['a', 'b'] }, id: '1' },
      // The id persists until another replaces it, as EventSource's lastEventId does.
      { event: 'message', data: 'bare',               id: '1' },
      { event: 'done',    data: null,                 id: '1' },
    ])
  })

  test('without the session the same stream is refused, with the server\'s own message', async () => {
    configureFetch({ baseUrl: API, client: { token: 'wrong', origin: API } })
    const err = await collect(await sierraFetch('/stream')).catch(e => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(401)
    expect(err.message).toBe('Sign in to read this stream')
  })

  test('a JSON answer is refused by name rather than read as a stream with no events', async () => {
    const err = await collect(await fetch(`${API}/json`)).catch(e => e)
    expect(err).toBeInstanceOf(TypeError)
    expect(err.message).toMatch(/application\/json, not text\/event-stream/)
  })

  test('leaving the loop hangs up, and the server\'s onDisconnect fires', async () => {
    const before = (await fetch(`${API}/__disconnects`).then(r => r.json())).disconnects
    const seen = []
    for await (const e of readEvents(await fetch(`${API}/forever`))) {
      seen.push(e.data.n)
      if (seen.length === 3) break
    }
    expect(seen).toEqual([0, 1, 2])

    // The cancel crosses a socket, so the server hears it a moment later.
    let after = before
    for (let i = 0; i < 50 && after === before; i++) {
      await new Promise(r => setTimeout(r, 20))
      after = (await fetch(`${API}/__disconnects`).then(r => r.json())).disconnects
    }
    expect(after).toBe(before + 1)
  })
})
