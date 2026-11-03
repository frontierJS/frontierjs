// ─── basecamp-posture.test.js — `fli basecamp:posture`'s reader and its lines ──
//
// The command prints a grade Basecamp stored, so the two ways it can lie are
// here: a server with no report printed as ok, and Basecamp's own box read
// without its `hub.*` controls when the key reaches them. The stand-in answers
// the three methods in the shapes `serverPostures.fleet`/`latest` and
// `hub.hostPosture` return, unwrapped, as a custom method's object is.

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { resolve } from 'node:path'
import { readPostures, readPosture, postureLine, postureDetail, failingBySeverity } from '../core/basecamp.js'

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '')
const at    = new Date(Date.now() - 3 * 3_600_000).toISOString()

const replica = { id: 'backup.replica-lag', group: 'backup', severity: 'high', ok: true, message: 'No app on this machine replicates' }
const behind  = { id: 'outpost.version-behind', group: 'outpost', severity: 'medium', ok: false,
  message: 'Outpost 0.1.8, this Basecamp installs 0.1.9', fix: 'Press Re-enroll this machine on its server page' }
const hubBackup = { id: 'hub.backup-recent', group: 'hub', severity: 'high', ok: false, message: 'No backup has finished', fix: 'Take one now on /hub/backups/' }

const row = (over) => ({ status: 'online', reported: true, stale: false, at, controls: [replica], failing: 0, unknown: 0, ...over })
const FLEET = [
  row({ serverId: 's-yuma', serverName: 'yuma', controls: [behind, replica], failing: 1 }),
  row({ serverId: 's-quiet', serverName: 'quiet-02', reported: false, at: null }),
  row({ serverId: 's-old', serverName: 'old', stale: true }),
  row({ serverId: 's-twin-a', serverName: 'twin' }),
  row({ serverId: 's-twin-b', serverName: 'twin' }),
]

let server, sysadmin
const origin = () => `http://localhost:${server.port}`

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const url    = new URL(req.url)
    const method = req.headers.get('x-service-method')
    const admin  = req.headers.get('authorization') === 'Bearer sys'
    if (url.pathname === '/serverPostures' && method === 'fleet') return Response.json({ servers: FLEET, dependencies: { vulnerable: 0 } })
    if (url.pathname.startsWith('/serverPostures/') && method === 'latest')
      return Response.json({ ...FLEET.find(s => s.serverId === url.pathname.split('/')[2]), readings: { updates: { pending: 4, security: 1 } } })
    if (url.pathname === '/hub' && method === 'hostPosture') {
      if (!admin) return Response.json({ message: 'Requires system admin' }, { status: 403 })
      sysadmin++
      return Response.json({ enrolled: true, serverId: 's-yuma', serverName: 'yuma', reported: true, stale: false, at,
        controls: [hubBackup, behind, replica], failing: 2, unknown: 0, readings: { updates: { pending: 0, security: 0 } } })
    }
    return Response.json({ message: 'not here' }, { status: 404 })
  } })
})
afterAll(() => server?.stop(true))

describe('one line per server', () => {
  test('a server with no report reads unknown, and a stale one too, never ok', async () => {
    const { servers } = await readPostures(origin(), 'key')
    const lines = Object.fromEntries(servers.map(s => [s.serverName, plain(postureLine(s))]))
    expect(lines['quiet-02']).toMatch(/\? quiet-02\s+unknown\s+no report yet/)
    expect(lines['old']).toMatch(/\? old\s+unknown\s+report 3h ago, stale/)
    expect(lines['yuma']).toMatch(/✗ yuma\s+1 medium\s+report 3h ago/)
    expect([lines['quiet-02'], lines['old']].join('\n')).not.toMatch(/\bok\b/)
  })

  test('a reported box with every control passing is the one that reads ok', () => {
    expect(plain(postureLine(row({ serverName: 'clean' })))).toMatch(/✓ clean\s+ok\s+report 3h ago/)
  })

  test('a key that reaches the host gives that row its hub controls; any other key reads it as the fleet row', async () => {
    sysadmin = 0
    const fleetOnly = (await readPostures(origin(), 'key')).servers.find(s => s.serverId === 's-yuma')
    expect([fleetOnly.host, failingBySeverity(fleetOnly)]).toEqual([undefined, { medium: 1 }])

    const withHost = (await readPostures(origin(), 'sys')).servers
    expect(sysadmin).toBe(1)
    expect(withHost.map(s => s.serverName)).toEqual(['yuma', 'quiet-02', 'old', 'twin', 'twin'])
    expect(failingBySeverity(withHost[0])).toEqual({ high: 1, medium: 1 })
    expect(plain(postureLine(withHost[0]))).toMatch(/✗ yuma ⛺\s+1 high · 1 medium/)
  })
})

describe('one server', () => {
  test('by name, every control failing first, a failing one with its fix', async () => {
    const lines = postureDetail(await readPosture(origin(), 'key', 'yuma')).map(plain)
    expect(lines[0]).toMatch(/yuma\s+report 3h ago/)
    expect(lines[1]).toMatch(/4 updates pending, 1 of them security/)
    const controls = lines.filter(l => /^\s+[✗?✓] /.test(l))
    expect(controls.map(l => l.trim().split(/\s+/)[1])).toEqual(['outpost.version-behind', 'backup.replica-lag'])
    expect(lines.join('\n')).toMatch(/fix: Press Re-enroll this machine/)
  })

  test('the host, read by a system admin\'s key, comes from hub.hostPosture', async () => {
    const view = await readPosture(origin(), 'sys', 's-yuma')
    expect(view.host).toBe(true)
    expect(view.controls.map(c => c.id)).toContain('hub.backup-recent')
  })

  test('a name the workspace does not have answers null', async () => {
    expect(await readPosture(origin(), 'key', 'nowhere')).toBeNull()
  })

  test('a name two servers share is refused naming both ids, and either id still reads', async () => {
    await expect(readPosture(origin(), 'key', 'twin')).rejects.toThrow(/2 servers are named 'twin'.*s-twin-a, s-twin-b/)
    expect((await readPosture(origin(), 'key', 's-twin-b')).serverId).toBe('s-twin-b')
  })
})

// The exit code is what a cron or CI gate reads, so it is asserted on the
// command itself. Async: a sync spawn would block the stand-in it calls.
describe('the command', () => {
  const run = async (...args) => {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, '../bin/fli.js'), 'basecamp:posture', ...args, '--url', origin()],
      { env: { ...process.env, BASECAMP_API_KEY: 'key', NO_COLOR: '1' }, stdout: 'pipe', stderr: 'pipe' })
    const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return { out, code }
  }

  test('exits 1 on a failing control and 0 on a clean server', async () => {
    expect((await run('yuma')).code).toBe(1)
    const clean = await run('s-twin-a')
    expect([clean.code, clean.out]).toEqual([0, expect.stringContaining('backup.replica-lag')])
  })
})
