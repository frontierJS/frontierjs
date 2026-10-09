/*
 * test/desktop-surface.test.js
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
  desktopBinary, desktopApiTarget, desktopLauncher, desktopMainRs,
  ensureServer, surfaceRow,
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

describe('what desktop:run reads', () => {
  test('the binary is named for the crate Cargo.toml declares, not for the app', () => {
    const root = appRoot('run-bin')
    scaffoldDesktopSurface({ root, appName: 'run-bin' })
    const surface = join(root, 'desktop')
    expect(desktopBinary(surface)).toBe(join(surface, 'shell', 'target', 'debug', 'run-bin-desktop'))
    expect(desktopBinary(surface, { release: true, platform: 'win32' }))
      .toBe(join(surface, 'shell', 'target', 'release', 'run-bin-desktop.exe'))

    writeFileSync(join(surface, 'shell', 'Cargo.toml'), '[package]\nname = "renamed"\n')
    expect(desktopBinary(surface)).toBe(join(surface, 'shell', 'target', 'debug', 'renamed'))
  })

  test('no crate is no binary', () => {
    expect(desktopBinary(join(ROOT, 'nowhere', 'desktop'))).toBeNull()
  })

  test('only a loopback api is this machine\'s to start', () => {
    expect(desktopApiTarget('http://localhost:8120')).toEqual({ origin: 'http://localhost:8120', port: 8120, local: true })
    expect(desktopApiTarget('http://127.0.0.1:7120/')).toMatchObject({ port: 7120, local: true })
    expect(desktopApiTarget('https://api.example.com')).toEqual({ origin: 'https://api.example.com', port: 443, local: false })
    expect(desktopApiTarget(null)).toBeNull()
  })
})

describe('what dev:desktop reads', () => {
  test('the shell reads FJS_DESKTOP_URL only behind the debug guard', () => {
    const fn = desktopMainRs().match(/fn dev_url\(\)[\s\S]*?\n}\n/)?.[0] ?? ''
    const guard = fn.indexOf('if !cfg!(debug_assertions)')
    expect(guard).toBeGreaterThan(-1)
    expect(fn.indexOf('FJS_DESKTOP_URL')).toBeGreaterThan(guard)
  })

  test('the screens\' dev server is the wrapped surface\'s row, script and port', () => {
    const root = appRoot('dev-row', {
      'web/config/vite.config.js': 'export default {}\n',
      'package.json': JSON.stringify({ name: 'dev-row', scripts: { web: 'vite' } }),
    })
    expect(surfaceRow(root, 'web')).toMatchObject({ script: 'web', env: 'FLI_PORT_FE' })
    expect(surfaceRow(root, 'site')).toBeNull()
  })

  test('a server that answers is reused and named; none and no script is refused', async () => {
    const lines = []
    const log = { info: (l) => lines.push(l), dry: (l) => lines.push(l) }
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })
    try {
      expect(await ensureServer({ root: ROOT, runner: 'bun', script: 'web', port: server.port, label: 'web dev server', log })).toBeNull()
      expect(lines.join('\n')).toContain(`http://localhost:${server.port} already answers`)
    } finally { server.stop(true) }

    await expect(ensureServer({ root: ROOT, runner: 'bun', script: null, port: server.port, label: 'API', log }))
      .rejects.toThrow(/declares no script that starts the API/)
  })
})

describe('what desktop:install writes', () => {
  const launcher = (root, extra = {}) => desktopLauncher({
    root, surface: join(root, 'desktop'),
    bun: '/opt/bun/bin/bun', fli: '/src/cli/bin/fli.js',
    path: '/opt/bun/bin:node_modules/.bin:/usr/bin:/opt/bun/bin', dataHome: '/home/u/.local/share', ...extra,
  })

  test('the entry opens through desktop:run, named and iconed from tauri.conf.json', () => {
    const root = appRoot('install-app')
    scaffoldDesktopSurface({ root, appName: 'install-app' })
    const { file, body } = launcher(root)
    expect(file).toBe('/home/u/.local/share/applications/dev.install-app.desktop.desktop')
    expect(body).toContain('Name=install-app\n')
    expect(body).toContain('Exec=env PATH=/opt/bun/bin:/usr/bin /opt/bun/bin/bun /src/cli/bin/fli.js desktop:run --no-build\n')
    expect(body).toContain(`Path=${root}\n`)
    expect(body).toContain(`Icon=${join(root, 'desktop', 'shell', 'icons', 'icon.png')}\n`)
    expect(body).toContain('StartupWMClass=install-app-desktop\n')
  })

  test('an Exec argument is quoted for both of the parses it gets', () => {
    const root = appRoot('install-quote')
    scaffoldDesktopSurface({ root, appName: 'install-quote' })
    const { body } = launcher(root, { path: '/a b:/c$d', bun: '/x\\y/bun' })
    expect(body).toContain('"PATH=/a b:/c\\\\$d"')
    expect(body).toContain('"/x\\\\\\\\y/bun"')
  })

  test('no crate is no entry', () => {
    expect(launcher(join(ROOT, 'nowhere'))).toBeNull()
  })
})
