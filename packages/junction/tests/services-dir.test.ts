// tests/services-dir.test.ts — where an app's services are, and what is said
// when they are nowhere.
//
// `FJS-458`. The default resolved `dirname(Bun.main)/services` — the FLAT
// layout, entry and services as siblings. The layout this framework documents
// and scaffolds puts the entry at `api/index.ts` and the services at
// `api/src/services`, so the default named a directory that is not there, and
// a missing directory is a silent no-op: the app boots, /health answers, and
// every route those services would have mounted is a 404. Measured on
// `example`, where the boot line read `services=3` — the three auth registers —
// and the drive's only symptom was one URL that did not answer.
//
// Both layouts are one probe apart. The tests below are the two layouts, the
// four things that can be said about the outcome, and the rule that a DECLARED
// directory is never probed around: a relative path resolved against the wrong
// working directory lands on nothing and looks exactly like an app with no
// services, which is `FJS-449` one realm over.

import { describe, test, expect, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { resolveServicesDir, describeServicesDir } from '../src/core/services-dir.ts'

const roots: string[] = []
function layout(dirs: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'fjs-services-'))
  roots.push(root)
  for (const d of dirs) mkdirSync(join(root, d), { recursive: true })
  return root
}
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }) })

describe('resolveServicesDir', () => {
  test('the flat layout — services beside the entry', () => {
    const root = layout(['api/services'])
    const r = resolveServicesDir({ entry: join(root, 'api/index.ts') })
    expect(r.source).toBe('probed')
    expect(r.dir).toBe(join(root, 'api/services'))
  })

  test('the canonical layout — the entry at api/index.ts, the services under api/src', () => {
    const root = layout(['api/src/services'])
    const r = resolveServicesDir({ entry: join(root, 'api/index.ts') })
    expect(r.source).toBe('probed')
    expect(r.dir).toBe(join(root, 'api/src/services'))
  })

  test('an entry that is already inside src — the first candidate answers', () => {
    const root = layout(['api/src/services'])
    const r = resolveServicesDir({ entry: join(root, 'api/src/app.ts') })
    expect(r.dir).toBe(join(root, 'api/src/services'))
  })

  // Both layouts at once is a mistake, not a merge: the sibling wins because it
  // is the one the entry names most directly, and the probe order is stated
  // rather than left to whichever the filesystem answers first.
  test('both present — the sibling wins, and the loser is still named', () => {
    const root = layout(['api/services', 'api/src/services'])
    const r = resolveServicesDir({ entry: join(root, 'api/index.ts') })
    expect(r.dir).toBe(join(root, 'api/services'))
    expect(r.probed).toEqual([join(root, 'api/services'), join(root, 'api/src/services')])
  })

  test('neither present — nothing to load, and both candidates are named', () => {
    const root = layout(['api'])
    const r = resolveServicesDir({ entry: join(root, 'api/index.ts') })
    expect(r.source).toBe('none')
    expect(r.dir).toBeNull()
    expect(r.probed).toEqual([join(root, 'api/services'), join(root, 'api/src/services')])
  })

  test('a declared directory is used as declared, resolved against the cwd', () => {
    const root = layout(['svc'])
    const r = resolveServicesDir({ entry: join(root, 'api/index.ts'), declared: './svc', cwd: root })
    expect(r.source).toBe('declared')
    expect(r.dir).toBe(join(root, 'svc'))
  })

  // The half that makes the declaration worth making: a path the app STATED
  // and that is not there is reported, never quietly replaced by a probe. The
  // app said where they are; if that is wrong, the wrong thing to do is find
  // some others.
  test('a declared directory that is absent is a miss, not a fallback', () => {
    const root = layout(['api/src/services'])
    const r = resolveServicesDir({ entry: join(root, 'api/index.ts'), declared: './nope', cwd: root })
    expect(r.source).toBe('declared-missing')
    expect(r.dir).toBeNull()
    expect(r.probed).toEqual([join(root, 'nope')])
  })

  test('autoload: false says so and probes nothing', () => {
    const root = layout(['api/services'])
    const r = resolveServicesDir({ entry: join(root, 'api/index.ts'), declared: false })
    expect(r.source).toBe('disabled')
    expect(r.dir).toBeNull()
    expect(r.probed).toEqual([])
  })

  // A file is not a directory. `Bun.Glob.scan` on one throws, which the loader
  // catches and reports as "no services", so without this the app is back to
  // the silence the whole issue is about.
  test('a FILE at a candidate path is not a services directory', () => {
    const root = layout(['api'])
    writeFileSync(join(root, 'api/services'), '')
    const r = resolveServicesDir({ entry: join(root, 'api/index.ts') })
    expect(r.source).toBe('none')
  })

  test('no entry at all — reported rather than resolved against the cwd', () => {
    const r = resolveServicesDir({ entry: null })
    expect(r.source).toBe('none')
    expect(r.probed).toEqual([])
  })
})

// ─── what the boot banner says ────────────────────────────────────────────
//
// The visibility half. `services=3` on an app with twelve reads as an app with
// three; the routes the other nine would have mounted answer 404, which reads
// as a wrong URL. The banner names where they came from, and — the case this
// exists for — what was looked at when none did.

describe('describeServicesDir', () => {
  const cwd = '/app'

  test('a probed directory is named, relative to where the app was started', () => {
    expect(describeServicesDir({ dir: '/app/api/src/services', source: 'probed', probed: [] }, cwd))
      .toBe('api/src/services')
  })

  test('nothing found names every candidate, so the miss is legible', () => {
    const said = describeServicesDir(
      { dir: null, source: 'none', probed: ['/app/api/services', '/app/api/src/services'] }, cwd)
    expect(said).toBe('none — probed api/services, api/src/services')
  })

  test('a declared miss says so in the word a reader scans for', () => {
    const said = describeServicesDir(
      { dir: null, source: 'declared-missing', declared: './nope', probed: ['/app/nope'] }, cwd)
    expect(said).toContain('MISSING')
    expect(said).toContain('./nope')
  })

  test('switched off is stated, not blank', () => {
    expect(describeServicesDir({ dir: null, source: 'disabled', probed: [] }, cwd)).toBe('off')
  })

  // A path outside the working directory is shown whole: `../../../x` is
  // harder to read than the thing it shortens.
  test('a directory above the cwd stays absolute', () => {
    expect(describeServicesDir({ dir: '/elsewhere/services', source: 'probed', probed: [] }, cwd))
      .toBe('/elsewhere/services')
  })
})

// ─── the whole path, in a real process ────────────────────────────────────
//
// The default resolves against `Bun.main`, so it cannot be exercised in-process
// — under `bun test` the entry is this file. A subprocess with a real entry is
// the only way to assert the thing the issue is about: an app laid out the way
// the framework documents, started the way it is started, loading its services
// without being told where they are.

const JUNCTION = resolve(import.meta.dir, '..')

function scaffold(servicesAt: string): string {
  const root = layout([servicesAt, 'api'])
  writeFileSync(join(root, servicesAt, 'widgets.service.ts'), `
    import { createService } from '${JUNCTION}/src/core/service.ts'
    export function createWidgetsService() {
      return createService({ name: 'widgets', methods: ['find'], async find() { return [] } })
    }
  `)
  writeFileSync(join(root, 'api/index.ts'), `
    import { createApp } from '${JUNCTION}/src/core/app.ts'
    const app = createApp({ config: { port: 0, database: { url: '', log: false } } })
    await app._startForTest()
    console.log('SERVICES=' + app.services.list().join(','))
  `)
  return root
}

async function boot(root: string): Promise<string> {
  const proc = Bun.spawn(['bun', 'api/index.ts'], { cwd: root, stdout: 'pipe', stderr: 'pipe' })
  const out = await new Response(proc.stdout).text()
  await proc.exited
  return out
}

describe('an app started the way apps are started', () => {
  test('the canonical layout autoloads with nothing declared', async () => {
    const out = await boot(scaffold('api/src/services'))
    expect(out).toContain('SERVICES=widgets')
  }, 30_000)

  test('the flat layout still does', async () => {
    const out = await boot(scaffold('api/services'))
    expect(out).toContain('SERVICES=widgets')
  }, 30_000)
})
