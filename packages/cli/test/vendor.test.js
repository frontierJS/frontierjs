// ─── vendor.test.js — the build context a Dockerfile installs from ───────────
//
// What is being asserted is FJS-241: an app depending on the framework by
// `link:` or `workspace:` could not be containerized at all, because neither
// spec resolves inside a Docker build. The fix packs those packages into the
// app's own build context, so the tests build a real miniature workspace and run
// a real `bun pm pack` over it — a fake packer would agree with anything.

import { describe, test, expect, beforeEach, afterEach,
         beforeAll, afterAll }                            from 'bun:test'
import { spawnSync }                                     from 'child_process'
import { resolve, dirname, join }                        from 'path'
import { fileURLToPath }                                 from 'url'
import { tmpdir }                                        from 'os'
import { writeFileSync, readFileSync, existsSync,
         readdirSync, rmSync, mkdirSync, mkdtempSync, symlinkSync }    from 'fs'

import { writeBasecamp }                                    from '../core/basecamps.js'
import { vendorWorkspacePackages, linkedDeps, packPackage, withCheckout, keepRunRecord,
         gradeAtCommit, pendingRetry, RETRY_FILE,
         resolvePackageSource, GENERATED_DIR }              from '../core/vendor.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const ROOT  = resolve(__dir, '..')

let TMP

beforeEach(() => {
  TMP = resolve(ROOT, `.tmp-vendor-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(TMP, { recursive: true })
})
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

// A workspace with two publishable packages and one private one, plus an app
// under packages/ that depends on both publishable ones.
function makeWorkspace({ appSpec = 'workspace:*' } = {}) {
  writeJson(join(TMP, 'package.json'), { name: 'ws', private: true, workspaces: ['packages/*'] })

  for (const name of ['alpha', 'beta']) {
    writeJson(join(TMP, 'packages', name, 'package.json'), {
      name: `@fixture/${name}`, version: '1.0.0', type: 'module', main: 'index.js',
    })
    writeFileSync(join(TMP, 'packages', name, 'index.js'), `export const ${name} = true\n`)
  }
  writeJson(join(TMP, 'packages', 'private-one', 'package.json'), {
    name: '@fixture/private-one', version: '1.0.0', private: true,
  })

  const app = join(TMP, 'packages', 'app')
  writeJson(join(app, 'package.json'), {
    name: 'the-app', version: '0.1.0', private: true,
    scripts: { start: 'bun run api/index.ts', dev: 'nope' },
    dependencies:    { '@fixture/alpha': appSpec, 'left-pad': '^1.0.0' },
    devDependencies: { '@fixture/beta': appSpec },
  })
  return app
}

// ─── packPackage ──────────────────────────────────────────────────────────────

describe('packPackage', () => {
  // `ws:publish` publishes the file this returns, so a wrong file here ships a
  // sibling's tarball under this package's version.
  test('returns the tarball it just packed, not a prefix sibling already there', () => {
    makeWorkspace()
    const dest = join(TMP, 'packed')
    writeJson(join(TMP, 'packages', 'alpha-kit', 'package.json'), {
      name: '@fixture/alpha-kit', version: '2.0.0', type: 'module', main: 'index.js',
    })
    writeFileSync(join(TMP, 'packages', 'alpha-kit', 'index.js'), 'export const kit = true\n')
    packPackage({ name: '@fixture/alpha-kit', dir: join(TMP, 'packages', 'alpha-kit'), destination: dest })
    const { file, path } = packPackage({ name: '@fixture/alpha', dir: join(TMP, 'packages', 'alpha'), destination: dest })
    expect(file).toBe('fixture-alpha-1.0.0.tgz')
    expect(existsSync(path)).toBe(true)
  })

  test('a package that does not pack is named', () => {
    expect(() => packPackage({ name: '@fixture/nope', dir: join(TMP, 'nowhere'), destination: join(TMP, 'packed') }))
      .toThrow(/bun pm pack failed for @fixture\/nope/)
  })
})

// ─── linkedDeps ───────────────────────────────────────────────────────────────

describe('linkedDeps', () => {
  test('finds link: and workspace: across both dependency fields', () => {
    const found = linkedDeps({
      dependencies:    { a: 'link:a', b: '^1.0.0', c: 'workspace:*' },
      devDependencies: { d: 'link:d', e: 'latest' },
    })
    expect(found.sort()).toEqual(['a', 'c', 'd'])
  })

  test('a registry-only manifest has nothing linked', () => {
    expect(linkedDeps({ dependencies: { a: '^1.0.0' } })).toEqual([])
  })

  // A tarball the app manages itself is not this module's business.
  test('a file: spec outside the generated directory is left alone', () => {
    expect(linkedDeps({ dependencies: { a: 'file:./vendor/a.tgz' } })).toEqual([])
  })

  // But one INSIDE it is output this module wrote, and the directory is wiped on
  // every run — so an app whose package.json has been replaced by the generated
  // one (which is what installing what the image installs produces) must repack
  // rather than be left naming a tarball that is about to stop existing.
  test('a file: spec into the generated directory is repacked', () => {
    expect(linkedDeps({ dependencies: { a: 'file:./deploy/generated/vendor/a-1.0.0.tgz' } })).toEqual(['a'])
  })
})

// ─── nothing to vendor ────────────────────────────────────────────────────────

describe('an app installing from a registry', () => {
  test('still gets a manifest and its lockfile, so one Dockerfile serves both', () => {
    writeJson(join(TMP, 'package.json'), {
      name: 'npm-app', dependencies: { '@frontierjs/junction': '^0.1.0' },
    })
    writeFileSync(join(TMP, 'bun.lock'), '{ "lockfileVersion": 1 }\n')

    const result = vendorWorkspacePackages({ appRoot: TMP })

    expect(result.vendored).toEqual([])
    expect(result.lockfile).toBe('bun.lock')
    expect(existsSync(join(TMP, GENERATED_DIR, 'bun.lock'))).toBe(true)

    const written = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    expect(written.dependencies['@frontierjs/junction']).toBe('^0.1.0')
    expect(written.overrides).toBeUndefined()
  })

  // The freeze in the Dockerfile is conditional on the lockfile being there, so
  // an app with no lock must not get one invented for it.
  test('no lockfile means none is copied', () => {
    writeJson(join(TMP, 'package.json'), { name: 'npm-app', dependencies: { x: '^1.0.0' } })
    const result = vendorWorkspacePackages({ appRoot: TMP })
    expect(result.lockfile).toBe(null)
    expect(readdirSync(join(TMP, GENERATED_DIR)).sort()).toEqual(['app-manifest.json', 'vendor'])
  })
})

// ─── the whole point ──────────────────────────────────────────────────────────

describe('an app depending on workspace sources', () => {
  test('every linked spec is rewritten to a tarball that is really there', () => {
    const app    = makeWorkspace()
    const result = vendorWorkspacePackages({ appRoot: app })

    expect(result.vendored.sort()).toEqual(['@fixture/alpha', '@fixture/beta'])

    const written = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    for (const [field, name] of [['dependencies', '@fixture/alpha'], ['devDependencies', '@fixture/beta']]) {
      const spec = written[field][name]
      expect(spec).toStartWith(`file:./${GENERATED_DIR}/`)
      expect(existsSync(join(app, spec.slice('file:./'.length)))).toBe(true)
    }
  })

  test('a registry dependency is left alone', () => {
    const app     = makeWorkspace()
    const result  = vendorWorkspacePackages({ appRoot: app })
    const written = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    expect(written.dependencies['left-pad']).toBe('^1.0.0')
  })

  // Without overrides the packages resolve each other from the registry and the
  // image runs two trees at once, which is not guaranteed to fail.
  test('overrides cover every packed package, not only the depended-on ones', () => {
    const app     = makeWorkspace()
    const written = JSON.parse(readFileSync(
      vendorWorkspacePackages({ appRoot: app }).manifestPath, 'utf8'))
    expect(Object.keys(written.overrides).sort()).toEqual(['@fixture/alpha', '@fixture/beta'])
  })

  test('a private workspace package is not packed', () => {
    const app    = makeWorkspace()
    const result = vendorWorkspacePackages({ appRoot: app })
    expect(result.packed).not.toContain('@fixture/private-one')
  })

  // site-kit is private until its first release and basecamp links it: left
  // unpacked, its workspace:* spec reached the image and bun install refused.
  test('a private package the app links is packed', () => {
    const app = makeWorkspace()
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
    manifest.dependencies['@fixture/private-one'] = 'workspace:*'
    writeJson(join(app, 'package.json'), manifest)
    const result = vendorWorkspacePackages({ appRoot: app })
    expect(result.vendored).toContain('@fixture/private-one')
    const written = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    expect(written.dependencies['@fixture/private-one']).toStartWith('file:./')
  })

  test('a linked name with no package behind it is refused', () => {
    const app = makeWorkspace()
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'))
    manifest.dependencies['@fixture/missing'] = 'workspace:*'
    writeJson(join(app, 'package.json'), manifest)
    expect(() => vendorWorkspacePackages({ appRoot: app })).toThrow('@fixture/missing')
  })

  test('link: resolves the same way workspace: does', () => {
    const app    = makeWorkspace({ appSpec: 'link:@fixture/alpha' })
    const result = vendorWorkspacePackages({ appRoot: app })
    expect(result.vendored).toContain('@fixture/alpha')
  })

  // The scaffold CI phase installs the generated manifest as the app's own, so
  // the second run sees a manifest that names tarballs it is about to delete.
  test('an already-vendored manifest repacks rather than dangling', () => {
    const app = makeWorkspace()
    const first = vendorWorkspacePackages({ appRoot: app })
    writeFileSync(join(app, 'package.json'), readFileSync(first.manifestPath, 'utf8'))

    const second = vendorWorkspacePackages({ appRoot: app })
    expect(second.vendored.sort()).toEqual(['@fixture/alpha', '@fixture/beta'])

    const written = JSON.parse(readFileSync(second.manifestPath, 'utf8'))
    const spec = written.dependencies['@fixture/alpha']
    expect(existsSync(join(app, spec.slice('file:./'.length)))).toBe(true)
  })

  // A caller that already knows where the sources are does not have to be found
  // out — CI's app sits under no workspace and is not installed yet.
  test('a stated packagesDir wins over resolution', () => {
    const app = makeWorkspace()
    const result = vendorWorkspacePackages({
      appRoot: app, include: ['@fixture/alpha'], packagesDir: join(TMP, 'packages'),
    })
    expect(result.packagesDir).toBe(join(TMP, 'packages'))
    expect(result.vendored).toContain('@fixture/alpha')
  })

  // `include` is what lets a caller decide the tree wins over a manifest whose
  // specs resolve perfectly well from a registry.
  test('include vendors a dependency whose spec is an ordinary range', () => {
    writeJson(join(TMP, 'package.json'), { name: 'ws', private: true, workspaces: ['packages/*'] })
    writeJson(join(TMP, 'packages', 'alpha', 'package.json'), {
      name: '@fixture/alpha', version: '1.0.0', main: 'index.js',
    })
    writeFileSync(join(TMP, 'packages', 'alpha', 'index.js'), 'export const alpha = true\n')

    const app = join(TMP, 'packages', 'app')
    writeJson(join(app, 'package.json'), {
      name: 'the-app', dependencies: { '@fixture/alpha': '^1.0.0' },
    })

    const result  = vendorWorkspacePackages({ appRoot: app, include: ['@fixture/alpha'] })
    const written = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    expect(written.dependencies['@fixture/alpha']).toStartWith('file:')
  })

  test('transform sees the rewritten manifest', () => {
    const app = makeWorkspace()
    const result = vendorWorkspacePackages({
      appRoot: app,
      transform: (m) => { m.scripts = { start: m.scripts.start }; return m },
    })
    const written = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
    expect(Object.keys(written.scripts)).toEqual(['start'])
    expect(written.dependencies['@fixture/alpha']).toStartWith('file:')
  })

  // A stale tarball is a spec nothing points at and megabytes in every layer
  // after it — and, worse, a name that still resolves after the package it came
  // from was removed.
  test('a previous run leaves nothing behind', () => {
    const app = makeWorkspace()
    mkdirSync(join(app, GENERATED_DIR, 'vendor'), { recursive: true })
    writeFileSync(join(app, GENERATED_DIR, 'vendor', 'fixture-gone-9.9.9.tgz'), 'stale')

    vendorWorkspacePackages({ appRoot: app })
    expect(readdirSync(join(app, GENERATED_DIR, 'vendor'))).not.toContain('fixture-gone-9.9.9.tgz')
  })

  // Half a build context installs the rest from the registry and produces an
  // image running two trees, so this refuses rather than degrading.
  test('sources that cannot be found are a named failure', () => {
    writeJson(join(TMP, 'package.json'), {
      name: 'orphan', dependencies: { '@nowhere/thing': 'link:@nowhere/thing' },
    })
    expect(() => vendorWorkspacePackages({ appRoot: TMP })).toThrow(/@nowhere\/thing/)
  })
})

// ─── resolvePackageSource ──────────────────────────────────────────────────────

describe('resolvePackageSource', () => {
  test('finds the workspace an app is standing in', () => {
    const app = makeWorkspace()
    expect(resolvePackageSource(app, ['@fixture/alpha']).dir).toBe(join(TMP, 'packages'))
  })

  // A directory called `packages` is not evidence that it holds THESE packages;
  // accepting the first one that exists is how a build packs another monorepo.
  test('a packages dir without the names is not the answer', () => {
    mkdirSync(join(TMP, 'elsewhere'), { recursive: true })
    writeJson(join(TMP, 'elsewhere', 'package.json'), { name: 'x', workspaces: ['packages/*'] })
    mkdirSync(join(TMP, 'elsewhere', 'packages'), { recursive: true })
    expect(resolvePackageSource(join(TMP, 'elsewhere'), ['@fixture/alpha'])).toBe(null)
  })

  test('$FJS_PACKAGES_DIR is consulted when nothing is walked up to', () => {
    makeWorkspace()
    // Outside the repo entirely — a directory under packages/ would be walked up
    // from into this workspace, which is the case the previous test covers.
    const outside = join(tmpdir(), `fli-vendor-app-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(outside, { recursive: true })
    const before = process.env.FJS_PACKAGES_DIR
    process.env.FJS_PACKAGES_DIR = join(TMP, 'packages')
    try {
      expect(resolvePackageSource(outside, ['@fixture/alpha']).dir).toBe(join(TMP, 'packages'))
    } finally {
      if (before === undefined) delete process.env.FJS_PACKAGES_DIR
      else process.env.FJS_PACKAGES_DIR = before
      rmSync(outside, { recursive: true, force: true })
    }
  })

  // FJS-D1559: a dependency is packed from whichever member directory holds it.
  test('a member two levels down is found through the root workspaces list', () => {
    const app = makeWorkspace()
    writeJson(join(TMP, 'package.json'), { name: 'ws', private: true, workspaces: ['packages/*', 'packages/group/*'] })
    writeJson(join(TMP, 'packages', 'group', 'deep', 'package.json'), {
      name: '@fixture/deep', version: '1.0.0', type: 'module', main: 'index.js',
    })
    writeFileSync(join(TMP, 'packages', 'group', 'deep', 'index.js'), 'export const deep = true\n')

    const source = resolvePackageSource(app, ['@fixture/deep'])
    expect(source.packages.find(p => p.name === '@fixture/deep').dir).toBe(join(TMP, 'packages', 'group', 'deep'))

    const result = vendorWorkspacePackages({ appRoot: app, include: ['@fixture/deep'] })
    expect(result.packed).toContain('@fixture/deep')
    expect(readdirSync(join(app, GENERATED_DIR, 'vendor'))).toContain('fixture-deep-1.0.0.tgz')
  })

  test('a nested member behind a bun link is found from the root above it', () => {
    makeWorkspace()
    writeJson(join(TMP, 'package.json'), { name: 'ws', private: true, workspaces: ['packages/*', 'packages/group/*'] })
    writeJson(join(TMP, 'packages', 'group', 'deep', 'package.json'), { name: '@fixture/deep', version: '1.0.0' })
    const outside = join(tmpdir(), `fli-vendor-link-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    mkdirSync(join(outside, 'node_modules', '@fixture'), { recursive: true })
    symlinkSync(join(TMP, 'packages', 'group', 'deep'), join(outside, 'node_modules', '@fixture', 'deep'))
    try {
      const source = resolvePackageSource(outside, ['@fixture/deep'])
      expect(source.dir).toBe(join(TMP, 'packages'))
      expect(source.packages.map(p => p.name)).toContain('@fixture/alpha')
    } finally { rmSync(outside, { recursive: true, force: true }) }
  })
})

// ─── basecamp:deploy --dry: vendoring is the Dockerfile's word (FJS-D1560) ──
//
// The laptop release runs the Outpost's own lookup and vendors deploy/generated/
// only when the file it chose installs from it, so a plain repository with no
// package.json builds as it is; a tree with uncommitted changes is warned and
// left out of the release (FJS-D1968). Driven as a process against a stub Basecamp answering one
// git App on one online server, because the choice is made inside the command.
describe('basecamp:deploy --dry on a plain repository', () => {
  let stub, stored = null, repo, containerPort = 8080, patches = []

  const app = () => ({
    id: 'app-1', name: 'plain', slug: 'plain', environmentId: 'e1', port: 8080, containerPort,
    source: { kind: 'git', repo: 'https://git.example.test/acme/plain.git', branch: 'main', ...(stored ? { dockerfile: stored } : {}) },
    placement: [{ serverId: 's1', server: { id: 's1', name: 'dev', status: 'online', ipAddress: '127.0.0.1', sshUser: 'deploy' } }],
  })

  beforeAll(() => {
    stub = Bun.serve({ port: 0, async fetch(req) {
      const u = new URL(req.url)
      // Refused after it is recorded, so a run stops before docker builds anything.
      if (u.pathname === '/apps/app-1' && req.method === 'PATCH') {
        patches.push(await req.json())
        return Response.json({ message: 'stub refuses the write' }, { status: 403 })
      }
      if (u.pathname === '/apps/app-1') return Response.json(app())
      if (u.pathname === '/apps' || u.pathname === '/variables') return Response.json([])
      return new Response('not found', { status: 404 })
    } })
  })
  afterAll(() => stub.stop())
  afterEach(() => { if (repo) rmSync(repo, { recursive: true, force: true }); repo = null })

  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], { cwd: repo, encoding: 'utf8' })

  /** A repository holding only a Dockerfile and what it copies, one commit in.
   *  Outside this tree: fli takes the nearest frontier.config.js above as the
   *  project root, and under packages/cli that is the workspace's own. */
  const plainRepo = () => {
    repo = mkdtempSync(join(tmpdir(), 'fjs-plain-'))
    mkdirSync(join(repo, 'www'), { recursive: true })
    writeFileSync(join(repo, 'Dockerfile'), 'FROM busybox:1.36\nCOPY www /www\nEXPOSE 3000\n')
    writeFileSync(join(repo, 'www', 'index.html'), '<p>hi</p>\n')
    git('init', '-q', '-b', 'main'); git('add', '.'); git('commit', '-q', '-m', 'v1')
  }

  // Spawned asynchronously: a spawnSync would block the loop the stub answers on.
  const dry = async ({ run = false } = {}) => {
    // The origin and key are the entry in basecamps.json under HOME, not the environment.
    const home = mkdtempSync(join(tmpdir(), 'fjs-home-'))
    writeBasecamp('stub', { url: `http://localhost:${stub.port}`, apiKey: 'x' }, { home })
    const proc = Bun.spawn([process.execPath, resolve(ROOT, 'bin/fli.js'), 'basecamp:deploy', ...(run ? [] : ['--dry']), '--app', 'app-1'], {
      cwd: repo, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      env: { ...process.env, HOME: home, NO_COLOR: '1' },
    })
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    rmSync(home, { recursive: true, force: true })
    return (out + err).replace(/\x1b\[[0-9;]*m/g, '')
  }

  test('its own root Dockerfile builds with nothing vendored, and a stored copy as Dockerfile.basecamp', async () => {
    plainRepo()
    const own = await dry()
    expect(own).toContain('from Dockerfile, which installs from the repository')
    expect(own).toContain('Would load')
    expect(own).not.toContain('Would vendor')
    expect(own).not.toContain('dirty')

    stored = 'FROM busybox:1.36\nCOPY www /www\n'
    expect(await dry()).toContain('from Dockerfile.basecamp, which installs from the repository')
    expect(existsSync(join(repo, 'Dockerfile.basecamp'))).toBe(false)

    stored = 'FROM oven/bun\nCOPY deploy/generated/ ./deploy/generated/\n'
    expect(await dry()).toContain('Would vendor deploy/generated/')
    stored = null
  }, 90_000)

  test('a tree with uncommitted changes is told so, and the tag is the plain commit', async () => {
    plainRepo()
    writeFileSync(join(repo, 'www', 'scratch.txt'), 'x\n')
    const out = await dry()
    expect(out).toContain('uncommitted change(s)')
    expect(out).toContain('are not shipped')
    expect(out).toMatch(/Would build fjs-app-1:[0-9a-f]{12} from/)
    expect(out).not.toContain('-dirty')
  }, 60_000)

  // FJS-4047: a release naming a digest builds nothing on the machine, so the
  // Outpost's /build never reads the file, and an App storing no container
  // port was started with the host port mapped to itself (FJS-D1567).
  test('an App storing no container port takes its Dockerfile EXPOSE before the release', async () => {
    plainRepo()
    containerPort = null
    patches = []
    try {
      expect(await dry()).toContain("Would set App 'plain' container port to 3000")
      expect(patches).toEqual([])

      const out = await dry({ run: true })
      expect(patches).toEqual([{ containerPort: 3000 }])
      expect(out).not.toContain('Building fjs-app-1')
    } finally { containerPort = 8080 }
  }, 60_000)

  test('an App stating another container port keeps it, and the run says where the two differ', async () => {
    plainRepo()
    patches = []
    const out = await dry()
    expect(out).toContain('EXPOSE 3000 where the App says 8080')
    expect(patches).toEqual([])
  }, 60_000)
})

describe('withCheckout', () => {
  // The CI gate and the pack both read a commit, not the tree: a file edited
  // after the commit must not reach `fn`, and the checkout must not outlive it.
  test('hands fn the committed bytes and removes the checkout, even when fn throws', () => {
    const repo = mkdtempSync(join(tmpdir(), 'checkout-'))
    const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' })
    git('init', '-q'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'a')
    writeFileSync(join(repo, 'package.json'), '{"name":"x","version":"1.0.0"}')
    git('add', '.'); git('commit', '-qm', 'one')
    const sha = git('rev-parse', 'HEAD').stdout.trim()
    writeFileSync(join(repo, 'package.json'), '{"name":"x","version":"2.0.0"}')
    const scratch = mkdtempSync(join(tmpdir(), 'checkout-scratch-'))
    let seen
    const out = withCheckout({ repo, sha, scratch }, tree => { seen = tree; return JSON.parse(readFileSync(join(tree, 'package.json'), 'utf8')).version })
    expect(out).toBe('1.0.0')
    expect(existsSync(seen)).toBe(false)
    expect(() => withCheckout({ repo, sha, scratch }, () => { throw new Error('red') })).toThrow('red')
    expect(git('worktree', 'list').stdout.trim().split('\n')).toHaveLength(1)
    rmSync(repo, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true })
  })
})

describe('gradeAtCommit', () => {
  // A stand-in ci.mjs over the real run log: it fails each suite red.json names,
  // and records every argv it was run with outside the checkout.
  const stubCi = (calls) => `
import { openRunLog } from ${JSON.stringify(join(ROOT, 'core', 'ci-log.js'))}
import { readFileSync, appendFileSync } from 'node:fs'
const argv = process.argv.slice(2)
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + '\\n')
const red = JSON.parse(readFileSync('red.json', 'utf8'))
const log = openRunLog(process.cwd(), { commit: 'x', dirty: false, argv, scope: argv.length ? 'partial' : 'full', only: null, phases: ['tests'] })
log.emit('phase', { name: 'tests' })
for (const key of red) log.emit('step', { phase: 'tests', status: 'fail', label: key, key })
log.emit('phase-end', { name: 'tests', ms: 1, ok: !red.length })
log.emit('end', { ok: !red.length, ms: 1 })
process.exit(red.length ? 1 : 0)
`

  test('a retry reruns what failed first, stops while it is red, and runs the full gate once it is green', () => {
    const repo    = mkdtempSync(join(tmpdir(), 'grade-'))
    const scratch = mkdtempSync(join(tmpdir(), 'grade-scratch-'))
    const calls   = join(scratch, 'calls.jsonl')
    const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' })
    const commit = (red) => {
      writeFileSync(join(repo, 'red.json'), JSON.stringify(red))
      git('add', '.'); git('commit', '-qm', JSON.stringify(red))
      return git('rev-parse', 'HEAD').stdout.trim()
    }
    const ran = () => {
      const lines = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').map(l => JSON.parse(l)) : []
      rmSync(calls, { force: true })
      return lines
    }
    git('init', '-q'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'a')
    mkdirSync(join(repo, 'scripts'))
    writeFileSync(join(repo, 'scripts', 'ci.mjs'), stubCi(calls))
    writeFileSync(join(repo, 'package.json'), '{"name":"x","version":"1.0.0"}')
    writeFileSync(join(repo, '.gitignore'), '.cache/\n')
    const plan = [['--phase', 'tests', '--only', 'packages/a']]

    const first = commit(['packages/a'])
    expect(gradeAtCommit({ repo, sha: first, scratch })).toMatchObject({ status: 1, stillRed: false, retry: null })
    expect(ran()).toEqual([[]])
    expect(JSON.parse(readFileSync(join(repo, RETRY_FILE), 'utf8'))).toEqual({ sha: first, plan })

    const second = commit(['packages/a'])
    const red = gradeAtCommit({ repo, sha: second, scratch })
    expect(red).toMatchObject({ status: 1, stillRed: true })
    expect(ran()).toEqual(plan)
    // Still red keeps the plan where the full run left it.
    expect(JSON.parse(readFileSync(join(repo, RETRY_FILE), 'utf8'))).toEqual({ sha: first, plan })

    const third = commit([])
    expect(gradeAtCommit({ repo, sha: third, scratch })).toMatchObject({ status: 0, stillRed: false })
    expect(ran()).toEqual([...plan, []])
    expect(existsSync(join(repo, RETRY_FILE))).toBe(false)
    expect(git('worktree', 'list').stdout.trim().split('\n')).toHaveLength(1)
    rmSync(repo, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true })
  })

  test('a plan from another line of history is not this sha\'s', () => {
    const repo = mkdtempSync(join(tmpdir(), 'grade-lines-'))
    const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' })
    git('init', '-q'); git('config', 'user.email', 'a@b.c'); git('config', 'user.name', 'a')
    git('commit', '-q', '--allow-empty', '-m', 'one')
    const one = git('rev-parse', 'HEAD').stdout.trim()
    git('checkout', '-q', '--orphan', 'other'); git('commit', '-q', '--allow-empty', '-m', 'two')
    const two = git('rev-parse', 'HEAD').stdout.trim()
    mkdirSync(join(repo, '.cache'))
    writeFileSync(join(repo, RETRY_FILE), JSON.stringify({ sha: one, plan: [['--phase', 'tests']] }))
    expect(pendingRetry(repo, one)?.sha).toBe(one)
    expect(pendingRetry(repo, two)).toBeNull()
    rmSync(repo, { recursive: true, force: true })
  })
})

describe('keepRunRecord', () => {
  // FJS-3934: a release CI run writes its summary into the throwaway checkout,
  // and the checkout is removed -- the failure's detail went with it while the
  // line it printed named .cache/ci-last.txt, the working tree's previous run.
  test('copies the run log and the checkout\'s ci-last.txt beside, never over, the working tree\'s', () => {
    const tree = mkdtempSync(join(tmpdir(), 'keep-tree-'))
    const cwd  = mkdtempSync(join(tmpdir(), 'keep-cwd-'))
    mkdirSync(join(tree, '.cache', 'ci-runs'), { recursive: true })
    writeFileSync(join(tree, '.cache', 'ci-runs', 'r1.jsonl'), '{}')
    writeFileSync(join(tree, '.cache', 'ci-last.txt'), 'expect(received).toBe(expected)')
    mkdirSync(join(cwd, '.cache'), { recursive: true })
    writeFileSync(join(cwd, '.cache', 'ci-last.txt'), 'the previous green run')
    const kept = keepRunRecord(tree, cwd)
    expect(readFileSync(join(cwd, '.cache', 'ci-last.txt'), 'utf8')).toBe('the previous green run')
    expect(readFileSync(kept, 'utf8')).toContain('expect(received)')
    expect(readFileSync(join(cwd, '.cache', 'ci-runs', 'r1.jsonl'), 'utf8')).toBe('{}')
    expect(keepRunRecord(mkdtempSync(join(tmpdir(), 'keep-empty-')), cwd)).toBeNull()
    // A release retry's narrowed first pass writes ci-last-partial.txt instead.
    writeFileSync(join(tree, '.cache', 'ci-last-partial.txt'), 'still red')
    expect(readFileSync(keepRunRecord(tree, cwd, { summary: 'ci-last-partial.txt' }), 'utf8')).toBe('still red')
    rmSync(tree, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true })
  })
})
