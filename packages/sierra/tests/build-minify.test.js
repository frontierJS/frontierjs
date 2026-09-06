/**
 * tests/build-minify.test.js — what decides whether a build is minified
 *
 * `createSierraViteConfig` used to set `minify: process.env.NODE_ENV === 'production'`,
 * overriding Vite's own default — which is `'esbuild'` for a build whatever the
 * ambient env says. So the override could only ever turn minification OFF, and
 * any shell or CI exporting `NODE_ENV=development` shipped a source-shaped
 * production bundle: 140 302 bytes against 53 112 on the fixture that measured
 * it, carrying the readable route table with it (`FJS-799`).
 *
 * `FJS-473`'s shape one file over — *the ambient signal is not the question* —
 * and the package's own `CLAUDE.md` names the trap.
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { build } from 'vite'

import { createSierraViteConfig } from '../src/build/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP = join(__dirname, 'tmp-minify')

async function buildOnce(outDir, minify) {
  const config = createSierraViteConfig({
    target: 'widget',
    vite: {
      root: TMP,
      logLevel: 'silent',
      build: {
        outDir: join(TMP, outDir),
        emptyOutDir: true,
        ...(minify === undefined ? {} : { minify }),
        lib: { entry: join(TMP, 'src/entry.mesa'), formats: ['es'], fileName: 'entry' },
      },
    },
  })
  const result = await build(config)
  const output = Array.isArray(result) ? result[0].output : result.output
  return output.filter(c => c.type === 'chunk').map(c => c.code).join('\n')
}

beforeAll(async () => {
  await mkdir(join(TMP, 'src'), { recursive: true })
  // Long identifiers and dead structure, so minified and not are far apart.
  await writeFile(
    join(TMP, 'src/entry.mesa'),
    [
      '<script>',
      '  const aVeryDistinctlyNamedLocalBinding = 1',
      '  const anotherVeryDistinctlyNamedBinding = aVeryDistinctlyNamedLocalBinding + 1',
      '  let total = anotherVeryDistinctlyNamedBinding',
      '</script>',
      '<p>{total}</p>',
    ].join('\n'),
    'utf8'
  )
}, 60_000)

afterAll(async () => {
  await rm(TMP, { recursive: true, force: true })
})

describe('what decides minification', () => {
  // Both builds run under NODE_ENV=development, and the ONLY difference
  // between them is `minify`. That pairing is the measurement: a size
  // threshold alone is a number that drifts with every dependency, and a
  // config that minified nothing would pass an assertion that only says
  // *smaller than some constant*. The unminified build is the control
  // (`FJS-351`) and the escape at once — an app asking for a readable bundle
  // still gets one.
  test('NODE_ENV=development does not un-minify a build', async () => {
    const before = process.env.NODE_ENV
    process.env.NODE_ENV = 'development'
    try {
      const dflt = await buildOnce('dist-dev', undefined)
      const raw  = await buildOnce('dist-raw', false)

      // Measured on this fixture: 9 319 against 18 161 bytes.
      expect(dflt.length).toBeLessThan(raw.length * 0.75)
    } finally {
      if (before === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = before
    }
  }, 60_000)
})

describe('the dev server port', () => {
  // `strictPort` is not a nicety: vite hops to the next free port in silence,
  // so the second app's drive tests the first app's app. `fli check`'s
  // `vite-strict-port` rule greps an APP's config text, which is the one place
  // this fix could not live (`FJS-821`).
  test('the base config is strict about its port and reads the brokers name', () => {
    const before = process.env.FLI_PORT_FE
    process.env.FLI_PORT_FE = '8010'
    try {
      const config = createSierraViteConfig({ target: 'spa' })
      expect(config.server.strictPort).toBe(true)
      expect(config.server.port).toBe(8010)
    } finally {
      if (before === undefined) delete process.env.FLI_PORT_FE
      else process.env.FLI_PORT_FE = before
    }
  })
})
