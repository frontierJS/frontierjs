// ─── vendor.test.js — the build context a Dockerfile installs from ───────────
//
// What is being asserted is FJS-241: an app depending on the framework by
// `link:` or `workspace:` could not be containerised at all, because neither
// spec resolves inside a Docker build. The fix packs those packages into the
// app's own build context, so the tests build a real miniature workspace and run
// a real `bun pm pack` over it — a fake packer would agree with anything.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { resolve, dirname, join }                        from 'path'
import { fileURLToPath }                                 from 'url'
import { tmpdir }                                        from 'os'
import { writeFileSync, readFileSync, existsSync,
         readdirSync, rmSync, mkdirSync }                 from 'fs'

import { vendorWorkspacePackages, linkedDeps,
         resolvePackagesDir, GENERATED_DIR }              from '../core/vendor.js'

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

// ─── resolvePackagesDir ───────────────────────────────────────────────────────

describe('resolvePackagesDir', () => {
  test('finds the workspace an app is standing in', () => {
    const app = makeWorkspace()
    expect(resolvePackagesDir(app, ['@fixture/alpha'])).toBe(join(TMP, 'packages'))
  })

  // A directory called `packages` is not evidence that it holds THESE packages;
  // accepting the first one that exists is how a build packs another monorepo.
  test('a packages dir without the names is not the answer', () => {
    mkdirSync(join(TMP, 'elsewhere'), { recursive: true })
    writeJson(join(TMP, 'elsewhere', 'package.json'), { name: 'x', workspaces: ['packages/*'] })
    mkdirSync(join(TMP, 'elsewhere', 'packages'), { recursive: true })
    expect(resolvePackagesDir(join(TMP, 'elsewhere'), ['@fixture/alpha'])).toBe(null)
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
      expect(resolvePackagesDir(outside, ['@fixture/alpha'])).toBe(join(TMP, 'packages'))
    } finally {
      if (before === undefined) delete process.env.FJS_PACKAGES_DIR
      else process.env.FJS_PACKAGES_DIR = before
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
