/*
 * test/ports.test.js
 *
 * The port scheme is a FORMULA, and the thing worth testing about it is that
 * two apps never derive one number. Everything below is in service of that:
 * `appPorts` is what `fli dev` refuses on, so a wrong answer there is either a
 * refusal nobody can act on or — worse — a check that passes while a stale
 * server still owns the port and still holds the old database open.
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, realpathSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join, basename } from 'path'
import { pathToFileURL } from 'url'
import { appPorts, devPorts, scriptsRunBy, projectIdFor, PROJECTS, port, ENV, CAT,
         GLOBAL, GLOBAL_RANGE, isGlobalPort, isReservedToolingPort, guiPort,
         apiContainerName, claimSession, getSessionStatus, releaseSession,
         readLock, readsPortVar, decode, worktreeOf, portFor, composedSurfaces,
         portStatus, parseDockerPorts } from '../core/ports.js'

// A surface is a directory at the app root (Invariant 3), so a fake tree is
// exactly a set of directory names — no filesystem needed.
const treeOf = (...dirs) => (p) => dirs.some(d => p.endsWith(`/${d}`))

describe('projectIdFor — which app is this', () => {
  test('the scoped name, the bare name and the directory all resolve', () => {
    expect(projectIdFor('@frontierjs/example', 'example')).toBe(PROJECTS.example)
    expect(projectIdFor('example', 'anything')).toBe(PROJECTS.example)
    expect(projectIdFor('@acme/whatever', 'basecamp')).toBe(PROJECTS.basecamp)
  })

  test('an app nobody has assigned is the scaffold, which is what the templates use', () => {
    // Not a throw and not a random id: 0 is the number in every scaffolded
    // vite.config, so an app that has not been assigned one is honestly
    // described by it.
    expect(projectIdFor('@acme/brand-new', 'brand-new')).toBe(PROJECTS.scaffold)
    expect(projectIdFor(undefined, undefined)).toBe(PROJECTS.scaffold)
  })
})

describe('the site surface — its own two categories', () => {
  test('siteDev and siteServe are distinct rows, and neither is the SPA\'s', () => {
    const projectId = PROJECTS.example
    const web       = port('fe',        { env: 'dev', projectId })
    const dev       = port('siteDev',   { env: 'dev', projectId })
    const served    = port('siteServe', { env: 'dev', projectId })

    expect(web).toBe(8010)
    expect(dev).toBe(8610)
    expect(served).toBe(8710)

    // The point of two CATEGORIES rather than two service slots on `fe`: a
    // site being written and a site being served are two origins, and neither
    // is a second server belonging to the SPA.
    expect(new Set([web, dev, served]).size).toBe(3)
  })

  test('the test env is a different block, so a drive cannot take a dev server\'s port', () => {
    const projectId = PROJECTS.example
    expect(port('siteDev',   { env: 'test', projectId })).toBe(7610)
    expect(port('siteServe', { env: 'test', projectId })).toBe(7710)
  })

  test('a scaffolded app is project 0 — the number in the templates', () => {
    expect(port('siteDev',   { env: 'dev', projectId: PROJECTS.scaffold })).toBe(8600)
    expect(port('siteServe', { env: 'dev', projectId: PROJECTS.scaffold })).toBe(8700)
  })

  test('site/ is a surface appPorts derives, not a list an app keeps', () => {
    const rows = appPorts('/x/example', {
      name: 'example', exists: treeOf('web', 'api', 'site'),
    })
    const site = rows.find(r => r.surface === 'site')
    expect(site).toBeTruthy()
    expect(site.port).toBe(8610)

    // And absent when the directory is: which surfaces an app has is the app's
    // business, and a refusal naming a port nothing is about to bind is worse
    // than no refusal.
    const noSite = appPorts('/x/example', { name: 'example', exists: treeOf('web', 'api') })
    expect(noSite.find(r => r.surface === 'site')).toBeUndefined()
  })
})

describe('appPorts — what this app is about to bind', () => {
  test('the two apps in this repo get the numbers their configs already hold', () => {
    const example  = appPorts('/x/example',  { name: '@frontierjs/example',  exists: treeOf('web', 'api') })
    const basecamp = appPorts('/x/basecamp', { name: '@frontierjs/basecamp', exists: treeOf('web', 'api') })

    // These are the literals in each app's vite config and test harness. A
    // change here renames a port two apps have hard-coded.
    expect(example.map(p => p.port).sort()).toEqual([8010, 8110])
    expect(basecamp.map(p => p.port).sort()).toEqual([8020, 8120])
  })

  test('only the surfaces that EXIST are probed', () => {
    // A list kept per app is the thing that goes stale the day somebody adds a
    // surface; reading the tree is what stops that. The other direction matters
    // as much: refusing on a port for a surface this app does not have is a
    // refusal nobody can act on.
    const apiOnly = appPorts('/x/example', { name: 'example', exists: treeOf('api') })
    expect(apiOnly.map(p => p.surface)).toEqual(['api'])

    const withWidgets = appPorts('/x/example', { name: 'example', exists: treeOf('web', 'api', 'widgets') })
    expect(withWidgets.map(p => p.surface).sort()).toEqual(['api', 'web', 'widgets'])
    // Category 2 is widgetDev — a widgets surface is a THIRD server while one
    // is being written, and it is not the SPA's.
    expect(withWidgets.find(p => p.surface === 'widgets').port).toBe(8210)
  })

  test('an app with no surfaces asks for nothing', () => {
    expect(appPorts('/x/empty', { name: 'example', exists: () => false })).toEqual([])
  })

  test('the script it names is one the app actually declares', () => {
    const here = appPorts('/x/example', {
      name: 'example', exists: treeOf('web', 'api'),
      scripts: { api: 'bun run api/app.ts', web: 'vite' },
    })
    expect(here.find(r => r.surface === 'api').script).toBe('api')
  })

  test('a surface script has one name, its directory (FJS-D1083)', () => {
    const prefixed = appPorts('/x/new-app', {
      name: 'new-app', exists: treeOf('web', 'api'),
      scripts: { 'dev:api': 'bun --watch run api/index.ts', 'dev:web': 'cd web && vite' },
    })
    expect(prefixed.find(r => r.surface === 'api').script).toBe(null)
    expect(prefixed.find(r => r.surface === 'web').script).toBe(null)
  })

  test('a surface with no script says so rather than inventing one', () => {
    const rows = appPorts('/x/odd', { name: 'odd', exists: treeOf('api'), scripts: {} })
    expect(rows[0].script).toBe(null)
  })
})

describe('devPorts — what `fli dev` is about to bind', () => {
  // FJS-568. `appPorts` answers what the app's surfaces WOULD bind; the
  // preflight has to answer what THIS command is about to. Refusing on the
  // difference is a refusal nobody can act on: the port named is one the
  // command would never have taken.
  const five = treeOf('web', 'api', 'site', 'widgets', 'extension')

  test("an app whose dev starts two of five surfaces is checked on two", () => {
    const scripts = {
      dev:          'bun run api & bun run web & wait',
      api:          'bun run api/index.ts',
      web:          'vite -c web/config/vite.config.js',
      'dev:site':   'cd site && vite -c config/vite.config.js',
      'dev:widgets': 'cd widgets && vite -c config/vite.config.js',
    }
    const rows = devPorts('/x/example', { name: 'example', exists: five, scripts })
    expect(rows.map(r => r.surface).sort()).toEqual(['api', 'web'])
    // The whole point: the site's port is NOT among them.
    expect(rows.some(r => r.port === 8610)).toBe(false)
    // And `appPorts` still answers the catalog, which `fli ports` wants.
    expect(appPorts('/x/example', { name: 'example', exists: five, scripts }).length).toBe(5)
  })

  test('a scaffolded app composes every surface, so every one is checked', () => {
    const scripts = {
      dev:        'bun run --parallel api web dev:site',
      api:        'bun --watch run api/index.ts',
      web:        'cd web && vite -c config/vite.config.js',
      'dev:site': 'cd site && bun --bun vite -c config/vite.config.js',
    }
    const rows = devPorts('/x/new-app', { name: 'new-app', exists: treeOf('web', 'api', 'site'), scripts })
    expect(rows.map(r => r.surface).sort()).toEqual(['api', 'site', 'web'])
  })

  test('a dev that IS the surface command cannot be narrowed, so it is not', () => {
    // `fli new` writes `dev` as the command itself when there is one surface.
    // Narrowing to nothing here would skip the only check worth making.
    const rows = devPorts('/x/one', {
      name: 'one', exists: treeOf('web'),
      scripts: { dev: 'cd web && vite -c config/vite.config.js' },
    })
    expect(rows.map(r => r.surface)).toEqual(['web'])
  })

  test('a directory name that matches a script is not a script reference', () => {
    // The trap in anchoring on bare tokens: `cd web && vite` holds a `web` that
    // is a directory, and this app declares a `web` script.
    const scripts = {
      dev: 'bun run api & bun run dev:web & wait',
      api: 'bun run api/index.ts',
      web: 'vite',
      'dev:web': 'cd web && vite -c web/config/vite.config.js',
    }
    expect([...scriptsRunBy(scripts)].sort()).toEqual(['api', 'dev:web'])
  })

  test('a surface matches on either spelling, not just the one appPorts prints', () => {
    // An app may declare both `dev:site` and `site` and run the other one.
    const scripts = {
      dev:        'bun run site',
      'dev:site': 'cd site && vite',
      site:       'cd site && vite',
    }
    const rows = devPorts('/x/both', { name: 'both', exists: treeOf('site'), scripts })
    expect(rows.map(r => r.surface)).toEqual(['site'])
  })

  test('an indirection is followed', () => {
    const scripts = {
      dev:     'bun run dev:all',
      'dev:all': 'bun run --parallel api web',
      api:       'bun --watch run api/index.ts',
      web:       'cd web && vite',
    }
    const rows = devPorts('/x/deep', { name: 'deep', exists: treeOf('web', 'api', 'site'), scripts })
    expect(rows.map(r => r.surface).sort()).toEqual(['api', 'web'])
  })

  test('a cycle terminates', () => {
    const scripts = { dev: 'bun run a', a: 'bun run b', b: 'bun run a' }
    expect(scriptsRunBy(scripts)).toEqual(new Set(['a', 'b']))
  })

  test('no manifest at all falls back to the catalog', () => {
    const rows = devPorts('/x/bare', { name: 'bare', exists: treeOf('web', 'api') })
    expect(rows.map(r => r.surface).sort()).toEqual(['api', 'web'])
  })
})

describe('the scheme itself', () => {
  test('no two assigned apps share a frontend or a backend port', () => {
    // The failure that made this scheme exist: example and basecamp both asked
    // for 5274, vite hopped in silence, and the second app's drive tested the
    // first app's app.
    const fe = Object.values(PROJECTS).map(id => port('fe', { env: 'dev', projectId: id }))
    const be = Object.values(PROJECTS).map(id => port('be', { env: 'dev', projectId: id }))
    expect(new Set(fe).size).toBe(fe.length)
    expect(new Set(be).size).toBe(be.length)
  })

  test('an unassigned app has no project id to take, so it takes a service digit', () => {
    // Every digit is assigned. A dynamic PROJECT id would have to be 10, which
    // the formula refuses, and that is how the broker came to hand out nothing.
    expect(Object.values(PROJECTS).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(() => port('fe', { env: 'dev', projectId: 10 })).toThrow()
    expect(port('fe', { env: 'dev', projectId: PROJECTS.scaffold, serviceId: 3 })).toBe(8003)
  })
})

describe('claimSession — each app its own dev slot', () => {
  const DEAD  = 2 ** 30               // no such pid
  const tree  = treeOf('web', 'api')
  const free  = async () => []
  const reads = () => true
  let dir, lockFile
  const claim = (root, opts = {}) =>
    claimSession(root, { exists: tree, busy: free, movable: reads, lockFile, ...opts })
  const age = (root, pid, startedAt) => {
    const all = readLock(lockFile)
    all[root] = { ...all[root], pid, ...(startedAt ? { startedAt } : {}) }
    writeFileSync(lockFile, JSON.stringify(all))
  }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fli-ports-')); lockFile = join(dir, 'sessions.lock') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('two scaffolded apps run side by side', async () => {
    const a = await claim('/x/a', { name: 'a' })
    const b = await claim('/x/b', { name: 'b' })
    expect(a.slot).toBe(0)
    expect(a.rows.map(r => r.port).sort()).toEqual([8000, 8100])
    expect(b.slot).toBe(1)
    expect(b.rows.map(r => r.port).sort()).toEqual([8001, 8101])
    expect(b.vars).toEqual({ FRONTIER_PORT_FE: '8001', FRONTIER_PORT_BE: '8101' })
  })

  test('the slot is remembered while the app is not running', async () => {
    // A tab, an OAuth redirect and FRONTIER_APP_URL all name the port.
    await claim('/x/a', { name: 'a' })
    await claim('/x/b', { name: 'b' })
    age('/x/b', DEAD)
    expect((await claim('/x/c', { name: 'c' })).slot).toBe(2)
    expect((await claim('/x/b', { name: 'b' })).slot).toBe(1)
  })

  test('a new app skips a slot something unrecorded is listening on', async () => {
    const busy = async (rows) => rows.filter(r => r.port === 8000)
    expect((await claim('/x/a', { name: 'a', busy })).slot).toBe(1)
  })

  test("an app's own busy slot is kept, so the caller refuses rather than moving beside a ghost", async () => {
    await claim('/x/a', { name: 'a' })
    age('/x/a', DEAD)
    const busy = async (rows) => rows.filter(r => r.port === 8000)
    expect((await claim('/x/a', { name: 'a', busy })).slot).toBe(0)
  })

  test('an app the table assigns keeps its numbers', async () => {
    await claim('/x/a', { name: 'a' })
    const ex = await claim('/x/example', { name: '@frontierjs/example' })
    expect(ex.slot).toBe(0)
    expect(ex.rows.map(r => r.port).sort()).toEqual([8010, 8110])
  })

  test('an app whose configs ignore the variable stays at 0, where its server will be', async () => {
    await claim('/x/a', { name: 'a' })
    const legacy = await claim('/x/legacy', { name: 'legacy', movable: () => false })
    expect(legacy.slot).toBe(0)
  })

  test('ten remembered: the idle one that ran longest ago gives its slot up', async () => {
    for (let i = 0; i < 10; i++) {
      await claim(`/x/app${i}`, { name: `app${i}` })
      age(`/x/app${i}`, DEAD, `2026-09-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`)
    }
    age('/x/app0', process.pid)            // running, so not a candidate
    const n = await claim('/x/new', { name: 'new' })
    expect(n.slot).toBe(1)
    expect(readLock(lockFile)['/x/app1']).toBeUndefined()
  })

  test('ten running: refused, naming the way out', async () => {
    for (let i = 0; i < 10; i++) await claim(`/x/app${i}`, { name: `app${i}` })
    await expect(claim('/x/new', { name: 'new' })).rejects.toThrow(/ports:status --clean/)
  })

  test('--dry answers and writes nothing', async () => {
    const d = await claim('/x/a', { name: 'a', dry: true })
    expect(d.slot).toBe(0)
    expect(existsSync(lockFile)).toBe(false)
  })

  test('status and forget are keyed by root, so two apps with one name are two apps', async () => {
    await claim('/x/one/app', { name: 'app' })
    await claim('/x/two/app', { name: 'app' })
    const rows = getSessionStatus({ lockFile })
    expect(rows.map(r => [r.root, r.slot, r.alive])).toEqual([['/x/one/app', 0, true], ['/x/two/app', 1, true]])
    releaseSession('/x/one/app', { lockFile })
    expect(Object.keys(readLock(lockFile))).toEqual(['/x/two/app'])
  })
})

describe('portStatus — `fli ps <port>`', () => {
  const PROBE = 15_000                // one lsof per port, about a second each
  let dir, lockFile
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fli-ports-')); lockFile = join(dir, 'sessions.lock') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a handed-out slot is named by the app that holds it, not the table', async () => {
    // 8008 is past service slot 0, so busyKnownPorts would never see it.
    writeFileSync(lockFile, JSON.stringify({ '/x/eight': { name: 'eight', ports: { fe: 8008, be: [8108] } } }))
    const fe = await portStatus(8008, { lockFile })
    expect([fe.env, fe.category, fe.projectId, fe.serviceId, fe.project]).toEqual(['dev', 'fe', 0, 8, 'eight'])
    expect((await portStatus(8108, { lockFile })).project).toBe('eight')
  }, PROBE)

  test('the reserved block and the table name what the lock file does not', async () => {
    expect((await portStatus(GLOBAL.studio, { lockFile })).project).toBe('fli studio')
    expect((await portStatus(8010, { lockFile })).project).toBe('example')
    expect((await portStatus(8013, { lockFile })).project).toBeNull()
  }, PROBE)

  test('a listening port reads busy with its pid', async () => {
    const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } })
    try {
      const s = await portStatus(server.port, { lockFile })
      expect(s.busy).toBe(true)
      if (s.pids.length) expect(s.pids).toContain(String(process.pid))
    } finally { server.stop(true) }
  }, PROBE)
})

describe('claimSession — a linked worktree takes a branch block', () => {
  const tree  = treeOf('web', 'api')
  const free  = async () => []
  const reads = () => true
  const REPO  = { repo: '/m/.git', main: '/m' }
  const wt    = (top, repo = REPO) => ({ ...repo, top })
  let dir, lockFile
  const claim = (root, opts = {}) =>
    claimSession(root, { exists: tree, busy: free, movable: reads, worktreeExists: () => true, lockFile, worktree: null, ...opts })

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'fli-branch-')); lockFile = join(dir, 'sessions.lock') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test("branch 1 is the parent's ports with a leading 1", async () => {
    const b = await claim('/t/one/packages/basecamp', { name: '@frontierjs/basecamp', worktree: wt('/t/one') })
    expect(b.branch).toBe(1)
    expect(b.rows.map(r => r.port).sort()).toEqual([18020, 18120])
    expect(b.vars).toEqual({ FRONTIER_PORT_FE: '18020', FRONTIER_PORT_BE: '18120' })
    expect(readLock(lockFile)['/t/one/packages/basecamp']).toMatchObject({ branch: 1, repo: '/m/.git', worktree: '/t/one' })
  })

  test('the next worktree of the repository takes 2; one app beside it in the same worktree shares 1', async () => {
    await claim('/t/one/packages/basecamp', { name: '@frontierjs/basecamp', worktree: wt('/t/one') })
    const two = await claim('/t/two/packages/basecamp', { name: '@frontierjs/basecamp', worktree: wt('/t/two') })
    const ex  = await claim('/t/one/example', { name: '@frontierjs/example', worktree: wt('/t/one') })
    expect(two.branch).toBe(2)
    expect(two.rows.map(r => r.port).sort()).toEqual([28020, 28120])
    expect(ex.branch).toBe(1)
    expect(ex.rows.map(r => r.port).sort()).toEqual([18010, 18110])
  })

  test('another repository counts from 1 again, and a number is remembered', async () => {
    await claim('/t/one/app', { name: 'app', worktree: wt('/t/one') })
    const other = await claim('/u/one/app', { name: 'app', worktree: wt('/u/one', { repo: '/n/.git', main: '/n' }) })
    expect(other.branch).toBe(1)
    await claim('/t/two/app', { name: 'app', worktree: wt('/t/two') })
    expect((await claim('/t/one/app', { name: 'app', worktree: wt('/t/one') })).branch).toBe(1)
  })

  test("a scaffolded app in a branch keeps its parent's slot", async () => {
    await claim('/m/a', { name: 'a' })
    await claim('/m/b', { name: 'b' })
    const b = await claim('/t/one/b', { name: 'b', worktree: wt('/t/one') })
    expect([b.slot, b.branch]).toEqual([1, 1])
    expect(b.rows.map(r => r.port).sort()).toEqual([18001, 18101])
  })

  test('an app whose configs ignore the variable gets no number, so the refusal names its real port', async () => {
    const b = await claim('/t/one/legacy', { name: 'legacy', worktree: wt('/t/one'), movable: () => false })
    expect(b.branch).toBe(0)
    expect(b.rows.map(r => r.port).sort()).toEqual([8000, 8100])
  })

  test('five held: refused naming the way out; archiving one frees its number', async () => {
    for (let n = 1; n <= 5; n++) await claim(`/t/${n}/app`, { name: 'app', worktree: wt(`/t/${n}`) })
    await expect(claim('/t/6/app', { name: 'app', worktree: wt('/t/6') })).rejects.toThrow(/ports:status --clean/)
    releaseSession('/t/3', { lockFile })
    expect((await claim('/t/6/app', { name: 'app', worktree: wt('/t/6') })).branch).toBe(3)
  })

  // FJS-2889: a removed worktree's lock entry held its number for good, so five
  // throwaway checkouts (/tmp, a scratchpad) locked every lane out of portFor.
  test('five held, two of them in directories that are gone: the new worktree takes the lowest of those', async () => {
    for (let n = 1; n <= 5; n++) await claim(`/t/${n}/app`, { name: 'app', worktree: wt(`/t/${n}`) })
    const gone = new Set(['/t/2', '/t/4'])
    const worktreeExists = (top) => !gone.has(top)
    const b = await claim('/t/6/app', { name: 'app', worktree: wt('/t/6'), worktreeExists })
    expect(b.branch).toBe(2)
    const lock = readLock(lockFile)
    expect(lock['/t/2/app']).toBeUndefined()
    expect(lock['/t/4/app']).toBeUndefined()
    expect(lock['/t/5/app']).toMatchObject({ branch: 5 })
    expect(lock['/t/6/app']).toMatchObject({ branch: 2 })
  })

  test('decode reads the branch digit and leaves the rest as the parent reads it', () => {
    expect(decode(18120)).toEqual({ env: 'dev', category: 'be', projectId: 2, serviceId: 0, branch: 1 })
    expect(decode(8120).branch).toBe(0)
    expect(apiContainerName('basecamp', 17120)).toBe('basecamp-api-test')
  })
})

describe('worktreeOf — is this a second checkout', () => {
  let dir
  const git = (cwd, ...argv) => execFileSync('git', ['-C', cwd, ...argv], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'fli-wt-'))) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a main checkout is null and a linked worktree names its repository, its top and the main checkout', () => {
    const main = join(dir, 'main')
    mkdirSync(join(main, 'app'), { recursive: true })
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'x')
    git(main, 'worktree', 'add', '-q', join(dir, 'linked'))
    mkdirSync(join(dir, 'linked', 'app'))
    expect(worktreeOf(join(main, 'app'))).toBeNull()
    expect(worktreeOf(join(dir, 'linked', 'app'))).toEqual({ repo: join(main, '.git'), top: join(dir, 'linked'), main })
    expect(worktreeOf(join(dir, 'nowhere'))).toBeNull()
  })
})

describe('portFor — the port a test asks for', () => {
  let dir, main, linked, lockFile
  const git = (cwd, ...argv) => execFileSync('git', ['-C', cwd, ...argv], { stdio: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  const app = (top) => {
    const root = join(top, 'basecamp')
    mkdirSync(join(root, 'db'), { recursive: true })
    mkdirSync(join(root, 'api', 'test'), { recursive: true })
    mkdirSync(join(root, 'web'), { recursive: true })
    writeFileSync(join(root, 'db', 'schema.lite'), '')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@frontierjs/basecamp' }))
    writeFileSync(join(root, 'api', 'server.js'), 'Bun.serve({ port: process.env.FRONTIER_PORT_BE })')
    writeFileSync(join(root, 'web', 'vite.config.js'), 'export default { server: { port: process.env.FRONTIER_PORT_FE } }')
    return root
  }

  beforeEach(() => {
    dir      = realpathSync(mkdtempSync(join(tmpdir(), 'fli-portfor-')))
    lockFile = join(dir, 'sessions.lock')
    main     = join(dir, 'main')
    linked   = join(dir, 'linked')
    mkdirSync(main)
    git(main, 'init', '-q')
    git(main, 'commit', '-q', '--allow-empty', '-m', 'x')
    git(main, 'worktree', 'add', '-q', linked)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('a main checkout gets the formula and never writes the lock', async () => {
    const root = app(main)
    expect(await portFor(join(root, 'api', 'test'), 'be', { service: 3, lockFile })).toBe(7123)
    expect(await portFor(join(root, 'api', 'test'), 'be', { env: 'dev', lockFile })).toBe(8120)
    expect(existsSync(lockFile)).toBe(false)
  })

  test("a branch with no number claims the one fli dev would take, and fli dev's claim then agrees", async () => {
    const root = app(linked)
    const from = pathToFileURL(join(root, 'api', 'test', 'compute.test.ts')).href
    expect(await portFor(from, 'be', { service: 3, lockFile })).toBe(17123)
    expect(readLock(lockFile)[root]).toMatchObject({ branch: 1, worktree: linked })
    const dev = await claimSession(root, { name: '@frontierjs/basecamp', lockFile })
    expect(dev.vars.FRONTIER_PORT_BE).toBe('18120')
  })

  test("a number the lock already holds is used as is, and a project the app does not own moves with it", async () => {
    const root = app(linked)
    writeFileSync(lockFile, JSON.stringify({ [root]: { branch: 2, repo: join(main, '.git'), worktree: linked } }))
    expect(await portFor(root, 'be', { env: 'dev', project: 'outpost', lockFile })).toBe(28180)
    await expect(portFor(root, 'be', { project: 'outposts', lockFile })).rejects.toThrow(/Unknown project "outposts"/)
  })

  test("a scaffolded app on a dev slot gets the slot's port, and a test port stays the formula", async () => {
    const root = join(main, 'my-app')
    mkdirSync(join(root, 'api', 'test'), { recursive: true })
    mkdirSync(join(root, 'db'))
    writeFileSync(join(root, 'db', 'schema.lite'), '')
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'my-app' }))
    writeFileSync(lockFile, JSON.stringify({ [root]: { slot: 3, env: 'dev' } }))
    expect(await portFor(join(root, 'api', 'test'), 'be', { env: 'dev', lockFile })).toBe(8103)
    expect(await portFor(join(root, 'api', 'test'), 'fe', { env: 'dev', lockFile })).toBe(8003)
    expect(await portFor(join(root, 'api', 'test'), 'be', { service: 4, lockFile })).toBe(7104)
    await expect(portFor(join(root, 'api', 'test'), 'be', { env: 'dev', service: 4, lockFile })).rejects.toThrow(/dev slot \(3\)/)
  })
})

describe('readsPortVar — would this surface follow a slot', () => {
  let root
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'fli-reads-')) })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  test('the scaffold reads it; a config with a literal does not; node_modules is not the app', () => {
    mkdirSync(join(root, 'web/config'), { recursive: true })
    const row = { surface: 'web', env: 'FRONTIER_PORT_FE' }
    writeFileSync(join(root, 'web/config/vite.config.js'), 'export default { server: { port: 8000 } }')
    mkdirSync(join(root, 'web/node_modules/x'), { recursive: true })
    writeFileSync(join(root, 'web/node_modules/x/index.js'), 'process.env.FRONTIER_PORT_FE')
    expect(readsPortVar(root, row)).toBe(false)

    writeFileSync(join(root, 'web/config/vite.config.js'), "port: parseInt(process.env.FRONTIER_PORT_FE ?? '8000')")
    expect(readsPortVar(root, row)).toBe(true)
  })

  test('a variable named only in a comment is not read', () => {
    mkdirSync(join(root, 'web/config'), { recursive: true })
    const row = { surface: 'web', env: 'FRONTIER_PORT_FE' }
    writeFileSync(join(root, 'web/config/vite.config.js'), "// the shape a scaffold has for FRONTIER_PORT_FE\n/* FRONTIER_PORT_FE */\nconst UI_PORT = Number(process.env.UI_PORT ?? 8010)")
    expect(readsPortVar(root, row)).toBe(false)

    writeFileSync(join(root, 'web/config/vite.config.js'), "const API = `http://localhost:${process.env.FRONTIER_PORT_FE}`")
    expect(readsPortVar(root, row)).toBe(true)
  })

  test('a surface with no variable has nothing to follow and blocks nothing', () => {
    expect(readsPortVar(root, { surface: 'extension', env: null })).toBe(true)
  })
})

describe('the global tooling block', () => {
  test('every assigned tool is inside 5500-5509', () => {
    for (const [name, p] of Object.entries(GLOBAL)) {
      expect(p, name).toBeGreaterThanOrEqual(GLOBAL_RANGE.first)
      expect(p, name).toBeLessThanOrEqual(GLOBAL_RANGE.last)
    }
  })

  test('no two tools share a slot', () => {
    const ps = Object.values(GLOBAL)
    expect(new Set(ps).size).toBe(ps.length)
  })

  test('no project port in any env can land in the block', () => {
    // A tool has no project, so its digit is not an env: the formula cannot
    // hand an app a number a tool already answers on.
    for (const env of Object.keys(ENV)) {
      for (const category of Object.keys(CAT)) {
        for (let projectId = 0; projectId <= 9; projectId++) {
          for (let serviceId = 0; serviceId <= 9; serviceId++) {
            expect(isReservedToolingPort(port(category, { env, projectId, serviceId }))).toBe(false)
          }
        }
      }
    }
  })

  test('dev tooling for project 0 is an ordinary slot', () => {
    expect(port('tooling', { env: 'dev', projectId: 0 })).toBe(8500)
  })

  test('a tool decodes as global, not as an env', () => {
    expect(decode(GLOBAL.haven)).toMatchObject({ env: 'global', category: 'tooling', serviceId: 5 })
  })

  test('a free slot in the block is reserved but not assigned', () => {
    expect(isReservedToolingPort(5509)).toBe(true)
    expect(isGlobalPort(5509)).toBe(false)
    expect(isGlobalPort(GLOBAL.devtools)).toBe(true)
  })
})


// ─── the container a deploy runs ─────────────────────────────────────────────
// The name is a function of the TIER, which is what makes two concurrent runs
// of one lesson possible. Nine call sites wrote it by hand, so the ports
// separated a CI run from a person's and the container name did not.

describe('the api container name', () => {
  test('a test-tier port gets its own container', () => {
    expect(apiContainerName('my-app', 7103)).toBe('my-app-api-test')
  })

  // The control that keeps the blast radius at zero. Every deployed container
  // is called `<app>-api` today; renaming one would orphan it, because stop,
  // logs and revert all address the name.
  test('dev and prod are unchanged', () => {
    expect(apiContainerName('my-app', 8100)).toBe('my-app-api')
    expect(apiContainerName('my-app', 9100)).toBe('my-app-api')
  })

  test('an absent port is unchanged rather than guessed at', () => {
    expect(apiContainerName('my-app', undefined)).toBe('my-app-api')
    expect(apiContainerName('my-app', null)).toBe('my-app-api')
  })

  // 3000 is the container's INTERNAL port and appears as a default at several
  // call sites. It decodes to no tier, and must not be read as one.
  test("the container's own port is not a tier", () => {
    expect(apiContainerName('my-app', 3000)).toBe('my-app-api')
  })

  test('the two tiers cannot collide, which is the whole point', () => {
    expect(apiContainerName('my-app', 7103)).not.toBe(apiContainerName('my-app', 8100))
  })
})

describe('composedSurfaces', () => {
  const rows = [
    { surface: 'web', script: 'web' },
    { surface: 'api', script: 'api' },
    { surface: 'site', script: 'dev:site' },
  ]

  test('a dev that only runs surface scripts side by side is split into them', () => {
    const picked = composedSurfaces({ dev: 'bun run api & bun run web & wait' }, rows)
    expect(picked.map(r => r.surface)).toEqual(['api', 'web'])
    expect(composedSurfaces({ dev: 'bun run --parallel web dev:site' }, rows).map(r => r.surface)).toEqual(['web', 'site'])
  })

  // Anything else runs as written: a chain is ordered, a foreign command is
  // work fli cannot see, and one surface needs no labels.
  test('a chain, a foreign command, or one surface runs as written', () => {
    expect(composedSurfaces({ dev: 'bun run api && bun run web' }, rows)).toBeNull()
    expect(composedSurfaces({ dev: 'bun run api & vite & wait' }, rows)).toBeNull()
    expect(composedSurfaces({ dev: 'bun run web' }, rows)).toBeNull()
    expect(composedSurfaces({ dev: 'bun run api & bun run api' }, rows)).toBeNull()
    expect(composedSurfaces({}, rows)).toBeNull()
  })
})

describe('parseDockerPorts — what docker ps published', () => {
  test('the IPv4 and IPv6 publish of one port are one row', () => {
    const out = 'search\tmeilisearch:v1\t0.0.0.0:7700->7700/tcp, [::]:7700->7700/tcp\n'
    expect(parseDockerPorts(out)).toEqual([{ port: 7700, container: 7700, name: 'search', image: 'meilisearch:v1' }])
  })

  test('the host port is reported, not the container port', () => {
    const out = 'db\tmysql\t127.0.0.1:33061->3306/tcp\n'
    expect(parseDockerPorts(out)[0]).toMatchObject({ port: 33061, container: 3306 })
  })

  test('a range expands, and an unpublished container contributes nothing', () => {
    const out = 'a\timg\t0.0.0.0:9000-9001->9000-9001/tcp\nb\timg\t3306/tcp\n'
    expect(parseDockerPorts(out).map(r => [r.port, r.container])).toEqual([[9000, 9000], [9001, 9001]])
  })
})

describe('where fli gui listens', () => {
  test('outside a project there is no env, so it is the global slot', () => {
    expect(guiPort(null)).toBe(GLOBAL.gui)
  })

  test('in a project it is that project\'s tooling port for the env', () => {
    const root = mkdtempSync(join(tmpdir(), 'gui-'))
    try {
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'basecamp' }))
      expect(guiPort(root)).toBe(8520)
      expect(guiPort(root, { env: 'test' })).toBe(7520)
      expect(guiPort(root, { env: 'prod' })).toBe(9520)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})

describe('a scaffolded app\'s gui takes its slot', () => {
  test('two scaffolded apps get the gui beside their own web port', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gui-slot-'))
    const lockFile = join(dir, 'sessions.lock')
    try {
      const a = join(dir, 'a'), b = join(dir, 'b')
      for (const r of [a, b]) { mkdirSync(r); writeFileSync(join(r, 'package.json'), JSON.stringify({ name: basename(r) })) }
      writeFileSync(lockFile, JSON.stringify({ [a]: { env: 'dev', slot: 0 }, [b]: { env: 'dev', slot: 1 } }))
      expect(guiPort(a, { lockFile })).toBe(8500)
      expect(guiPort(b, { lockFile })).toBe(8501)
      // A registered project owns its tens digit and has no slot to add.
      writeFileSync(join(b, 'package.json'), JSON.stringify({ name: 'basecamp' }))
      expect(guiPort(b, { lockFile })).toBe(8520)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
