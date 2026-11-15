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
import { globalEnv, setGlobalEnv, unsetGlobalEnv, commands, profiles, profileList, addProfile, setProfileEnv, unsetProfileEnv } from '../src/domain/laptop/settings.ts'
import { running } from '../src/domain/laptop/running.ts'
import { servicesList, probeService } from '../src/domain/laptop/services.ts'
import { setup, stateOf } from '../src/domain/laptop/setup.ts'
import { DEV_ENCRYPTION_KEY, DEV_WORKBENCH_KEY } from '../src/core/env.ts'
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

describe('profiles', () => {
  const VALUE = 'acme-RAWVALUE-xy'
  const code  = join(home, 'code')

  test('a profile is made empty at 600, and making it twice or with a bad name is refused', () => {
    expect(addProfile('acme', { home })).toEqual({ name: 'acme' })
    expect(addProfile('acme', { home })).toHaveProperty('refused')
    expect(addProfile('../x', { home })).toHaveProperty('refused')
    expect(addProfile('Acme', { home })).toHaveProperty('refused')
    expect(profileList({ home })).toEqual({ names: ['acme'] })
    expect((statSync(join(home, '.config', 'fli', 'profiles', 'acme.env')).mode & 0o777).toString(8)).toBe('600')
  })

  test('set lists the key masked and the projects naming it; the value never leaves', () => {
    put(join(code, 'client', 'app', '.env'), 'FLI_PROFILE=acme\n')
    expect(setProfileEnv('acme', 'CLOUDFLARE_API_TOKEN', VALUE, { home })).toEqual({ name: 'acme', key: 'CLOUDFLARE_API_TOKEN' })
    const out = profiles({ home })
    const acme = out.profiles.find(p => p.name === 'acme')!
    expect(acme).toMatchObject({ mode: '600', open: false, projects: [join(code, 'client', 'app')] })
    expect(acme.keys.find(k => k.key === 'CLOUDFLARE_API_TOKEN')?.masked).toBe('••••xy')
    expect(JSON.stringify(out)).not.toContain(VALUE)
    expect(readFileSync(acme.path, 'utf8')).toContain(`CLOUDFLARE_API_TOKEN=${VALUE}`)
    // The global env is a different file and holds none of it.
    expect(readFileSync(globalEnv({ home }).path, 'utf8')).not.toContain(VALUE)
  })

  test('a file others can read is flagged open', () => {
    chmodSync(join(home, '.config', 'fli', 'profiles', 'acme.env'), 0o644)
    expect(profiles({ home }).profiles[0]).toMatchObject({ mode: '644', open: true })
    chmodSync(join(home, '.config', 'fli', 'profiles', 'acme.env'), 0o600)
  })

  test('refuses a key or value the global env would, and a profile that is not there', () => {
    expect(setProfileEnv('acme', 'lower', 'x', { home })).toHaveProperty('refused')
    expect(setProfileEnv('acme', 'OK_KEY', '', { home })).toHaveProperty('refused')
    expect(setProfileEnv('acme', 'OK_KEY', 'a\nEVIL=1', { home })).toHaveProperty('refused')
    expect(setProfileEnv('ghost', 'OK_KEY', 'x', { home })).toHaveProperty('refused')
    expect(setProfileEnv('../x', 'OK_KEY', 'x', { home })).toHaveProperty('refused')
  })

  test('unset removes the key and leaves the rest; unsetting twice is refused', () => {
    setProfileEnv('acme', 'KEEP_ME', 'abc', { home })
    expect(unsetProfileEnv('acme', 'CLOUDFLARE_API_TOKEN', { home })).toEqual({ name: 'acme', key: 'CLOUDFLARE_API_TOKEN' })
    expect(profiles({ home }).profiles[0].keys.map(k => k.key)).toEqual(['KEEP_ME'])
    expect(unsetProfileEnv('acme', 'CLOUDFLARE_API_TOKEN', { home })).toHaveProperty('refused')
    expect(unsetProfileEnv('ghost', 'KEEP_ME', { home })).toHaveProperty('refused')
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

describe('setup', () => {
  const setupHome = mkdtempSync(join(tmpdir(), 'wb-setup-'))
  afterAll(() => rmSync(setupHome, { recursive: true, force: true }))

  const signedIn  = async () => ({ ok: true as const, value: { loggedIn: true, authMethod: 'claude.ai', apiProvider: null, email: 'a@b.c', orgId: null, orgName: null, subscriptionType: null } })
  const signedOut = async () => ({ ok: true as const, value: { loggedIn: false, authMethod: null, apiProvider: null, email: null, orgId: null, orgName: null, subscriptionType: null } })
  const fresh     = { WORKBENCH_KEY: 'a-real-pass-phrase', ENCRYPTION_KEY: 'f'.repeat(64) }
  const common    = { home: setupHome, versionOf: () => '99.0.0', gitOf: () => 'set', env: { PATH: '' } as Record<string, string>, keys: fresh, auth: signedIn }
  const goal = (out: Awaited<ReturnType<typeof setup>>, id: string) => out.goals.find(g => g.id === id)!

  test('answers the five goals in order, Run fli and Use Claude in Workbench required', async () => {
    const out = await setup({ ...common, has: () => true })
    expect(out.goals.map(g => g.id)).toEqual(['fli', 'claude', 'build', 'desktop', 'deploy'])
    expect(out.goals.filter(g => g.required).map(g => g.id)).toEqual(['fli', 'claude'])
  })

  test('a machine with every tool and a signed-in claude has Run fli and Claude ok', async () => {
    const out = await setup({ ...common, has: () => true })
    expect(goal(out, 'fli').state).toBe('ok')
    // The phone ping is off in a temp home, so the goal warns rather than errors.
    expect(goal(out, 'claude').state).toBe('warn')
    expect(goal(out, 'claude').rows.find(r => r.id === 'ping')).toMatchObject({ ok: false })
  })

  test('a key held only in fli\'s global env file reads as set, though this process never loaded it', async () => {
    const own = mkdtempSync(join(tmpdir(), 'wb-setup-global-'))
    try {
      const out = await setup({ ...common, home: own, has: () => true })
      const key = out.goals.flatMap(g => g.rows).find(r => r.id.startsWith('env:'))!
      expect(key.ok).toBe(false)
      setGlobalEnv(key.label, 'x', { home: own })
      const again = await setup({ ...common, home: own, has: () => true })
      expect(again.goals.flatMap(g => g.rows).find(r => r.id === key.id)).toMatchObject({ ok: true })
    } finally { rmSync(own, { recursive: true, force: true }) }
  })

  test('a missing git is an error on Run fli; a missing cargo only warns Desktop builds', async () => {
    const out = await setup({ ...common, has: (c) => c !== 'git' && c !== 'cargo' })
    expect(goal(out, 'fli').state).toBe('error')
    expect(goal(out, 'fli').rows.find(r => r.id === 'bin:git')).toMatchObject({ ok: false, level: 'error', fix: { copy: 'sudo apt install git' } })
    expect(goal(out, 'desktop')).toMatchObject({ state: 'unset' })
    expect(goal(out, 'desktop').rows.find(r => r.id === 'bin:cargo')!.fix).toEqual({ url: 'https://rustup.rs', note: expect.any(String) })
  })

  test('an optional goal with nothing present reads unset, not warn', async () => {
    const out = await setup({ ...common, has: (c) => ['bun', 'git', 'claude'].includes(c) })
    expect(goal(out, 'desktop').state).toBe('unset')
    expect(goal(out, 'deploy').state).toBe('unset')
    expect(goal(out, 'build').state).toBe('unset')
  })

  test('a signed-out claude is an error on Use Claude in Workbench, and the fix is a command to copy', async () => {
    const out = await setup({ ...common, has: () => true, auth: signedOut })
    expect(goal(out, 'claude').state).toBe('error')
    expect(goal(out, 'claude').rows.find(r => r.id === 'claude:login')).toMatchObject({ ok: false, fix: { copy: 'claude auth login' } })
  })

  test('the two dev default keys are flagged as a boolean, and the value never leaves', async () => {
    const out  = await setup({ ...common, has: () => true, keys: { WORKBENCH_KEY: DEV_WORKBENCH_KEY, ENCRYPTION_KEY: DEV_ENCRYPTION_KEY } })
    const rows = goal(out, 'claude').rows
    expect(rows.find(r => r.id === 'key:WORKBENCH_KEY')).toMatchObject({ ok: false, detail: 'still the dev default' })
    expect(rows.find(r => r.id === 'key:ENCRYPTION_KEY')).toMatchObject({ ok: false })
    // Advice only: a dev default is not what makes the goal fail.
    expect(rows.filter(r => r.level === 'error')).toEqual([])
    const text = JSON.stringify(out)
    expect(text).not.toContain(DEV_WORKBENCH_KEY)
    expect(text).not.toContain(DEV_ENCRYPTION_KEY)
    expect(JSON.stringify(await setup({ ...common, has: () => true }))).not.toContain(fresh.ENCRYPTION_KEY)
  })

  test('a set ping topic is ok', async () => {
    put(join(setupHome, '.claude', 'ntfy-topic'), 'my-topic\n')
    const out = await setup({ ...common, has: () => true })
    expect(goal(out, 'claude').rows.find(r => r.id === 'ping')).toMatchObject({ ok: true })
    expect(goal(out, 'claude').state).toBe('ok')
  })

  test('every row carries a why, and every fix is copy, url or go -- never a verb that runs a shell', async () => {
    // Q3 = A (FJS-D2162) enforced rather than remembered: a fix with any other key is a test failure.
    const bare = await setup({ ...common, has: () => false, gitOf: () => '', auth: signedOut, keys: { WORKBENCH_KEY: DEV_WORKBENCH_KEY, ENCRYPTION_KEY: DEV_ENCRYPTION_KEY } })
    const fixes = bare.goals.flatMap(g => g.rows).filter(r => !r.ok).map(r => r.fix)
    expect(fixes.length).toBeGreaterThan(10)
    for (const f of fixes) {
      expect(f).not.toBeNull()
      const keys = Object.keys(f!).sort().join(',')
      expect(['copy', 'go,label', 'note,url']).toContain(keys)
      for (const v of Object.values(f!)) expect(typeof v).toBe('string')
    }
    for (const r of bare.goals.flatMap(g => g.rows)) expect(r.why.length).toBeGreaterThan(0)
  })

  test('stateOf is derived from the rows alone', () => {
    const r = (ok: boolean, level: 'ok' | 'warn' | 'error') => ({ id: 'x', label: 'x', ok, level, detail: null, why: 'w', fix: null })
    expect(stateOf(true,  [r(false, 'error')])).toBe('error')
    expect(stateOf(true,  [r(false, 'warn'), r(true, 'ok')])).toBe('warn')
    expect(stateOf(false, [r(false, 'warn')])).toBe('unset')
    expect(stateOf(false, [r(false, 'warn'), r(true, 'ok')])).toBe('warn')
    expect(stateOf(false, [r(true, 'ok')])).toBe('ok')
  })
})
