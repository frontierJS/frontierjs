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
// The browser section is the measure. A unit test that only checks the plugin
// raised cannot see the linker, which is what actually decided what the author
// read. The environment is node: happy-dom's global `URL` makes the plugin's
// `fileURLToPath(new URL(…))` throw.

import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { createServer as createHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

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

// ─── the measure: a cold load in a real browser ───────────────────────────────

const CHROME = (() => {
  if (process.env.FJS_CHROME) return process.env.FJS_CHROME
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser']) {
    try { return execFileSync('which', [bin], { encoding: 'utf8' }).trim() } catch {}
  }
  return null
})()

describe.skipIf(!CHROME)('a cold page load on a broken component', () => {
  let work, http, vite, browser, origin

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'mesa-error-surface-'))
    mkdirSync(join(work, 'src'))
    writeFileSync(join(work, 'index.html'),
      '<!doctype html><html><body><div id=app></div>' +
      '<script type="module" src="/src/main.js"></script></body></html>')
    // The import an author writes. It is the shape that matters: a default
    // import is what makes the linker, not the module body, decide.
    writeFileSync(join(work, 'src/main.js'), "import Broken from './Broken.mesa'\nconsole.log(Broken)\n")
    writeFileSync(join(work, 'src/Broken.mesa'), UNCLOSED)

    const { createServer } = await import('vite')
    http = createHttpServer()
    vite = await createServer({
      root: work, cacheDir: join(work, '.vite'), configFile: false, logLevel: 'silent',
      server: { middlewareMode: true, hmr: { server: http } },
      plugins: [mesaPlugin()],
    })
    http.on('request', vite.middlewares)
    await new Promise((r) => http.listen(0, '127.0.0.1', r))
    origin = `http://127.0.0.1:${http.address().port}`

    const { openChrome } = await import('./browser/drive.mjs')
    browser = await openChrome()
  }, 60000)

  afterAll(async () => {
    await browser?.close()
    await vite?.close().catch(() => {})
    if (http) await new Promise((r) => http.close(r))
    try { rmSync(work, { recursive: true, force: true }) } catch {}
  }, 60000)

  // The server half. A module request that RESOLVES is what left the overlay
  // with nothing to show: Vite only reports what its transform rejected.
  test('the dev server refuses to produce the module', async () => {
    await expect(vite.transformRequest('/src/Broken.mesa')).rejects.toThrow(/Unexpected EOF/)
  })

  test('the overlay is on the page and names the file and the fault', async () => {
    await browser.navigate(`${origin}/`)
    const seen = await browser.evaluate(`
      const t0 = Date.now();
      let el;
      for (;;) {
        el = document.querySelector('vite-error-overlay');
        if (el || Date.now() - t0 > 10000) break;
        await new Promise(r => setTimeout(r, 100));
      }
      return { present: !!el, text: (el?.shadowRoot?.textContent ?? '').slice(0, 800) };
    `)

    expect(seen.present).toBe(true)
    expect(seen.text).toContain('Broken.mesa')
    expect(seen.text).toContain('Unexpected EOF')
    // The bogus report the author used to get, in place of the real one.
    expect(seen.text).not.toContain('does not provide an export named')
  }, 30000)

  test('nothing tells the author their own import is wrong', async () => {
    expect(browser.errors.join('\n')).not.toContain('does not provide an export named')
  })
})
