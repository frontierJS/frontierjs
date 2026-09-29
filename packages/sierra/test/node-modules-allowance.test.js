/**
 * test/node-modules-allowance.test.js
 *
 * The mesa plugin compiles every `.mesa` under node_modules. It once skipped
 * them all but its own, and each exception it carved was one package too few.
 *
 * The first exception tested `/node_modules/sierra/` while the package is
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
 * Widening it to the `@frontierjs/` scope left every other library out: the
 * ksite engine, installed from its tarball, served a blank `vite dev` page on
 * line 1 of its Page.mesa (FJS-1552).
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

  // The kit and the email components ship as SOURCE too, and allowing only
  // sierra left every one of them untransformed — `Unexpected JSX expression`
  // at line 1 of CopyButton.mesa, for an app that had installed it correctly.
  // Same bug as the one above, one package over, found the same way: by
  // containerizing an app so it could not resolve the workspace.
  test('every @frontierjs package that ships .mesa is compiled', async () => {
    expect(await transformed('/app/node_modules/@frontierjs/ui/components/display/CopyButton.mesa')).toBe(true)
    expect(await transformed('/app/node_modules/@frontierjs/ui/components/forms/Input.mesa')).toBe(true)
    expect(await transformed('/app/node_modules/@frontierjs/email-kit/components/Button.mesa')).toBe(true)
  })

  // Nothing but the Mesa compiler can read a .mesa, so another package's
  // component is compiled here or not at all (FJS-1552).
  test('another package’s .mesa is compiled too', async () => {
    expect(await transformed('/app/node_modules/some-kit/dist/Widget.mesa')).toBe(true)
    expect(await transformed('/app/node_modules/@someone/kit/Widget.mesa')).toBe(true)
    expect(await transformed('/app/node_modules/@kobami/ksite/src/layouts/Page.mesa')).toBe(true)
  })

  // `node_modules` CONTAINS the substring `_module`, and the layout test was
  // `id.includes('_module')` — so every installed .mesa read as a layout, took
  // the layout slot rewrite rather than the page one, and failed to compile
  // with `'__slot_actions' is already declared`: a message about a slot the
  // author never wrote. The kit's Form.mesa is the file it fired on, and the
  // only way to see it was to build an app that could not resolve the alias.
  test('a component under node_modules is not mistaken for a layout', async () => {
    expect(await transformed('/app/node_modules/@frontierjs/ui/components/forms/Form.mesa')).toBe(true)
  })

  test('an app’s own sources are compiled', async () => {
    expect(await transformed(resolve(SIERRA_ROOT, 'src/routes/index.mesa'))).toBe(true)
  })

  // The skip this file once tested is the whole of the bug, in each of its
  // three spellings, so none of them may come back.
  test('the plugin skips nothing under node_modules', async () => {
    const src = await readFile(resolve(SIERRA_ROOT, 'src/build/mesa-plugin.js'), 'utf8')
    expect(src).not.toMatch(/node_modules\/'\)[^\n]*\)\s*return null/)
    expect(src).not.toContain('FJS_SCOPE')
    expect(src).not.toContain('SIERRA_PKG')
  })
})
