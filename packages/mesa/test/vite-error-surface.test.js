// @vitest-environment node
//
// vite-error-surface.test.js — what an author SEES when a `.mesa` will not
// compile, on a COLD PAGE LOAD.
//
// The plugin used to answer a broken file with `throw new Error(…)` as the
// module body, and a comment saying the overlay fires. It does not. The module
// is served 200, so Vite has nothing to put in an overlay; and because every
// importer writes `import App from './App.mesa'`, the ES module LINKER rejects
// it for a missing `default` before a line of it runs — so the throw is dead
// code and the report is `SyntaxError: The requested module '/src/Err.mesa'
// does not provide an export named 'default'`, which names neither Mesa nor
// the fault (FJS-836). It survived the drive that closed FJS-024 because the
// only route that drive walks is `handleHotUpdate` — a mid-session edit — and
// that route did send an overlay payload.
//
// With `transform` raising, `handleHotUpdate` needs no compile of its own: the
// re-request the invalidation provokes produces the 500 and the overlay for
// both classes of fault. That is FJS-876's other half — the throwaway compile
// caught a THROW and never read `analysis.errors`, so an inert `$: { }` was a
// second compile of every save that reported nothing.
//
// A unit test that only checks the plugin raised cannot see the linker, which
// is what actually decided what the author read: the cold load in a real
// browser is `test/browser/vite/specs/cold-error.spec.mjs`. The environment is
// node: happy-dom's global `URL` makes the plugin's `fileURLToPath(new URL(…))`
// throw.

import { describe, test, expect } from 'vitest'

import mesaPlugin from '../mesa-vite/index.js'

const ROOT      = '/t'
const UNCLOSED  = '<script>\nlet a = 1\n</script>\n<p>{a}</p>\n<div class="x">\n'
const COLLECTED = '<script>\nlet a = 1, b = 2\n$: { (a, b) }\n</script><p>{a}</p>'
const CLEAN     = '<script>\nlet a = 1\n</script><p>{a}</p>'

// `this.error` throws in Rollup and everything after it is dead. A stub that
// returns instead lets the transform run on and report a module the real dev
// server would never have built.
async function transform(command, source, id = `${ROOT}/T.mesa`) {
  const plugin = mesaPlugin({ hmr: false })
  plugin.configResolved({ root: ROOT, command })
  const raised = []
  const self = {
    error: (e) => { raised.push(e); throw Object.assign(new Error(e.message), e) },
    warn:  () => {}
  }
  try {
    const out = await plugin.transform.call(self, source, id)
    return { code: out?.code ?? null, raised }
  } catch (e) {
    return { code: null, raised, threw: e }
  }
}

// ─── transform raises in dev, not only in a build ─────────────────────────────

describe('a file that will not compile is raised in dev', () => {

  test('a parse failure raises rather than emitting a module', async () => {
    const r = await transform('serve', UNCLOSED)
    expect(r.code).toBeNull()
    expect(r.raised).toHaveLength(1)
    expect(r.raised[0].plugin).toBe('mesa')
    expect(r.raised[0].id).toBe(`${ROOT}/T.mesa`)
    expect(r.raised[0].message).toContain('Unexpected EOF')
    expect(r.raised[0].frame).toContain('<div class="x">')
    // Vite's overlay runs a regex over `stack`; an absent one throws inside
    // the overlay's own constructor and the report becomes nothing at all.
    expect(typeof r.raised[0].stack).toBe('string')
  })

  test('a collected error raises rather than emitting a module', async () => {
    const r = await transform('serve', COLLECTED)
    expect(r.code).toBeNull()
    expect(r.raised).toHaveLength(1)
    expect(r.raised[0].plugin).toBe('mesa')
    expect(r.raised[0].message).toContain('1 error(s) in T.mesa')
    expect(typeof r.raised[0].stack).toBe('string')
  })

  test('a build is unchanged, and a clean file still compiles in both modes', async () => {
    expect((await transform('build', UNCLOSED)).raised).toHaveLength(1)
    for (const command of ['build', 'serve']) {
      const r = await transform(command, CLEAN)
      expect(r.raised).toHaveLength(0)
      expect(r.code).toContain('$$runtime.template')
    }
  })
})

// ─── handleHotUpdate owns invalidation and nothing else ───────────────────────

describe('handleHotUpdate compiles nothing', () => {
  function hook(server) {
    const p = mesaPlugin({ hmr: true })
    p.configResolved({ root: ROOT, command: 'serve' })
    return (file, modules) => p.handleHotUpdate({ file, modules, server })
  }

  const fakeServer = () => {
    const sent = [], invalidated = []
    return { sent, invalidated,
      hot: { send: (m) => sent.push(m) },
      moduleGraph: { invalidateModule: (m) => invalidated.push(m) } }
  }

  // The hook took `read` and compiled its result for the throw alone. Nothing
  // reads the file now, so a `read` that fails cannot decide what the browser
  // is told — the module request does, through transform.
  test('a broken file is invalidated like any other, and reported by nobody here', async () => {
    const server  = fakeServer()
    const modules = [{ id: 'a' }]
    const result  = await hook(server)(`${ROOT}/Broken.mesa`, modules)

    expect(result).toBe(modules)
    expect(server.invalidated).toEqual(modules)
    expect(server.sent).toHaveLength(0)
  })

  test('a file the plugin does not claim is still left to Vite', async () => {
    const server = fakeServer()
    expect(await hook(server)(`${ROOT}/main.js`, [{ id: 'x' }])).toBeUndefined()
    expect(server.invalidated).toHaveLength(0)
  })
})
