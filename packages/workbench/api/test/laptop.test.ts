/**
 * laptop.test.ts -- the Disk screen's reads and its Clear verb, over a temp
 * home so the laptop's own folders are never sized or touched. `home` pins the
 * four roots as `paths.js` takes it; Workbench's folder follows `WORKBENCH_DIR`.
 * Lane removal is not here: the lanes script is bound to this checkout's real
 * `~/.fli/lanes`, so only its refusals are tested (see `scripts/lanes.mjs`).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { disk, clear, removeLane } from '../src/domain/laptop/laptop.ts'
import { keys, fixMode } from '../src/domain/laptop/keys.ts'
import { ping, setPing } from '../src/domain/laptop/ping.ts'
import { globalEnv, setGlobalEnv, unsetGlobalEnv, commands } from '../src/domain/laptop/settings.ts'
import { running } from '../src/domain/laptop/running.ts'
import { servicesList, probeService } from '../src/domain/laptop/services.ts'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const home   = mkdtempSync(join(tmpdir(), 'wb-laptop-'))
const SECRET = 'sk_live_NEVER_IN_A_RESPONSE'
const saved  = process.env.WORKBENCH_DIR

const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const cached = join(home, '.cache', 'fli', 'registry-0bdb23e170.json')

beforeAll(() => {
  process.env.WORKBENCH_DIR = join(home, 'wb')
  put(cached, 'y'.repeat(300))
  put(join(home, '.cache', 'fli', 'stray.txt'), 'not fli\'s')
  put(join(home, '.config', 'fli', '.env'), `TOKEN=${SECRET}`)
  put(join(home, '.config', 'fli', 'basecamps.json'), `{"apiKey":"${SECRET}"}`)
  put(join(home, 'wb', 'peer.json'), `{"secret":"${SECRET}"}`)
  put(join(home, '.fli', 'frontier', 'key.json'), `{"privateKey":"${SECRET}"}`)
  put(join(home, '.fli', 'frontier', 'member.json'), `{"number":7,"nick":"ada","root":"${SECRET}","sig":"${SECRET}"}`)
  put(join(home, '.fli', 'frontier', 'peers.json'), `{"r1":{"nick":"vlad","seq":1,"since":5,"sealKey":"${SECRET}"}}`)
  put(join(home, '.fli', 'frontier', 'waiting.json'), `{"checked":9,"waiting":[{"from":"vlad","count":2}]}`)
  put(join(home, '.config', 'fli', 'config.json'), `{"frontier":{"nick":"ada","box":"PUBBOX","postKey":"${SECRET}"}}`)
  put(join(home, '.config', 'fli', 'commands', 'mine', 'hello.md'), '---\ntitle: mine:hello\ndescription: Says hello.\n---\n')
  put(join(home, '.config', 'fli', 'commands', 'mine', '_module.md'), '---\ntitle: mine\n---\n')
  chmodSync(join(home, '.config', 'fli', '.env'), 0o644)
  chmodSync(join(home, '.fli', 'frontier', 'key.json'), 0o600)
})

afterAll(() => {
  saved === undefined ? delete process.env.WORKBENCH_DIR : (process.env.WORKBENCH_DIR = saved)
  rmSync(home, { recursive: true, force: true })
})

describe('disk', () => {
  test('lists the five classes with sizes, and the seeded cache entry as reclaimable', async () => {
    const out = await disk({ home })
    expect(out.classes.map(c => c.root)).toEqual(['config', 'data', 'cache', 'state', 'workbench'])
    const cache = out.classes.find(c => c.root === 'cache')!
    const row   = cache.entries.find(e => e.name === 'registry-0bdb23e170.json')!
    expect(row).toMatchObject({ bytes: 300, reclaim: 'clear', known: true })
    expect(cache.reclaimable).toBe(300)
    expect(cache.bytes).toBe(300 + 'not fli\'s'.length)
    expect(cache.entries.find(e => e.name === 'stray.txt')).toMatchObject({ known: false, what: null })
    expect(out.classes.find(c => c.root === 'workbench')!.bytes).toBeGreaterThan(0)
    expect(typeof out.walkMs).toBe('number')
  })

  test('no response carries a value out of a secret file', async () => {
    expect(JSON.stringify(await disk({ home }))).not.toContain(SECRET)
  })
})

describe('clear', () => {
  test('refuses anything outside the cache root, an unknown name, and a name that is not a catalog row', () => {
    expect(clear('config', '.env', { home })).toHaveProperty('refused')
    expect(clear('cache', 'stray.txt', { home })).toHaveProperty('refused')
    expect(clear('cache', '../../.config/fli/.env', { home })).toHaveProperty('refused')
    expect(clear('cache', 'nothing-here', { home })).toHaveProperty('refused')
    expect(existsSync(join(home, '.config', 'fli', '.env'))).toBe(true)
    expect(existsSync(join(home, '.cache', 'fli', 'stray.txt'))).toBe(true)
  })

  test('removes a registry cache entry and says what it freed', () => {
    expect(clear('cache', 'registry-0bdb23e170.json', { home })).toEqual({ freed: 300 })
    expect(existsSync(cached)).toBe(false)
  })
})

describe('removeLane', () => {
  test('refuses a number that is not a lane and a lane that does not exist', async () => {
    expect(await removeLane(0)).toHaveProperty('refused')
    expect(await removeLane(1.5)).toHaveProperty('refused')
    expect(await removeLane(97)).toHaveProperty('refused')
  })
})

describe('keys', () => {
  test('flags a 644 .env, lists a secret directory\'s files and marks absent secrets as not there', () => {
    const out  = keys({ home })
    const env  = out.keys.find(k => k.label === 'config/.env')!
    expect(env).toMatchObject({ present: true, mode: '644', exposed: true, kind: 'file' })
    expect(env.owner).toBeTruthy()
    expect(out.keys.find(k => k.label === 'state/frontier/key.json')).toMatchObject({ mode: '600', exposed: false })
    expect(out.keys.find(k => k.label === 'workbench/peer.json')).toMatchObject({ present: true })
    expect(out.keys.find(k => k.label === 'workbench/push.json')).toMatchObject({ present: false, mode: null, exposed: false })
    expect(out.keys.find(k => k.label === 'config/basecamps.json')).toMatchObject({ present: true })
  })

  test('the Frontier identity carries names and ids, and the payload carries no secret value', () => {
    const out = keys({ home })
    expect(out.identity).toEqual({
      nick: 'ada', box: 'PUBBOX', member: { id: 7, name: 'ada' },
      peers: [{ nick: 'vlad', since: 5 }], waiting: { checked: 9, from: [{ from: 'vlad', count: 2 }] },
    })
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })
})

describe('fixMode', () => {
  test('sets an exposed file to 600 and says so', () => {
    expect(fixMode('config/.env', { home })).toEqual({ label: 'config/.env', mode: '600' })
    expect((statSync(join(home, '.config', 'fli', '.env')).mode & 0o777).toString(8)).toBe('600')
    expect(keys({ home }).keys.find(k => k.label === 'config/.env')!.exposed).toBe(false)
  })

  test('refuses an unknown label, a path, and an absent file', () => {
    expect(fixMode('config/nothing', { home })).toHaveProperty('refused')
    expect(fixMode('../../etc/passwd', { home })).toHaveProperty('refused')
    expect(fixMode(join(home, '.config', 'fli', 'config.json'), { home })).toHaveProperty('refused')
    expect(fixMode('workbench/push.json', { home })).toHaveProperty('refused')
  })
})

describe('global env', () => {
  const VALUE = 'abcdef-RAWVALUE-xy'
  test('set lists the key masked, never the value, and writes a 600 file', () => {
    expect(setGlobalEnv('WB_PROBE', VALUE, { home })).toEqual({ key: 'WB_PROBE' })
    expect(setGlobalEnv('WB_SHORT', 'abc', { home })).toEqual({ key: 'WB_SHORT' })
    const out = globalEnv({ home })
    expect(out.keys.find(k => k.key === 'WB_PROBE')).toEqual({ key: 'WB_PROBE', masked: '••••xy', usedBy: [] })
    expect(out.keys.find(k => k.key === 'WB_SHORT')).toEqual({ key: 'WB_SHORT', masked: '••••', usedBy: [] })
    expect(JSON.stringify(out)).not.toContain(VALUE)
    expect(readFileSync(out.path, 'utf8')).toContain(`WB_PROBE=${VALUE}`)
    expect((statSync(out.path).mode & 0o777).toString(8)).toBe('600')
  })

  test('unset removes the key and leaves the rest; unsetting twice is refused', () => {
    expect(unsetGlobalEnv('WB_PROBE', { home })).toEqual({ key: 'WB_PROBE' })
    expect(readFileSync(globalEnv({ home }).path, 'utf8')).not.toContain('\n\n\n')
    expect(globalEnv({ home }).keys.map(k => k.key)).not.toContain('WB_PROBE')
    expect(globalEnv({ home }).keys.map(k => k.key)).toContain('WB_SHORT')
    expect(unsetGlobalEnv('WB_PROBE', { home })).toHaveProperty('refused')
  })

  test('refuses a bad key, an empty value and a value with a newline', () => {
    expect(setGlobalEnv('lower', 'x', { home })).toHaveProperty('refused')
    expect(setGlobalEnv('A B', 'x', { home })).toHaveProperty('refused')
    expect(setGlobalEnv('1ABC', 'x', { home })).toHaveProperty('refused')
    expect(setGlobalEnv('OK_KEY', '', { home })).toHaveProperty('refused')
    expect(setGlobalEnv('OK_KEY', 'a\nEVIL=1', { home })).toHaveProperty('refused')
    expect(globalEnv({ home }).keys.map(k => k.key)).not.toContain('EVIL')
  })
})

describe('commands', () => {
  test('lists a user command with its description and path, and skips _module.md', () => {
    const out = commands({ home })
    expect(out).toEqual([{ name: 'mine:hello', description: 'Says hello.', alias: null, filePath: join(home, '.config', 'fli', 'commands', 'mine', 'hello.md') }])
  })
})

describe('running', () => {
  // A pid that existed and is gone: a child that has exited.
  const dead = spawnSync('true').pid!
  const live = join(home, 'proj-live')
  const gone = join(home, 'proj-gone')
  const keyOf = (p: string) => createHash('sha1').update(realpathSync(p)).digest('hex').slice(0, 12)

  beforeAll(() => {
    mkdirSync(live, { recursive: true })
    mkdirSync(gone, { recursive: true })
    put(join(home, '.fli', 'sessions.lock'), JSON.stringify({
      [live]: { name: 'live', root: live, env: 'dev', slot: 0, pid: process.pid, ports: { fe: [59871], be: [59872] }, startedAt: '2026-11-06T10:00:00.000Z' },
      [gone]: { name: 'gone', root: gone, env: 'dev', slot: 1, pid: dead,        ports: { fe: [59873] },            startedAt: '2026-11-05T10:00:00.000Z' },
    }))
    put(join(home, '.fli', 'holds', `${keyOf(live)}-ports.guard`), String(process.pid))
    put(join(home, '.fli', 'holds', `${keyOf(gone)}-db.guard`), String(dead))
  })

  test('lists a seeded session and says which ports answer', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    try {
      const lock = join(home, '.fli', 'sessions.lock')
      const seeded = JSON.parse(readFileSync(lock, 'utf8'))
      seeded[live].ports.fe = [server.port]
      writeFileSync(lock, JSON.stringify(seeded))
      const out = await running({ home })
      const row = out.sessions.find(s => s.name === 'live')!
      expect(row).toMatchObject({ root: live, alive: true, running: true, pid: process.pid })
      expect(row.ports.find(p => p.category === 'fe')).toEqual({ category: 'fe', port: server.port, answering: true })
      expect(row.ports.find(p => p.category === 'be')).toEqual({ category: 'be', port: 59872, answering: false })
    } finally { server.stop(true) }
  })

  test('a session whose pid is dead is alive: false and not running', async () => {
    const row = (await running({ home })).sessions.find(s => s.name === 'gone')!
    expect(row).toMatchObject({ alive: false, running: false })
    expect(row.ports.every(p => !p.answering)).toBe(true)
  })

  test('lists a hold with its tree, and a dead holder as alive: false', async () => {
    const { holds } = await running({ home })
    expect(holds.find(h => h.resource === 'ports')).toMatchObject({ tree: live, pid: process.pid, alive: true })
    expect(holds.find(h => h.resource === 'db')).toMatchObject({ tree: gone, pid: dead, alive: false, what: null })
    expect(holds.every(h => typeof h.since === 'string')).toBe(true)
  })

  test('an empty state root is nothing running, not an error', async () => {
    expect(await running({ home: join(home, 'nowhere') })).toEqual({ sessions: [], holds: [] })
  })
})

describe('services', () => {
  const svcHome = mkdtempSync(join(tmpdir(), 'wb-services-'))
  const TOKEN   = 'ghp_NEVER_IN_A_RESPONSE_0123456789abcdef'
  // A PATH of one directory of stub binaries, so a probe reads the stub and never this laptop's login.
  const bin = join(svcHome, 'bin')
  const stub = (name: string, body: string) => {
    put(join(bin, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(bin, name), 0o755)
  }
  beforeAll(() => {
    put(join(svcHome, '.config', 'fli', '.env'), `GITHUB_TOKEN=${TOKEN}\n`)
    stub('gh', 'echo "github.com"; echo "  Logged in to github.com account alice (keyring)"; echo "  - Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789"')
    stub('npm', 'echo "npm error code E401" >&2; exit 1')
  })
  afterAll(() => rmSync(svcHome, { recursive: true, force: true }))

  test('lists the 13 services, with the github row naming its commands and which key is held', async () => {
    const list   = await servicesList({ home: svcHome, env: { PATH: bin } })
    expect(list).toHaveLength(13)
    const github = list.find(s => s.id === 'github')!
    expect(github.commands.map(c => c.name)).toContain('github:create')
    expect(github.signIn).toMatchObject({ kind: 'env', keys: [{ key: 'GITHUB_TOKEN', present: true }] })
    expect(github.present).toBe(true)
    expect(list.find(s => s.id === 'github-cli')!.signIn).toMatchObject({ kind: 'cli', bin: 'gh', installed: true, login: 'gh auth login' })
    expect(list.find(s => s.id === 'hetzner')!.present).toBe(false)
  })

  test('no response carries a token value', async () => {
    const list = await servicesList({ home: svcHome, env: { PATH: bin } })
    expect(JSON.stringify(list)).not.toContain(TOKEN)
    expect(JSON.stringify(globalEnv({ home: svcHome }))).not.toContain(TOKEN)
  })

  test('globalEnv names the service that reads each key', () => {
    expect(globalEnv({ home: svcHome }).keys.find(k => k.key === 'GITHUB_TOKEN')!.usedBy).toEqual(['GitHub (REST)'])
    expect(globalEnv({ home }).keys.find(k => k.key === 'TOKEN')!.usedBy).toEqual([])
  })

  test('probeService answers only who, from a stub gh; a signed-out npm is not ok', () => {
    const out = probeService('github-cli', { env: { PATH: bin } })
    expect(out).toMatchObject({ ok: true, who: 'alice' })
    expect(Object.keys(out).sort()).toEqual(['ms', 'ok', 'who'])
    expect(JSON.stringify(out)).not.toContain('ghp_')
    expect(probeService('npm', { env: { PATH: bin } })).toMatchObject({ ok: false, who: null })
  })

  test('an unknown id, and a service with no login to check, are refused', () => {
    expect(() => probeService('nope')).toThrow(/No service/)
    expect(() => probeService('github')).toThrow(/no login to check/)
  })
})

describe('phone ping', () => {
  test('a topic round-trips through ~/.claude/ntfy-topic, and empty turns it off', () => {
    expect(ping({ home })).toMatchObject({ topic: null, url: null })
    expect(setPing(' fjs-test-ping ', { home })).toMatchObject({ topic: 'fjs-test-ping', url: 'https://ntfy.sh/fjs-test-ping' })
    expect(readFileSync(join(home, '.claude', 'ntfy-topic'), 'utf8')).toBe('fjs-test-ping\n')
    expect(setPing('', { home })).toMatchObject({ topic: null })
    expect(existsSync(join(home, '.claude', 'ntfy-topic'))).toBe(false)
  })

  test('a topic outside ntfy\'s alphabet is refused, so it cannot reshape the hook\'s URL', () => {
    expect(setPing('a/b', { home })).toHaveProperty('refused')
    expect(setPing('x?y=1', { home })).toHaveProperty('refused')
    expect(ping({ home }).topic).toBeNull()
  })
})
