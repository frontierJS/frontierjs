/*
 * tests/desktop-surface.test.js
 *
 * `core/desktop-surface.js` is the one owner of what a `desktop/` surface is.
 * Nothing in this suite can build a shell — that needs Rust and a webview — so
 * the proof is borrowed: `example/desktop/` is compared to the generator's
 * output byte for byte, and `verify:desktop` builds and runs that directory.
 * A generator change that the example does not take reds here; one the example
 * takes is proved by the drive.
 *
 * The rest is what a unit suite CAN ask: that both shapes pass the rules the
 * app is judged by, and that deploy/build.mjs refuses before it builds.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'

import {
  scaffoldDesktopSurface, desktopScripts, desktopNames, desktopSurfaceDirs,
} from '../core/desktop-surface.js'
import { runChecks } from '../core/checks.js'
import { port, PROJECTS } from '../core/ports.js'

const EXAMPLE = resolve(import.meta.dir, '../../../example')

let ROOT

function appRoot(name, extra = {}) {
  const dir = join(ROOT, name)
  mkdirSync(join(dir, 'db'), { recursive: true })
  writeFileSync(join(dir, 'db', 'schema.lite'), 'model Product { id Int @id  name String  @@gate("0.4.4.5") }\n')
  for (const [path, body] of Object.entries(extra)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  return dir
}

const RULES = ['app-layout', 'surface-config', 'surface-src']
const findings = (root) => RULES.flatMap(id => runChecks({ root, only: [id] }).findings ?? [])

beforeAll(() => { ROOT = mkdtempSync(join(tmpdir(), 'fli-desktop-')) })
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('example/desktop is this generator\'s output', () => {
  test('every file the generator writes, byte for byte', () => {
    const root = appRoot('example')
    const { written } = scaffoldDesktopSurface({
      root, appName: 'example', wraps: 'web',
      apiPort: port('be', { env: 'dev', projectId: PROJECTS.example }),
    })

    // The control: a comparison over nothing passes.
    expect(written.length).toBeGreaterThan(5)
    for (const rel of written) {
      const ours   = readFileSync(join(root, rel))
      const theirs = join(EXAMPLE, rel)
      expect(existsSync(theirs), `${rel} is generated and example/ has none`).toBe(true)
      expect(ours.equals(readFileSync(theirs)), `example/${rel} differs from what make:desktop writes`).toBe(true)
    }
  })
})

describe('the two shapes', () => {
  test('owning its screens: a config, a vite root, routes — and the rules pass', () => {
    const root = appRoot('owns', { 'api/index.ts': '', 'api/src/app.ts': '', 'api/config/default.ts': '' })
    scaffoldDesktopSurface({ root, appName: 'owns' })

    for (const d of desktopSurfaceDirs()) expect(existsSync(join(root, 'desktop', d))).toBe(true)
    for (const f of ['config/sierra.config.js', 'config/vite.config.js', 'index.html', 'src/routes/index.mesa'])
      expect(existsSync(join(root, 'desktop', f))).toBe(true)
    expect(existsSync(join(root, 'desktop', 'dist'))).toBe(false)
    expect(findings(root)).toEqual([])
  })

  test('wrapping: no src/, no screens config, and the rules still pass', () => {
    const root = appRoot('wraps')
    scaffoldDesktopSurface({ root, appName: 'wraps', wraps: 'web' })

    expect(existsSync(join(root, 'desktop', 'src'))).toBe(false)
    expect(existsSync(join(root, 'desktop', 'config', 'vite.config.js'))).toBe(false)
    expect(readFileSync(join(root, 'desktop', 'config', 'desktop.config.js'), 'utf8')).toContain("wraps: 'web'")
    expect(findings(root)).toEqual([])
  })

  test('a config file at the surface root is reported, as for every other surface', () => {
    const root = appRoot('stray', { 'desktop/src/main.js': '', 'desktop/desktop.config.js': '' })
    const out  = runChecks({ root, only: ['surface-config'] }).findings
    expect(out.map(f => f.message).join('\n')).toMatch(/desktop\/desktop\.config\.js sits at the surface root/)
  })

  test('with no API: api is null, and neither the client nor a proxy is written', () => {
    const root = appRoot('noapi')
    scaffoldDesktopSurface({ root, appName: 'noapi', hasApi: false })
    const read = f => readFileSync(join(root, 'desktop', 'config', f), 'utf8')

    expect(read('desktop.config.js')).toMatch(/api: null,/)
    expect(read('sierra.config.js')).not.toContain('junction')
    expect(read('vite.config.js')).not.toContain('proxy')
  })

  test('a scaffold never overwrites', () => {
    const root = appRoot('keep', { 'desktop/shell/Cargo.toml': 'mine\n' })
    const { skipped } = scaffoldDesktopSurface({ root, appName: 'keep' })
    expect(skipped).toContain('desktop/shell/Cargo.toml')
    expect(readFileSync(join(root, 'desktop', 'shell', 'Cargo.toml'), 'utf8')).toBe('mine\n')
  })

  test('every generated script parses', () => {
    const root = appRoot('parse')
    scaffoldDesktopSurface({ root, appName: 'parse' })
    for (const f of ['deploy/build.mjs', 'config/vite.config.js', 'config/sierra.config.js', 'config/desktop.config.js', 'src/main.js']) {
      const r = spawnSync('node', ['--check', join(root, 'desktop', f)], { encoding: 'utf8' })
      expect(r.status, `${f}: ${r.stderr}`).toBe(0)
    }
    expect(() => JSON.parse(readFileSync(join(root, 'desktop', 'shell', 'tauri.conf.json'), 'utf8'))).not.toThrow()
  })
})

describe('names, scripts and ports', () => {
  test('the crate, the product and the identifier come from the app\'s name', () => {
    expect(desktopNames('@acme/My Shop')).toEqual({
      slug: 'my-shop', crate: 'my-shop-desktop', productName: 'My Shop', identifier: 'dev.my-shop.desktop',
    })
  })

  test('a wrapped surface has no dev server of its own', () => {
    expect(Object.keys(desktopScripts({ wraps: 'web' }))).toEqual(['build:desktop'])
    expect(Object.keys(desktopScripts())).toEqual(['dev:desktop', 'build:desktop'])
  })

  test('desktopDev is its own category, never the SPA\'s row', () => {
    expect(port('desktopDev', { env: 'dev', projectId: PROJECTS.scaffold })).toBe(8800)
    expect(port('desktopDev', { env: 'dev', projectId: PROJECTS.example })).toBe(8810)
    expect(port('desktopDev', { env: 'dev', projectId: 1 })).not.toBe(port('fe', { env: 'dev', projectId: 1 }))
  })
})

describe('deploy/build.mjs refuses before it builds', () => {
  const build = (root) => spawnSync('bun', [join(root, 'desktop', 'deploy', 'build.mjs')], {
    cwd: root, encoding: 'utf8', env: { ...process.env, VITE_API_URL: '' },
  })

  test('wrapping a surface that has no vite config', () => {
    const root = appRoot('b-wraps')
    scaffoldDesktopSurface({ root, appName: 'b-wraps', wraps: 'web' })
    const r = build(root)
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/refused — wraps: 'web' has no config\/vite\.config\.js/)
  })

  test('a config that names no api — paired with the same config naming null', () => {
    const root = appRoot('b-noapi')
    scaffoldDesktopSurface({ root, appName: 'b-noapi', hasApi: false })
    const cfg = join(root, 'desktop', 'config', 'desktop.config.js')

    // null gets past the refusal and on to the build, which fails here for
    // want of an installed vite — a different failure, and not a refusal.
    const withNull = build(root)
    expect(withNull.stderr).not.toMatch(/refused/)

    writeFileSync(cfg, 'export default {}\n')
    const without = build(root)
    expect(without.status).toBe(1)
    expect(without.stderr).toMatch(/refused — desktop\.config\.js names no api/)
  })
})
