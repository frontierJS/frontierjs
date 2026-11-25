// test/crash-ping.test.ts
//
// The crash ping (FJS-D2184 to FJS-D2187): junction announces `app:crash`, and
// this package reports it once per ten-minute window, kept in a file: to
// Basecamp when the app was deployed by one (FJS-D2272), else, or when
// Basecamp cannot take it, as an ntfy push.
//
// Most cases emit `app:crash` on a real junction app with `ntfy()`'s `deliver`
// stubbed and the clock injected. The last runs a real process that throws
// uncaught, because only that shows the ping leaving before `process.exit(1)`:
// an in-process emit cannot tell a listener junction waited for from one it cut.

import { describe, test, expect, afterEach } from 'bun:test'
import { createTestApp } from '@frontierjs/junction'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tempDir } from '../../litestone/src/tmp-dirs.js'
import { listenForCrash, crashRecordPath, CRASH_WINDOW_MS, CRASH_RECORD_FILE, RELAY_TIMEOUT_MS } from '../crash.ts'

const ENV   = { NTFY_BASE_URL: 'https://ntfy.acme.test/', NTFY_TOPIC: 'acme-crash', NTFY_TOKEN: 'tk_1' }
const RELAY = { BASECAMP_URL: 'https://hub.acme.test/', BASECAMP_APP_ID: 'app_1' }
const RELAY_URL = 'https://hub.acme.test/hooks/crash/app_1'

/** A db whose main file sits in a fresh directory, as `$databases` reports it. */
const dbIn = (dir: string) => ({ $databases: { main: { path: join(dir, 'app.db') } } })

/** `relay` is Basecamp's status, or 'hang' for a Basecamp that never answers. */
async function rig(opts: { env?: Record<string, string | undefined>; answer?: number; relay?: number | 'hang' } = {}) {
  const dir  = tempDir('fjs-crash-')
  const sent: { url: string; init: RequestInit }[] = []
  const logs: string[] = []
  let clock = 1_000_000
  const app: any = await createTestApp({ config: { name: 'acme' } } as never)
  app.logger = { ...app.logger, info: (msg: string, meta?: Record<string, unknown>) => logs.push(`${msg} ${JSON.stringify(meta ?? {})}`) }
  const deliver = (async (url: string, init: RequestInit) => {
    sent.push({ url, init })
    if (url !== RELAY_URL) return new Response(JSON.stringify({ id: 'm1' }), { status: opts.answer ?? 200 })
    if (opts.relay === 'hang') return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason)))
    return Response.json({ queued: true }, { status: opts.relay ?? 202 })
  }) as unknown as typeof fetch
  listenForCrash(app, dbIn(dir), { env: opts.env ?? ENV, deliver, now: () => clock })
  return {
    app, dir, sent, logs,
    urls:   () => sent.map(s => s.url),
    crash:  (msg = 'boom') => app.events.emit('app:crash', { message: '[App] Uncaught exception', error: new Error(msg) }),
    record: () => JSON.parse(readFileSync(join(dir, CRASH_RECORD_FILE), 'utf8')),
    advance: (ms: number) => { clock += ms },
  }
}

const realWrite = process.stderr.write
afterEach(() => { process.stderr.write = realWrite })
function captureStderr() {
  const written: string[] = []
  process.stderr.write = ((chunk: unknown) => { written.push(String(chunk)); return true }) as typeof process.stderr.write
  return written
}

describe('crash ping', () => {
  test('a crash sends one critical push to the topic, with the token and the error', async () => {
    const r = await rig()
    await r.crash('db locked')
    expect(r.sent).toHaveLength(1)
    const { url, init } = r.sent[0]
    const headers = init.headers as Record<string, string>
    expect(url).toBe('https://ntfy.acme.test/acme-crash')
    expect(headers.Authorization).toBe('Bearer tk_1')
    expect(headers.Priority).toBe('5')
    expect(headers.Title).toStartWith('acme crashed on ')
    expect(String(init.body)).toStartWith('db locked')
    expect(r.record()).toEqual({ pingedAt: 1_000_000, since: 0 })
    expect(r.logs.join('\n')).toContain('🔔 crash ping {"ntfy":"https://ntfy.acme.test/"}')
    expect(r.logs.join('\n')).not.toContain('acme-crash')
  })

  test('a crash inside the window sends nothing and is counted into the next ping', async () => {
    const r = await rig()
    await r.crash()
    r.advance(60_000);               await r.crash()
    r.advance(60_000);               await r.crash()
    expect(r.sent).toHaveLength(1)
    expect(r.record()).toEqual({ pingedAt: 1_000_000, since: 2 })

    r.advance(CRASH_WINDOW_MS);      await r.crash()
    expect(r.sent).toHaveLength(2)
    expect(String(r.sent[1].init.body)).toContain(`Crashed 2 more times since ${new Date(1_000_000).toISOString()} without a ping.`)
    expect(r.record().since).toBe(0)
  })

  test('a send that fails writes one stderr line and opens no window', async () => {
    const r = await rig({ answer: 502 })
    const written = captureStderr()
    await r.crash()
    expect(written.join('')).toContain('[notifications] crash ping not sent: [notifications] push: ntfy at https://ntfy.acme.test answered 502')
    expect(r.record()).toEqual({ pingedAt: 0, since: 1 })
    await r.crash()
    expect(r.sent).toHaveLength(2)
  })

  test('without a whole pair there is no listener, and boot says which keys are missing', async () => {
    // Basecamp sets NTFY_BASE_URL for its own pushes and configures this package.
    const r = await rig({ env: { NTFY_BASE_URL: 'https://ntfy.acme.test', BASECAMP_APP_ID: 'app_1' } })
    await r.crash()
    expect(r.sent).toHaveLength(0)
    expect(existsSync(join(r.dir, CRASH_RECORD_FILE))).toBe(false)
    expect(r.logs).toEqual(['🔕 crash ping off {"missing":"BASECAMP_URL, NTFY_TOPIC"}'])
  })

  describe('relayed to Basecamp', () => {
    test('a crash POSTs one report to the app\'s crash route and sends no push', async () => {
      const r = await rig({ env: { ...RELAY, ...ENV } })
      await r.crash('db locked')
      expect(r.urls()).toEqual([RELAY_URL])
      const body = JSON.parse(String(r.sent[0].init.body))
      expect(body).toMatchObject({ message: 'db locked', missed: 0 })
      expect(body.stack).toContain('db locked')
      expect(typeof body.host).toBe('string')
      expect(r.record()).toEqual({ pingedAt: 1_000_000, since: 0 })
      expect(r.logs).toEqual(['🔔 crash ping {"basecamp":"https://hub.acme.test","ntfy":"https://ntfy.acme.test/"}'])
    })

    test('the window holds the relay too: a crash loop POSTs once, and the next report counts the rest', async () => {
      const r = await rig({ env: { ...RELAY, ...ENV } })
      await r.crash()
      r.advance(60_000);          await r.crash()
      expect(r.urls()).toEqual([RELAY_URL])
      r.advance(CRASH_WINDOW_MS); await r.crash()
      expect(r.urls()).toEqual([RELAY_URL, RELAY_URL])
      expect(JSON.parse(String(r.sent[1].init.body)).missed).toBe(1)
    })

    for (const status of [404, 503, 500])
      test(`a ${status} falls back to the trio, says so on stderr, and opens the window`, async () => {
        const r = await rig({ env: { ...RELAY, ...ENV }, relay: status })
        const written = captureStderr()
        await r.crash()
        expect(r.urls()).toEqual([RELAY_URL, 'https://ntfy.acme.test/acme-crash'])
        expect(written.join('')).toContain(`[notifications] crash ping: Basecamp at https://hub.acme.test answered ${status}; sending to ntfy instead`)
        expect(r.record()).toEqual({ pingedAt: 1_000_000, since: 0 })
      })

    test('a 429 is final: Basecamp has the crash loop, so nothing pages around its limit', async () => {
      const r = await rig({ env: { ...RELAY, ...ENV }, relay: 429 })
      await r.crash()
      expect(r.urls()).toEqual([RELAY_URL])
      expect(r.record()).toEqual({ pingedAt: 1_000_000, since: 0 })
    })

    test('a Basecamp that never answers is given up on in time for the trio', async () => {
      const r = await rig({ env: { ...RELAY, ...ENV }, relay: 'hang' })
      const written = captureStderr()
      const started = performance.now()
      await r.crash()
      const took = performance.now() - started
      expect(took).toBeGreaterThanOrEqual(RELAY_TIMEOUT_MS - 50)
      expect(took).toBeLessThan(2_500)
      expect(r.urls()).toEqual([RELAY_URL, 'https://ntfy.acme.test/acme-crash'])
      expect(written.join('')).toContain('Basecamp at https://hub.acme.test did not answer')
    })

    test('with no trio a failed relay sends nothing and opens no window', async () => {
      const r = await rig({ env: RELAY, relay: 503 })
      const written = captureStderr()
      await r.crash()
      expect(r.urls()).toEqual([RELAY_URL])
      expect(written.join('')).toContain('[notifications] crash ping not sent: Basecamp at https://hub.acme.test answered 503')
      expect(r.record()).toEqual({ pingedAt: 0, since: 1 })
      expect(r.logs).toEqual(['🔔 crash ping {"basecamp":"https://hub.acme.test"}'])
    })
  })

  test('the record sits beside the main database file, else in the working directory', () => {
    expect(crashRecordPath(dbIn('/srv/acme/db'))).toBe(`/srv/acme/db/${CRASH_RECORD_FILE}`)
    expect(crashRecordPath({ $databases: { main: { path: ':memory:' } } }, '/work')).toBe(`/work/${CRASH_RECORD_FILE}`)
    expect(crashRecordPath(undefined, '/work')).toBe(`/work/${CRASH_RECORD_FILE}`)
  })

  test('a real uncaught throw pings before the process exits, and a second crash inside the window does not', async () => {
    const posts: { path: string; title: string | null; body: string }[] = []
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        posts.push({ path: new URL(req.url).pathname, title: req.headers.get('Title'), body: await req.text() })
        return Response.json({ id: 'x' })
      },
    })
    const cwd = tempDir('fjs-crash-proc-')
    const run = async () => {
      const proc = Bun.spawn(['bun', join(import.meta.dir, 'fixtures/crash-app.ts')], {
        cwd, stdout: 'ignore', stderr: 'pipe',
        env: { ...process.env, NTFY_BASE_URL: `http://127.0.0.1:${server.port}`, NTFY_TOPIC: 'proc-crash', NTFY_TOKEN: '' },
      })
      return { code: await proc.exited, stderr: await new Response(proc.stderr).text() }
    }
    try {
      const first = await run()
      expect(first.code).toBe(1)
      expect(posts).toHaveLength(1)
      expect(posts[0].path).toBe('/proc-crash')
      expect(posts[0].title).toStartWith('crash-fixture crashed on ')
      expect(posts[0].body).toStartWith('fixture boom')

      const second = await run()
      expect(second.code).toBe(1)
      expect(posts).toHaveLength(1)
      expect(JSON.parse(readFileSync(join(cwd, CRASH_RECORD_FILE), 'utf8')).since).toBe(1)
    } finally {
      server.stop(true)
    }
  }, 20_000)

  test('a real uncaught throw whose Basecamp never answers still pings the trio before the process exits', async () => {
    const posts: string[] = []
    const server = Bun.serve({
      port: 0, hostname: '127.0.0.1',
      async fetch(req) {
        const path = new URL(req.url).pathname
        posts.push(path)
        if (path.startsWith('/hooks/crash/')) return new Promise<Response>(() => {})
        return Response.json({ id: 'x' })
      },
    })
    const base = `http://127.0.0.1:${server.port}`
    try {
      const proc = Bun.spawn(['bun', join(import.meta.dir, 'fixtures/crash-app.ts')], {
        cwd: tempDir('fjs-crash-relay-'), stdout: 'ignore', stderr: 'pipe',
        env: { ...process.env, BASECAMP_URL: base, BASECAMP_APP_ID: 'app_9', NTFY_BASE_URL: base, NTFY_TOPIC: 'proc-crash', NTFY_TOKEN: '' },
      })
      expect(await proc.exited).toBe(1)
      expect(posts).toEqual(['/hooks/crash/app_9', '/proc-crash'])
      expect(await new Response(proc.stderr).text()).toContain('did not answer')
    } finally {
      server.stop(true)
    }
  }, 20_000)
})
