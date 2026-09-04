/**
 * tests/scanner-plugin.test.js — the scanner plugin RUN, not restated.
 *
 * `static-paths.test.js` beside this one asserts the same rules by rebuilding
 * what the plugin does — scan the tree, import the companion, construct the
 * message by hand. Every one of those passed while `checkStaticPaths` threw
 * `ReferenceError: warn is not defined` on its own warn path, and while every
 * dev boot took the build branch, because nothing in the suite called
 * `buildStart` (`FJS-473`).
 *
 * So this one calls it, through a plugin context that behaves like rollup's:
 * `this.error` throws, `this.warn` collects.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { cp, mkdir, rm, writeFile, readFile } from 'fs/promises'
import { dirname, resolve }         from 'path'
import { fileURLToPath }            from 'url'

import { scannerPlugin } from '../src/build/scanner-plugin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE   = resolve(__dirname, 'fixtures/static-site')
const TMP       = resolve(__dirname, 'tmp-scanner-plugin')

// The fixture is copied because a scan WRITES config/routes.js next to it.
beforeAll(async () => {
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })
  await cp(FIXTURE, TMP, { recursive: true })
})

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true })
})

/**
 * Run the real plugin's buildStart over `root`.
 * `command` is what vite's configResolved reports: 'serve' or 'build'.
 */
async function runBuildStart(root, command, config = {}) {
  const warnings = []
  const errors   = []

  const plugin = scannerPlugin(
    { target: 'static', routesDir: 'src/routes', ...config },
    { tree: null, layoutPropMap: new Map() }
  )

  plugin.configResolved({ root, command })

  const ctx = {
    // rollup's this.error THROWS — a context that only collects would let a
    // build the plugin failed read as a build that passed.
    error: (msg) => { errors.push(String(msg)); throw new Error(String(msg)) },
    warn:  (msg) => { warnings.push(String(msg)) },
    // Vite 8 reports `dev` here for a dev server, never `serve`. Present so the
    // test fails if the plugin goes back to reading it.
    environment: { mode: command === 'build' ? 'build' : 'dev' },
  }

  let threw = null
  try {
    await plugin.buildStart.call(ctx)
  } catch (err) {
    threw = err
  }
  return { warnings, errors, threw }
}

describe('scannerPlugin buildStart', () => {
  test('a dev server boots with a dynamic render:static route missing getStaticPaths', async () => {
    const { threw, errors } = await runBuildStart(TMP, 'serve')

    expect(threw).toBeNull()
    expect(errors).toEqual([])
  })

  test('a build fails on that same route, naming it', async () => {
    const { threw } = await runBuildStart(TMP, 'build')

    expect(threw).toBeTruthy()
    expect(threw.message).toContain('getStaticPaths')
    expect(threw.message).toContain('[tag].meta.js')
  })

  test('a companion that throws on import warns with the cause, and does not crash', async () => {
    const root = resolve(__dirname, 'tmp-scanner-plugin-boom')
    await rm(root, { recursive: true, force: true })
    await cp(FIXTURE, root, { recursive: true })
    // A companion importing something that is not there is the ordinary shape:
    // a site's own database client, absent until the app is configured.
    await rm(resolve(root, 'src/routes/blog/[tag].mesa'))
    await rm(resolve(root, 'src/routes/blog/[tag].meta.js'))
    await writeFile(
      resolve(root, 'src/routes/blog/[boom].mesa'),
      '---\nrender: static\n---\n\n<h1>boom</h1>\n', 'utf8'
    )
    await writeFile(
      resolve(root, 'src/routes/blog/[boom].meta.js'),
      "throw new Error('no database here')\nexport async function getStaticPaths() { return [] }\n",
      'utf8'
    )

    const { threw, warnings } = await runBuildStart(root, 'build')
    await rm(root, { recursive: true, force: true })

    expect(threw).toBeNull()
    const warning = warnings.find(w => w.includes('[boom].meta.js'))
    expect(warning).toBeTruthy()
    expect(warning).toContain('no database here')
  })
})

// ─── A prerendered route's data, in dev ──────────────────────────────────────
//
// `load()` runs in Node at build time, and the companion may never enter the
// browser graph — following one there published a storefront's database client
// (`FJS-543`). What that left was a dev server rendering every page with
// `data: null`, which is correct and looks exactly like a query that found
// nothing. The dev server is a Node process, so the loader runs THERE and the
// browser fetches JSON. The property that must not move is the one below: the
// browser still never imports the companion, in dev or in a build.
describe('static routes in dev', () => {
  const table = () => readFile(resolve(TMP, 'config/routes.js'), 'utf8')

  test('dev emits a fetch shim for a render:static route', async () => {
    await runBuildStart(TMP, 'serve')
    const code = await table()
    expect(code).toContain('__sierraDevStatic')
    expect(code).toContain('/__sierra/static-data')
  })

  test('and still does not import the companion', async () => {
    // The whole security property, asserted on the shape rather than trusted:
    // a fetch cannot pull a module into the bundle, an import can.
    await runBuildStart(TMP, 'serve')
    const code = await table()
    expect(code).not.toMatch(/import\(['"][^'"]*\.meta\.js['"]\)/)
  })

  test('a build emits neither', async () => {
    await runBuildStart(TMP, 'build')
    const code = await table()
    expect(code).not.toContain('__sierraDevStatic')
    expect(code).not.toMatch(/import\(['"][^'"]*\.meta\.js['"]\)/)
  })

  test('dev: { staticData: false } opts out', async () => {
    await runBuildStart(TMP, 'serve', { dev: { staticData: false } })
    const code = await table()
    expect(code).not.toContain('__sierraDevStatic')
    // …and the route is still not given a real loader, which is the behavior
    // opting out asks for rather than a second way of getting one.
    expect(code).not.toMatch(/import\(['"][^'"]*\.meta\.js['"]\)/)
  })
})
