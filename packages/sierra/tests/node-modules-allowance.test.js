/**
 * tests/node-modules-allowance.test.js
 *
 * The mesa plugin skips `.mesa` under node_modules — another package's
 * components are that package's problem — except Sierra's own RouterView and
 * ChainRenderer, which ship uncompiled and must be transformed.
 *
 * That exception tested `/node_modules/sierra/` while the package is
 * `@frontierjs/sierra`, so it never matched, and every app installed from npm
 * handed RouterView.mesa to rolldown untransformed:
 *
 *   JSX syntax is disabled and should be enabled via the parser options
 *     ../node_modules/@frontierjs/sierra/src/components/RouterView.mesa:1:1
 *
 * **No suite in this repo could see it.** An app here resolves sierra to
 * `packages/sierra/`, which is not a node_modules path at all, so the skip never
 * fires and `verify:build` passes. Dev survives too, so the failure lands at the
 * first production build a real user runs (FJS-251).
 *
 * The ids below are therefore written the way an INSTALLED app sees them. A test
 * using workspace paths would pass against the bug — which is the whole reason
 * the bug lasted.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { readFile } from 'fs/promises'
import { mesaPlugin } from '../src/build/mesa-plugin.js'

const SIERRA_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// A component small enough that compiling it proves only that it was compiled.
const SOURCE = '<div class="probe">hi</div>\n'

let plugin

beforeAll(async () => {
  // The shared state the real build hands every plugin. staticMap and
  // layoutPropMap are written during transform, so a bare object fails with
  // "Cannot read properties of undefined (reading 'set')" rather than skipping.
  plugin = mesaPlugin({}, {
    root:          SIERRA_ROOT,
    autoImportMap: new Map(),
    staticMap:     new Map(),
    layoutPropMap: new Map(),
  })
  plugin.configResolved({ root: SIERRA_ROOT, command: 'build', mode: 'production' })
  // Resolves the Mesa compiler. Without it every transform returns null and
  // "skipped" and "transformed" become indistinguishable.
  await plugin.buildStart.call({})
})

// transform returns null when it declines the file, and a { code } object when
// it compiled one. That difference is the whole assertion.
const transformed = async (id) => {
  const ctx = { addWatchFile() {}, warn() {}, error(msg) { throw new Error(msg) } }
  const out = await plugin.transform.call(ctx, SOURCE, id)
  return out != null && typeof out.code === 'string'
}

describe('node_modules allowance', () => {
  test("Sierra's own components are compiled when installed from npm", async () => {
    expect(await transformed('/app/node_modules/@frontierjs/sierra/src/components/RouterView.mesa')).toBe(true)
    expect(await transformed('/app/node_modules/@frontierjs/sierra/src/components/ChainRenderer.mesa')).toBe(true)
  })

  test('another package’s .mesa is left alone', async () => {
    expect(await transformed('/app/node_modules/some-kit/dist/Widget.mesa')).toBe(false)
    expect(await transformed('/app/node_modules/@someone/kit/Widget.mesa')).toBe(false)
  })

  test('an app’s own sources are compiled', async () => {
    expect(await transformed(resolve(SIERRA_ROOT, 'src/routes/index.mesa'))).toBe(true)
  })

  // The behavioural tests above pass for a plugin that transforms everything, so
  // this is what pins the literal the bug lived in. The bare name must not
  // come back.
  test('the plugin names the scoped package, once', async () => {
    const src = await readFile(resolve(SIERRA_ROOT, 'src/build/mesa-plugin.js'), 'utf8')
    expect(src).toContain("SIERRA_PKG = '@frontierjs/sierra'")
    expect(src).not.toContain("'/node_modules/sierra/'")
  })
})
