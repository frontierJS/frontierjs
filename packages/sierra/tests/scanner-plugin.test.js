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
import { cp, mkdir, rm, writeFile } from 'fs/promises'
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
async function runBuildStart(root, command) {
  const warnings = []
  const errors   = []

  const plugin = scannerPlugin(
    { target: 'static', routesDir: 'src/routes' },
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
