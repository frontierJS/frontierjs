// @vitest-environment node
//
// A Vite plugin runs in Node. Under this package's default happy-dom
// environment the global `URL` is happy-dom's, so `fileURLToPath(new URL(…,
// import.meta.url))` throws `must be of scheme file` against a path that is
// perfectly fine in a real dev server.

/**
 * vite-hmr-failclosed.test.js — the two ways the HMR boundary refuses to be
 * injected, driven rather than described (`FJS-865`, `FJS-887`).
 *
 * Failing closed means the module gets NO `import.meta.hot.accept`, which is
 * what leaves it on Vite's full-reload path. The failure it is written against
 * is the opposite: an accept is injected, so from Vite's point of view the
 * module self-accepts and nothing is escalated — and if the client behind that
 * accept cannot do the swap, every edit is swallowed for the life of the page.
 *
 * Both guards were unreachable before this file. `canInject` refused none of 19
 * shapes the real compiler emits, and the client's assembly failure had no
 * trigger at all. The stub compiler is what makes the first one fireable: it
 * emits output shaped like a compiler that has moved on. Every refusal here is
 * PAIRED with the acceptance of output one line different, because a guard that
 * refused everything would satisfy a test that only asks about the refusal.
 */

import { describe, test, expect, vi } from 'vitest'
import { parse }                      from 'acorn'
import { fileURLToPath }              from 'node:url'

import { canInject, injectHMR } from '../mesa-vite/hmr.js'

const STUB   = fileURLToPath(new URL('./fixtures/stub-compiler.mjs', import.meta.url))
const ROOT   = '/app'
const CLIENT = '\0@frontierjs/mesa-client'

// What the wrap needs: the default export's exact signature, and a component
// body ending in pop_component(). Removing the second line is the whole of the
// difference between the two fixtures.
const WRAPPABLE = `export default function Stub(__anchor, __props, __block) {
  $$runtime.pop_component();
}`
const NOT_WRAPPABLE = `export default function Stub(__anchor, __props, __block) {
  $$runtime.somethingElse();
}`

/** A plugin from a FRESH module registry, optionally with the client broken. */
async function freshPlugin(options = {}, { brokenClient = false } = {}) {
  vi.resetModules()
  if (brokenClient) {
    vi.doMock('../mesa-vite/client-source.js', () => ({
      hmrClientSource() { throw new Error('client.js no longer imports swapInstances') }
    }))
  } else {
    vi.doUnmock('../mesa-vite/client-source.js')
  }

  const { default: mesaPlugin } = await import('../mesa-vite/index.js')
  const plugin = mesaPlugin(options)
  plugin.configResolved({ root: ROOT, command: 'serve' })
  return plugin
}

async function transform(plugin, source, id = `${ROOT}/A.mesa`) {
  const warnings = []
  const self = {
    warn:  (w) => warnings.push(typeof w === 'string' ? w : w.message),
    error: (e) => { throw Object.assign(new Error(e.message), e) }
  }
  const out = await plugin.transform.call(self, source, id)
  return { code: out?.code ?? null, warnings }
}

const parses = (js) =>
  expect(() => parse(js, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()

// ─── output the wrap no longer recognises ─────────────────────────────────────

describe('a compiler whose output shape has moved on', () => {
  test('canInject fires on it, and not on the shape one line away', () => {
    expect(canInject(NOT_WRAPPABLE)).toBe(false)
    expect(canInject(WRAPPABLE)).toBe(true)
  })

  // What the guard is worth. Wrapping this shape anyway emits JavaScript that
  // parses, self-accepts, and registers NOTHING — so the accept fires on every
  // edit and finds no instance to swap: half a boundary, and silent.
  test('wrapping it anyway would emit an accept with nothing behind it', () => {
    const js = injectHMR(NOT_WRAPPABLE, `${ROOT}/A.mesa`, ROOT, CLIENT)

    parses(js)
    expect(js).toContain('import.meta.hot.accept')
    expect(js).not.toContain('__mesa_register(')
  })

  test('the module ships with no accept, so Vite still escalates', async () => {
    const plugin   = await freshPlugin({ compilerPath: STUB })
    const { code } = await transform(plugin, JSON.stringify({ result: NOT_WRAPPABLE }))

    expect(code).not.toContain('import.meta.hot.accept')
    expect(code).not.toContain('__mesa_register')
    expect(code).toContain('export default function Stub')
    parses(code)
  })

  // The control. Same plugin, same options, output that only differs by the
  // pop_component() line — the boundary is injected.
  test('the shape it does recognise is wrapped', async () => {
    const plugin   = await freshPlugin({ compilerPath: STUB })
    const { code } = await transform(plugin, JSON.stringify({ result: WRAPPABLE }))

    expect(code).toContain('import.meta.hot.accept')
    expect(code).toContain('__mesa_register(')
    parses(code)
  })
})

// ─── a client that cannot be assembled ────────────────────────────────────────

describe('an HMR client the plugin cannot serve', () => {
  test('no boundary is injected, and the developer is told why', async () => {
    const plugin = await freshPlugin({ compilerPath: STUB }, { brokenClient: true })
    const { code, warnings } = await transform(plugin, JSON.stringify({ result: WRAPPABLE }))

    // With an accept and a no-op client behind it the module self-accepts and
    // the edit is swallowed: no swap, no reload, nothing said.
    expect(code).not.toContain('import.meta.hot.accept')
    expect(code).not.toContain('__mesa_register')
    expect(warnings.join('\n')).toContain('full-reload path')
    parses(code)
  })

  test('the answer is remembered, so one warning covers the session', async () => {
    const plugin = await freshPlugin({ compilerPath: STUB }, { brokenClient: true })
    const first  = await transform(plugin, JSON.stringify({ result: WRAPPABLE }), `${ROOT}/A.mesa`)
    const second = await transform(plugin, JSON.stringify({ result: WRAPPABLE }), `${ROOT}/B.mesa`)

    expect(first.warnings).toHaveLength(1)
    expect(second.warnings).toHaveLength(0)
    expect(second.code).not.toContain('import.meta.hot.accept')
  })

  // The join can break after the server is up — the probe above runs once. A
  // component compiled before that already carries the accept, so the stub the
  // load hook answers with is the last thing standing between an edit and
  // silence. It escalates rather than returning nothing.
  test('the stub client served in its place reloads instead of swallowing', async () => {
    const plugin   = await freshPlugin({}, { brokenClient: true })
    const warnings = []
    const js = plugin.load.call({ warn: (w) => warnings.push(w) }, CLIENT)

    expect(js).toContain('location.reload()')
    expect(warnings.join('\n')).toContain('full-reload')
    parses(js)
  })

  test('a client that assembles is served whole', async () => {
    const plugin = await freshPlugin()
    const js     = plugin.load.call({ warn() {} }, CLIENT)

    expect(js).toContain('function swapInstances')
    expect(js).not.toContain('location.reload()')
  })
})
