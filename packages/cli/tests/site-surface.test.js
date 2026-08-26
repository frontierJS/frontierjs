/*
 * tests/site-surface.test.js
 *
 * `core/site-surface.js` is the one owner of what a `site/` surface is, and
 * both callers — `fli make:site` and `fli new --site` — write through it. The
 * thing worth testing is not that files appear: it is that what appears
 * satisfies the rules the framework will then judge the app by, since a
 * scaffold whose first `fli check` is red is worse than no scaffold.
 *
 * So the assertions below are mostly cross-module: the generated tree is run
 * through `runChecks` and through the port formula, rather than compared to
 * itself.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join }   from 'path'
import { tmpdir } from 'os'

import { scaffoldSiteSurface, siteScripts, SITE_SURFACE_DIRS } from '../core/site-surface.js'
import { runChecks } from '../core/checks.js'
import { port, PROJECTS } from '../core/ports.js'

let ROOT

const SCHEMA = `
model Product { id Int @id  name String  @@gate("0.4.4.5") }
`

/** An app root with a schema, ready for a surface to be written into it. */
function appRoot(name, extra = {}) {
  const dir = join(ROOT, name)
  mkdirSync(join(dir, 'db'), { recursive: true })
  writeFileSync(join(dir, 'db', 'schema.lite'), SCHEMA)
  for (const [path, body] of Object.entries(extra)) {
    const full = join(dir, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return dir
}

const only = (root, id) => runChecks({ root, only: [id] })

beforeAll(() => { ROOT = mkdtempSync(join(tmpdir(), 'fli-site-')) })
afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

describe('the surface it writes', () => {
  test('every folder the layout promises, and no dist/', () => {
    const root = appRoot('dirs')
    scaffoldSiteSurface({ root, appName: 'shop' })

    for (const d of SITE_SURFACE_DIRS) expect(existsSync(join(root, 'site', d))).toBe(true)

    // `dist/` is build output. Scaffolding one makes an empty directory that
    // looks like a build nobody can explain.
    expect(existsSync(join(root, 'site', 'dist'))).toBe(false)
  })

  test('it passes the rules the framework will judge it by', () => {
    // The whole point. `fli new` writing a tree that `fli check` then reports
    // is the failure mode this asserts against — it was real for `fli check`
    // itself, which had never run at all (FJS-269).
    const root = appRoot('clean', {
      'api/index.ts':                 "import { app } from './src/app'\napp.start()\n",
      'api/src/app.ts':               'export const app = {}\n',
      'api/config/junction.config.js': 'export default {}\n',
    })
    scaffoldSiteSurface({ root, appName: 'shop' })

    expect(only(root, 'app-layout').findings).toEqual([])
    expect(only(root, 'surface-config').findings).toEqual([])
    expect(only(root, 'surface-src').findings).toEqual([])
  })

  test('the config declares the static target and where the routes are', () => {
    const root = appRoot('cfg')
    scaffoldSiteSurface({ root, appName: 'shop' })
    const cfg = readFileSync(join(root, 'site', 'config', 'sierra.config.js'), 'utf8')

    expect(cfg).toMatch(/target:\s*'static'/)
    expect(cfg).toMatch(/routesDir:\s*'src\/routes'/)
    // A directory per route is what a static host serves with no rewrite rules.
    expect(cfg).toMatch(/trailingSlash:\s*'always'/)
  })

  test('the home page declares `render: static`, because the build emits nothing without it', () => {
    const root = appRoot('page')
    scaffoldSiteSurface({ root, appName: 'shop' })
    const page = readFileSync(join(root, 'site', 'src', 'routes', 'index.mesa'), 'utf8')
    expect(page).toMatch(/^render: static$/m)
  })

  test('the dev shell never writes the body tag inside a comment', () => {
    // Vite injects the built script at the first TEXTUAL match for the body tag
    // and does not skip comments: mention it in one and the build succeeds,
    // dist/index.html looks right, and the page loads no JavaScript.
    const root = appRoot('shell')
    scaffoldSiteSurface({ root, appName: 'shop' })
    const html = readFileSync(join(root, 'site', 'index.html'), 'utf8')

    for (const comment of html.match(/<!--[\s\S]*?-->/g) ?? []) {
      expect(comment).not.toMatch(/<\/?body/)
    }
  })
})

describe('the db tap', () => {
  test('an app with an api/ gets one, so the publish check can run', () => {
    const root = appRoot('withapi', { 'api/src/app.ts': 'export const app = {}\n', 'api/config/junction.config.js': 'export default {}\n' })
    scaffoldSiteSurface({ root, hasApi: true })
    const cfg = readFileSync(join(root, 'site', 'config', 'sierra.config.js'), 'utf8')
    expect(cfg).toMatch(/^\s*db:\s*'\.\.\/api/m)
  })

  test('an app with no api/ declares none, and says what to add', () => {
    // A `db:` pointing at a file that is not there is a build that fails before
    // it can say anything useful. Absent is the honest state, and the comment
    // is what makes it recoverable.
    const root = appRoot('noapi')
    scaffoldSiteSurface({ root, hasApi: false })
    const cfg = readFileSync(join(root, 'site', 'config', 'sierra.config.js'), 'utf8')
    expect(cfg).not.toMatch(/^\s*db:/m)
    expect(cfg).toMatch(/api\/src\/core\/db\.ts/)
  })
})

describe('the ports it bakes in', () => {
  test('the vite config carries the number the formula gives, not a literal', () => {
    // `fli make:widget` wrote project 0's ports into every app for its whole
    // life (FJS-445), and `strictPort` turns that into a refusal naming a port
    // nobody chose. The generator takes the number; this asserts it lands.
    const root      = appRoot('ports')
    const projectId = PROJECTS.example
    const devPort   = port('siteDev',   { env: 'dev', projectId })
    const servePort = port('siteServe', { env: 'dev', projectId })

    scaffoldSiteSurface({ root, devPort, servePort })

    const vite = readFileSync(join(root, 'site', 'config', 'vite.config.js'), 'utf8')
    expect(vite).toContain(String(devPort))
    // Vite hops ports in silence, and then the drive tests whatever else is up.
    expect(vite).toMatch(/strictPort:\s*true/)

    const serve  = readFileSync(join(root, 'site', 'deploy', 'serve.js'), 'utf8')
    const docker = readFileSync(join(root, 'site', 'deploy', 'Dockerfile'), 'utf8')
    expect(serve).toContain(String(servePort))
    expect(docker).toContain(`EXPOSE ${servePort}`)
  })

  test('the scripts name the same served port the deploy does', () => {
    const scripts = siteScripts({ servePort: 8710 })
    expect(scripts['serve:site']).toContain('8710')
    expect(scripts['dev:site']).toMatch(/vite -c config\/vite\.config\.js/)
    // The build is `vite build` and nothing else — a static target is an
    // ordinary build that prerenders afterwards.
    expect(scripts['build:site']).toMatch(/vite build -c config\/vite\.config\.js/)
    // `bun --bun`: the build imports the app's Litestone client to tap what
    // load() reads, and node's TS stripper refuses a parameter property — which
    // Vite reports as "could not load the db", i.e. as a path problem.
    expect(scripts['build:site']).toMatch(/^cd site && bun --bun vite build/)
  })
})

describe('running it twice', () => {
  test('a second pass overwrites nothing', () => {
    // It is called to top a surface up as often as to create one, and a
    // scaffold that overwrites a config is a scaffold nobody runs twice.
    const root = appRoot('twice')
    const first = scaffoldSiteSurface({ root, appName: 'shop' })
    expect(first.written.length).toBeGreaterThan(0)
    expect(first.skipped).toEqual([])

    const edited = join(root, 'site', 'config', 'sierra.config.js')
    writeFileSync(edited, '// mine\nexport default { target: "static" }\n')

    const second = scaffoldSiteSurface({ root, appName: 'shop' })
    expect(second.written).toEqual([])
    expect(second.skipped).toEqual(first.written)
    expect(readFileSync(edited, 'utf8')).toContain('// mine')
  })
})
