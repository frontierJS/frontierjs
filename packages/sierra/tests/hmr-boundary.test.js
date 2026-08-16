/**
 * tests/hmr-boundary.test.js — the HMR boundary through a REAL dev server.
 *
 * Sierra used to carry its own copy of the boundary and of the browser client it
 * imports. Both are Mesa's now (`FJS-D16`): this plugin reimplements the PLUGIN
 * — frontmatter, the fence preprocessor, slot rewriting, auto-imports — and had
 * no reason to reimplement either of those.
 *
 * Which means the wiring, not the algorithm, is what can break here, and it
 * breaks QUIETLY: both are located with `findMesaFile`, and a miss turns HMR off
 * and falls back to a full page reload rather than failing a build. Nothing in
 * the unit suites would notice. So this boots a dev server and asks the two
 * questions that wiring answers:
 *
 *   1. did a `.mesa` module come back with a boundary in it
 *   2. does the virtual client id serve MESA'S client
 *
 * The second is checked on a line that exists only in Mesa's copy, so serving a
 * stale local file would fail rather than pass.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join, dirname }        from 'path'
import { fileURLToPath }        from 'url'
import { createServer }         from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'
import { findMesaFile }           from '../src/build/mesa-plugin.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP       = join(__dirname, 'tmp-hmr-boundary')

// The id sierra's plugin serves the client at. A literal, deliberately: if the
// plugin renames it, this test should fail rather than follow.
const CLIENT_ID = '/@frontierjs/sierra/hmr-client'

let server

beforeAll(async () => {
  await mkdir(join(TMP, 'src/routes'), { recursive: true })
  await writeFile(
    join(TMP, 'src/routes/index.mesa'),
    '<script>\n  let count = 0\n</script>\n\n<button onclick={() => count++}>{count}</button>\n',
    'utf8'
  )

  const config = createSierraViteConfig({
    target: 'spa',
    vite: {
      root: TMP,
      logLevel: 'silent',
      server: { middlewareMode: true },
      appType: 'custom',
    },
  })

  server = await createServer(config)
}, 60_000)

afterAll(async () => {
  await server?.close()
  await rm(TMP, { recursive: true, force: true })
})

describe('the HMR boundary in dev', () => {

  test('a .mesa module comes back wrapped', async () => {
    const mod = await server.transformRequest('/src/routes/index.mesa')
    expect(mod).toBeTruthy()

    // The three halves of the boundary: the client import, the registration,
    // and the accept handler. Any one missing is a boundary that does nothing.
    expect(mod.code).toContain(`from '${CLIENT_ID}'`)
    expect(mod.code).toContain('__mesa_register(')
    expect(mod.code).toContain('import.meta.hot.accept')
    expect(mod.code).toContain('__mesaHMRWrap')
  })

  // The regression the copy had fixed and Mesa's had not: `__setMark` must land
  // on the function handed to the client, or the mark is never applied and HMR
  // works exactly once per page load.
  test('__setMark is set on the function passed to the client', async () => {
    const mod = await server.transformRequest('/src/routes/index.mesa')
    expect(mod.code).toContain('next.__setMark = m.__setMark')
    expect(mod.code).not.toContain('__mesaOrigFn.__setMark = m.__setMark')
  })

  test("the virtual client id serves Mesa's client, not a local copy", async () => {
    const mod = await server.transformRequest(CLIENT_ID)
    expect(mod).toBeTruthy()
    expect(mod.code).toContain('__mesa_register')
    expect(mod.code).toContain('__mesa_hot_update')

    // Only Mesa's copy says this. A file served from anywhere else fails here.
    expect(mod.code).toContain('[Mesa HMR]')
    expect(mod.code).toContain('falling back to reload')
  })
})

// The locator is what makes the three above possible, and it is the half that
// answers `undefined` rather than throwing — so the negative control is asserted
// beside the positive one. Without it, "found nothing" and "found the wrong
// thing" would both read as a passing suite.
describe('locating Mesa\'s HMR files', () => {

  test('both are found from this repo', () => {
    expect(findMesaFile('mesa-vite/hmr.js', TMP)).toBeTruthy()
    expect(findMesaFile('mesa-vite/client.js', TMP)).toBeTruthy()
  })

  test('a name that is not there answers undefined rather than a guess', () => {
    expect(findMesaFile('mesa-vite/not-a-file.js', TMP)).toBeUndefined()
  })
})
