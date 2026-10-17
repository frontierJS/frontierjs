// test/app-root.test.ts — where an app's files are: one root, every folder
// derived from it (`FJS-D1080`).
//
// Four keys used to say it — `autoload`, caravan's `jobsDir`, notifications'
// `notifications`, `configPath` — each defaulting to a probe from `Bun.main`
// or the working directory, and under a drive or a test runner both name the
// RUNNER, so every app stated all four with `import.meta.url` (`FJS-2939`).
// `createApp({ root: import.meta.url })` is the one statement: `services/`,
// `routes/`, `jobs/`, `notifications/` beside it, `../config` above it.

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveAppRoot, resolveServicesDir, describeServicesDir, configDirOf } from '../src/core/app-root.ts'
import { createApp } from '../src/core/app.ts'

const JUNCTION = resolve(import.meta.dir, '..')

const roots: string[] = []
function layout(dirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'fjs-root-'))
  roots.push(root)
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true })
  return root
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

describe('resolveAppRoot', () => {
  test('a module URL names the directory it sits in', () => {
    const root = layout(['api/src'])
    writeFileSync(join(root, 'api/src/app.ts'), '')
    expect(resolveAppRoot(pathToFileURL(join(root, 'api/src/app.ts')).href)).toBe(join(root, 'api/src'))
    expect(resolveAppRoot(pathToFileURL(join(root, 'api/src/app.ts')))).toBe(join(root, 'api/src'))
  })

  test('a directory path is the root itself', () => {
    const root = layout(['api/src'])
    expect(resolveAppRoot(join(root, 'api/src'))).toBe(join(root, 'api/src'))
  })

  test('none stated is none — nothing is probed from the runner', () => {
    expect(resolveAppRoot(undefined)).toBeNull()
  })

  // A root that is not there is a statement that failed; booting on nothing
  // would read as an app with no services and no config.
  test('a root that does not exist throws naming it', () => {
    expect(() => resolveAppRoot('/definitely/not/here')).toThrow(/\/definitely\/not\/here/)
  })
})

describe('the folders a root derives', () => {
  test('services/ beside the root', () => {
    const root = layout(['services'])
    expect(resolveServicesDir({ root })).toEqual({ dir: join(root, 'services'), source: 'derived', probed: [join(root, 'services')] })
  })

  test('a root with no services/ names the folder it looked for', () => {
    const root = layout([])
    const r = resolveServicesDir({ root })
    expect(r.source).toBe('missing')
    expect(r.dir).toBeNull()
    expect(r.probed).toEqual([join(root, 'services')])
  })

  // A file is not a directory: `Bun.Glob.scan` on one throws, which the loader
  // reports as no services.
  test('a FILE named services is not the folder', () => {
    const root = layout([])
    writeFileSync(join(root, 'services'), '')
    expect(resolveServicesDir({ root }).source).toBe('missing')
  })

  test('no root, nothing looked at', () => {
    expect(resolveServicesDir({ root: null })).toEqual({ dir: null, source: 'none', probed: [] })
  })

  test('the config folder is ../config', () => {
    expect(configDirOf('/app/api/src')).toBe('/app/api/config')
  })
})

describe('describeServicesDir', () => {
  const cwd = '/app'

  test('a derived directory is named relative to the working directory', () => {
    expect(describeServicesDir({ dir: '/app/api/src/services', source: 'derived', probed: [] }, cwd))
      .toBe('api/src/services')
  })

  test('a miss names the folder looked for', () => {
    expect(describeServicesDir({ dir: null, source: 'missing', probed: ['/app/api/src/services'] }, cwd))
      .toBe('none — no api/src/services')
  })

  test('no root says so, rather than blank', () => {
    expect(describeServicesDir({ dir: null, source: 'none', probed: [] }, cwd))
      .toBe('none — no root stated')
  })

  test('a directory above the cwd stays absolute', () => {
    expect(describeServicesDir({ dir: '/elsewhere/services', source: 'derived', probed: [] }, cwd))
      .toBe('/elsewhere/services')
  })
})

// ─── an app under a runner ────────────────────────────────────────────────
//
// In-process, which is the point: `Bun.main` here is this test file and the
// working directory is the package, and neither may decide what loads.

function app(root: string, files: Record<string, string>): string {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), body)
  }
  return root
}

describe('createApp({ root })', () => {
  test('services/ and ../config load from the root under a test runner', async () => {
    const base = layout([])
    app(base, {
      'api/src/services/widgets.service.ts': `
        import { createService } from '${JUNCTION}/src/core/service.ts'
        export default createService({ methods: ['find'], async find() { return [] } })
      `,
      'api/config/junction.config.js': `export default { app: { name: 'rooted' } }`,
    })
    writeFileSync(join(base, 'api/src/app.ts'), '')
    const a = createApp({ root: pathToFileURL(join(base, 'api/src/app.ts')).href, logLevel: 'silent', config: { port: 0 } })
    expect(a.root).toBe(join(base, 'api/src'))
    await a.applyConfigFile()
    await a._startForTest()
    expect(a.services.list()).toContain('widgets')
    expect(a.config.name).toBe('rooted')
    await a.stop()
  })

  test('no root reads nothing from disk', async () => {
    const a = createApp({ logLevel: 'silent', config: { port: 0 } })
    expect(a.root).toBeNull()
    await a._startForTest()
    expect(a.services.list()).toEqual([])
    await a.stop()
  })
})
