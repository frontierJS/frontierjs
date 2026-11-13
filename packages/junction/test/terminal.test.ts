// test/terminal.test.ts
//
// `@frontierjs/junction/terminal` (`FJS-D2125`): a mount with no refusal
// throws, the frame protocol clamps what the page sends and ignores what it
// does not name, and a real shell answers over a real socket. The round trip
// uses a tmux server of its own and kills it, so the operator's sessions are
// never touched.

import { rmSync }  from 'node:fs'
import { tmpdir }  from 'node:os'
import { join }    from 'node:path'
import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { createApp, defaultConfig } from '../index.ts'
import { endShell, terminalSocket } from '../src/terminal/index.ts'

const noop = () => ''
const env  = () => process.env

describe('terminalSocket refuses to mount without a refusal', () => {
  const app = { ws() {} }
  test('no refuse', () => {
    expect(() => terminalSocket(app, '/t', { cwd: noop, session: noop, env } as never)).toThrow(/refuse/)
  })
  test('a refuse naming no check', () => {
    expect(() => terminalSocket(app, '/t', { refuse: {}, cwd: noop, session: noop, env })).toThrow(/refuse/)
  })
})

describe('frames', () => {
  let mounted: any
  const app = { ws(_p: string, handlers: any, opts: any) { mounted = { handlers, opts } } }
  const written: string[] = []
  const resized: number[][] = []
  let spawned: any
  const spy = spyOn(Bun, 'spawn').mockImplementation(((argv: string[], o: any) => {
    spawned = { argv, o }
    return {
      terminal: { write: (d: string) => written.push(d), resize: (c: number, r: number) => resized.push([c, r]) },
      exited:   new Promise(() => {}),
      kill() {},
    }
  }) as never)
  afterAll(() => spy.mockRestore())

  const ctx = (query: Record<string, unknown>) => ({ query, route: {}, headers: {}, locals: {} as Record<string, unknown>, send() {}, close() {} })

  test('the socket bounds are off and the size at the upgrade is clamped', async () => {
    terminalSocket(app, '/t', { refuse: { open: () => null }, cwd: () => '/tmp', session: () => 's', env: () => ({ PATH: '/bin' }) })
    expect(mounted.opts.limits).toEqual({ maxFramesPerSecond: 0, maxInFlight: 0 })
    await mounted.handlers.open(ctx({ cols: '9999', rows: '1' }))
    expect([spawned.o.terminal.cols, spawned.o.terminal.rows]).toEqual([500, 2])
    expect(spawned.o.env).toEqual({ PATH: '/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor' })
    expect(spawned.o.cwd).toBe('/tmp')
  })

  test('{ i } is typed, { r } is clamped, anything else is ignored', async () => {
    const c = ctx({})
    await mounted.handlers.open(c)
    expect([spawned.o.terminal.cols, spawned.o.terminal.rows]).toEqual([80, 24])
    written.length = 0; resized.length = 0
    mounted.handlers.message(c, JSON.stringify({ i: 'ls\r' }))
    mounted.handlers.message(c, JSON.stringify({ r: [1, 9999] }))
    mounted.handlers.message(c, JSON.stringify({ r: ['x', 40] }))
    mounted.handlers.message(c, JSON.stringify({ i: 42, z: 'nope' }))
    mounted.handlers.message(c, 'not json')
    mounted.handlers.message(c, 'null')
    expect(written).toEqual(['ls\r'])
    expect(resized).toEqual([[2, 200], [80, 40]])
  })

  test('a refusal at open closes with its code and spawns nothing', async () => {
    terminalSocket(app, '/t', { refuse: { open: () => ({ code: 4009, reason: 'no folder' }) }, cwd: noop, session: noop, env })
    spawned = null
    const closed: unknown[] = []
    await mounted.handlers.open({ ...ctx({}), close: (...a: unknown[]) => closed.push(a) })
    expect(closed).toEqual([[4009, 'no folder']])
    expect(spawned).toBeNull()
  })

  test('a string from refuse.upgrade is a 403 with that body', async () => {
    terminalSocket(app, '/t', { refuse: { upgrade: () => 'not from here' }, cwd: noop, session: noop, env })
    const res = mounted.opts.upgrade(new Request('http://x/t')) as Response
    expect(res.status).toBe(403)
    expect(await res.text()).toBe('not from here')
  })
})

describe('a real shell', () => {
  const SOCKET = `junction-test-${process.pid}`
  let app: any
  afterEach(() => { endShell(SOCKET, 'round-trip') })
  afterAll(async () => {
    await app?.stop()
    const tmux = Bun.which('tmux')
    if (tmux) Bun.spawnSync([tmux, '-L', SOCKET, 'kill-server'], { stdout: 'ignore', stderr: 'ignore' })
    // A killed server leaves its socket file, one per run, in the operator's tmux dir.
    rmSync(join(process.env.TMUX_TMPDIR || tmpdir(), `tmux-${process.getuid?.()}`, SOCKET), { force: true })
  })

  test('answers a typed command and refuses an Origin at the upgrade', async () => {
    app = createApp({ logLevel: 'silent', config: { port: 0, services: { dir: '/nonexistent' }, http: { ...defaultConfig.http, drainTimeout: 250 } } })
    terminalSocket(app, '/terminal', {
      refuse:  { upgrade: req => req.headers.get('origin') ? 'no pages' : null },
      cwd:     () => process.cwd(),
      session: () => 'round-trip',
      env,
      socket:  SOCKET,
    })
    await app.start()
    const url = `ws://localhost:${app.http.port}/terminal?cols=80&rows=24`

    const ws = new WebSocket(url)
    let out = ''
    ws.onmessage = (e: any) => { out += String(e.data) }
    await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error('refused')) })
    // Keys typed before the shell inside tmux has started are dropped, and
    // there is no portable prompt to wait for, so the line is typed until it answers.
    const deadline = Date.now() + 8000
    while (!out.includes('42-ok') && Date.now() < deadline) {
      ws.send(JSON.stringify({ i: 'echo $((40+2))-ok\r' }))
      await Bun.sleep(500)
    }
    ws.close()
    expect(out).toContain('42-ok')

    const refused = await fetch(url.replace('ws:', 'http:'), {
      headers: { origin: 'http://evil.test', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13' },
    })
    expect(refused.status).toBe(403)
  }, 15000)
})
