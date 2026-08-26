/**
 * vite-plugin.test.js — the plugin's own surface, against the real compiler.
 *
 * `test/vite-hmr.test.js` pins the BOUNDARY and `test/vite-errors.test.js` pins
 * the error path; this is everything the plugin decides on its own — which files
 * it claims, when the boundary is injected at all, what it does with a warning,
 * what it serves at its virtual ids, and what a hot update invalidates.
 *
 * The plugin hooks are called with a stand-in for Vite's plugin context (`this`
 * is `{ warn, error }` and nothing else is reached), because every hook here is
 * a pure function of its arguments. The one thing that is NOT stood in is the
 * compiler: `transform` is only interesting because of what the compiler hands
 * back, and a fixture of compiled output keeps passing after the shape it
 * describes stops being emitted (Invariant 15, and the reason vite-hmr.test.js
 * compiles for real too). `test/vite-compiler-resolution.test.js` is where a
 * stub compiler is the point rather than a shortcut.
 */

import { describe, test, expect } from 'vitest'
import { parse }                  from 'acorn'

import mesaPlugin from '../mesa-vite/index.js'

const ROOT = '/app'

const COUNTER = `
<script>
  let count = 0
</script>

<button onclick={() => count++}>{count}</button>
`

const STYLED = `
<script>
  let n = 1
</script>

<p>{n}</p>

<style>p { color: red }</style>
`

// A warning, not an error: the compiler collects it into analysis.warnings and
// still emits a module. An error would take the `this.error` path instead.
const WARNS = `
<script>
  let n = 1
</script>

<mesa:boundary><p>{n}</p></mesa:boundary>
`

// ─── harness ──────────────────────────────────────────────────────────────────

/** Run transform() the way Vite does, and collect what the plugin reported. */
async function transform(source, id, { command = 'serve', ...options } = {}) {
  const plugin = mesaPlugin(options)
  plugin.configResolved({ root: ROOT, command })

  const warnings = []
  const errors   = []
  const self     = {
    warn:  (w) => warnings.push(typeof w === 'string' ? w : w.message),
    error: (e) => { errors.push(e); throw Object.assign(new Error(e.message), e) }
  }

  // `this.error` throws in Vite, and does here, so a test asserting on what was
  // reported still gets to see it.
  try {
    const out = await plugin.transform.call(self, source, id)
    return { plugin, code: out?.code ?? null, out, warnings, errors, threw: null }
  } catch (threw) {
    return { plugin, code: null, out: null, warnings, errors, threw }
  }
}

// Invariant 15 — a clean transform is not proof of valid JS. acorn is the
// compiler's own parser, so this asks the question the compiler answers.
const parses = (js) =>
  expect(() => parse(js, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()

const HAS_BOUNDARY = (js) => js.includes('__mesaHMRWrap')

// ─── which files the plugin claims ────────────────────────────────────────────

describe('file selection', () => {
  test('.mesa and .md are claimed by default, nothing else is', async () => {
    expect((await transform(COUNTER, `${ROOT}/A.mesa`)).code).toBeTruthy()
    expect((await transform('# Hi\n\ntext', `${ROOT}/page.md`)).code).toBeTruthy()

    // A `.js` file reaching the compiler would be compiled as a template — the
    // whole file body read as markup. Returning null hands it back to Vite.
    expect((await transform('export const a = 1', `${ROOT}/a.js`)).out).toBeNull()
  })

  test('`extensions` replaces the list rather than adding to it', async () => {
    const opts = { extensions: ['.mesa'] }
    expect((await transform(COUNTER, `${ROOT}/A.mesa`, opts)).code).toBeTruthy()
    expect((await transform('# Hi', `${ROOT}/page.md`, opts)).out).toBeNull()
  })

  // The test is `endsWith`, so this is what it costs: a file whose NAME ends in
  // a claimed extension is claimed wherever it lives.
  test('the match is on the whole id, so a query string is not stripped', async () => {
    expect((await transform(COUNTER, `${ROOT}/A.mesa?import`)).out).toBeNull()
  })
})

// ─── the HMR boundary is a dev-only, .mesa-only decision ──────────────────────

describe('when the HMR boundary is injected', () => {
  test('dev + .mesa + hmr on — injected, and the result still parses', async () => {
    const { code } = await transform(COUNTER, `${ROOT}/A.mesa`)
    expect(HAS_BOUNDARY(code)).toBe(true)
    expect(code).toContain(`__mesa_register('/A.mesa'`)
    parses(code)
  })

  test('a build never gets one — import.meta.hot does not exist there', async () => {
    const { code } = await transform(COUNTER, `${ROOT}/A.mesa`, { command: 'build' })
    expect(HAS_BOUNDARY(code)).toBe(false)
    parses(code)
  })

  test('hmr: false turns it off in dev too', async () => {
    const { code } = await transform(COUNTER, `${ROOT}/A.mesa`, { hmr: false })
    expect(HAS_BOUNDARY(code)).toBe(false)
  })

  // A .md page is a page, not a component: the boundary re-renders in place from
  // the module's default export, and a page is mounted by the router.
  test('a .md page is compiled but never wrapped', async () => {
    const { code } = await transform('# Hi\n\ntext', `${ROOT}/page.md`)
    expect(code).toBeTruthy()
    expect(HAS_BOUNDARY(code)).toBe(false)
    parses(code)
  })

  // canInject fails CLOSED (see hmr.js), and failing closed is silent by
  // construction: every .mesa file would quietly drop to Vite's full-reload path
  // with nothing red. So the canary is the other direction — the shapes the
  // compiler emits for a component with nothing in it are still wrappable.
  test('every shape the compiler emits is still wrappable', async () => {
    const shapes = {
      static:     '<p>hi</p>',
      empty:      '',
      styleOnly:  '<style>p { color: red }</style>',
      moduleOnly: '<script module>\n  export const x = 1\n</script>\n',
    }

    for (const [name, source] of Object.entries(shapes)) {
      const { code } = await transform(source, `${ROOT}/${name}.mesa`)
      expect(HAS_BOUNDARY(code), name).toBe(true)
      parses(code)
    }
  })
})

// ─── warnings ─────────────────────────────────────────────────────────────────

describe('compiler warnings', () => {
  // The comment block is what carries a warning into a production build, where
  // nothing is watching a dev server's output — and here it is the ONLY channel.
  // The `warning` callback the plugin passes is drained once, right after the
  // script analysis, so a warning the template emitter pushes later (this one)
  // never reaches `this.warn`. Reading the callback alone would report a clean
  // compile for a component the compiler had something to say about.
  test('reach the module as comments even when this.warn never fires', async () => {
    const { code, warnings } = await transform(WARNS, `${ROOT}/W.mesa`)

    expect(warnings).toHaveLength(0)
    expect(code).toContain('// ⚠ Mesa: <mesa:boundary> has no async-derived')
    parses(code)
  })

  // What the callback DOES carry is an analysis error — undecorated, so it
  // arrives looking like a warning and is escalated by the caller a moment later
  // (test/vite-errors.test.js). Both channels fire for one diagnostic.
  test('an analysis error reaches this.warn before it fails the transform', async () => {
    const { warnings, errors } = await transform(
      '<script>\nlet a = 1, b = 2\n$: { (a, b) }\n</script><p>{a}</p>',
      `${ROOT}/E.mesa`,
      { command: 'build' }
    )

    expect(warnings.join('\n')).toContain('does nothing')
    expect(errors).toHaveLength(1)
  })

  test('a warning does not fail the transform in either mode', async () => {
    for (const command of ['serve', 'build']) {
      const { code, errors } = await transform(WARNS, `${ROOT}/W.mesa`, { command })
      expect(errors).toHaveLength(0)
      expect(code).toContain('$$runtime.template')
    }
  })

  test('a clean component gets no comment block', async () => {
    const { code } = await transform(COUNTER, `${ROOT}/A.mesa`)
    expect(code).not.toContain('⚠ Mesa')
  })
})

// ─── styles ───────────────────────────────────────────────────────────────────

describe('styles', () => {
  test('css: true inlines the scoped rules into the module', async () => {
    const { code } = await transform(STYLED, `${ROOT}/S.mesa`)
    expect(code).toContain('$$runtime.addStyles(')
    expect(code).toContain('color: red')
    parses(code)
  })

  // FJS-291: there was a second delivery route here, a `?mesa-css` virtual
  // module, and it could not fire under either value of `css` — the compiler's
  // `css` is a DESTINATION rather than a switch, and the two readings of the
  // word never lined up. It is gone. Inlining is the one route, and it is the
  // route Sierra's plugin takes for the same file.
  test('there is no second delivery route for styles', async () => {
    const { code, plugin } = await transform(STYLED, `${ROOT}/S.mesa`)

    expect(code).not.toContain('mesa-css')
    expect(plugin.resolveId(`${ROOT}/S.mesa?mesa-css`)).toBeNull()
    expect(plugin.load(`${ROOT}/S.mesa?mesa-css`)).toBeNull()
  })

  // The option is passed straight through, so this is the honest reading of it:
  // off means the block is compiled and DROPPED, not delivered another way.
  test('css: false drops the block rather than moving it', async () => {
    const { code } = await transform(STYLED, `${ROOT}/S.mesa`, { css: false })

    expect(code).not.toContain('addStyles')
    expect(code).not.toContain('color: red')
    parses(code)
  })
})

// ─── virtual modules ──────────────────────────────────────────────────────────

describe('virtual modules', () => {
  const plugin = () => {
    const p = mesaPlugin()
    p.configResolved({ root: ROOT, command: 'serve' })
    return p
  }

  test('the HMR client id resolves and serves the real client', () => {
    const p       = plugin()
    const id      = '/@frontierjs/mesa-client'
    const resolved = p.resolveId(id)

    expect(resolved).toBe('\0@frontierjs/mesa-client')

    const js = p.load(resolved)
    // The wrapped module imports exactly these two names from it — a client that
    // no longer exports one of them is a ReferenceError on first render.
    expect(js).toContain('export function __mesa_register(')
    expect(js).toContain('export function __mesa_hot_update(')
    parses(js)
  })

  test('the dev client id resolves and serves valid JavaScript', () => {
    const p        = plugin()
    const resolved = p.resolveId('/@frontierjs/mesa-dev-client')

    expect(resolved).toBe('\0@frontierjs/mesa-dev-client')

    const js = p.load(resolved)
    expect(js).toContain("new BroadcastChannel('mesa-devtools')")
    parses(js)
  })

  test('an id the plugin does not own is left alone', () => {
    const p = plugin()
    expect(p.resolveId('/src/main.js')).toBeNull()
    expect(p.load('/src/main.js')).toBeNull()
  })
})

// ─── transformIndexHtml ───────────────────────────────────────────────────────

describe('transformIndexHtml', () => {
  test('injects the dev client in dev', () => {
    const p = mesaPlugin()
    p.configResolved({ root: ROOT, command: 'serve' })

    expect(p.transformIndexHtml()).toContainEqual({
      tag:      'script',
      attrs:    { type: 'module', src: '/@frontierjs/mesa-dev-client' },
      injectTo: 'head',
    })
  })

  test('injects the inspector in dev', () => {
    const p = mesaPlugin()
    p.configResolved({ root: ROOT, command: 'serve' })

    expect(p.transformIndexHtml()).toContainEqual({
      tag:      'script',
      attrs:    { type: 'module', src: '/@frontierjs/mesa-inspect' },
      injectTo: 'head',
    })
  })

  // Off means off at both ends: no client to read the attribute, and the
  // compile below stamps none for it to read.
  test('injects no inspector when it is turned off', () => {
    const p = mesaPlugin({ inspect: false })
    p.configResolved({ root: ROOT, command: 'serve' })

    expect(p.transformIndexHtml().map((t) => t.attrs.src))
      .not.toContain('/@frontierjs/mesa-inspect')
  })

  // The dev client is a BroadcastChannel relay to a devtools page that does not
  // exist in production; injecting it there would ship a dead script and a
  // module the build has to resolve.
  test('injects nothing in a build', () => {
    const p = mesaPlugin()
    p.configResolved({ root: ROOT, command: 'build' })
    expect(p.transformIndexHtml()).toEqual([])
  })
})

// ─── handleHotUpdate ──────────────────────────────────────────────────────────

describe('handleHotUpdate', () => {
  /** A stand-in for the half of the dev server this hook touches. */
  function fakeServer() {
    const invalidated = []
    const sent        = []

    return {
      sent,
      invalidated,
      hot: { send: (m) => sent.push(m) },
      moduleGraph: {
        invalidateModule: (mod) => invalidated.push(mod),
      }
    }
  }

  const hook = (options = {}) => {
    const p = mesaPlugin({ hmr: true, ...options })
    p.configResolved({ root: ROOT, command: 'serve' })
    return p.handleHotUpdate.bind(p)
  }

  test('a file the plugin does not claim is left to Vite', async () => {
    const server = fakeServer()
    const result = await hook()({
      file: `${ROOT}/main.js`, modules: [{ id: 'x' }], read: async () => '', server
    })

    // undefined, not [] — [] means "I handled it, do nothing", which would
    // silence HMR for every non-Mesa file in the project.
    expect(result).toBeUndefined()
    expect(server.invalidated).toHaveLength(0)
  })

  test('a good edit invalidates every affected module and returns them', async () => {
    const server  = fakeServer()
    const modules = [{ id: 'a' }, { id: 'b' }]
    const result  = await hook()({
      file: `${ROOT}/A.mesa`, modules, read: async () => COUNTER, server
    })

    expect(result).toBe(modules)
    expect(server.invalidated).toEqual(modules)
    expect(server.sent).toHaveLength(0)
  })

  // A style edit rides the module: the rules are inlined into it, and
  // `addStyles` keys on a content hash, so an edited block arrives under an id
  // the page has not seen. FJS-291 removed the separate CSS module that used to
  // be invalidated here and never existed to invalidate.
  test('a style edit needs nothing invalidated beyond the module', async () => {
    const server  = fakeServer()
    const modules = [{ id: `${ROOT}/S.mesa` }]

    await hook()({ file: `${ROOT}/S.mesa`, modules, read: async () => STYLED, server })

    expect(server.invalidated).toEqual(modules)
  })

  test('a parse error goes to the overlay and suppresses the update', async () => {
    const server = fakeServer()
    const result = await hook()({
      file:    `${ROOT}/Broken.mesa`,
      modules: [{ id: 'a' }],
      read:    async () => '<script>let a = (</script><p>x</p>',
      server
    })

    // [] rather than the modules: pushing a broken module would remount every
    // instance from source that does not compile.
    expect(result).toEqual([])
    expect(server.invalidated).toHaveLength(0)
    expect(server.sent).toHaveLength(1)
    expect(server.sent[0].type).toBe('error')
    expect(server.sent[0].err.plugin).toBe('mesa')
    expect(server.sent[0].err.id).toBe(`${ROOT}/Broken.mesa`)
    expect(server.sent[0].err.message).toContain('Unexpected token')
  })

  test('falls back to server.ws where server.hot is absent', async () => {
    const server = fakeServer()
    const ws     = { send: (m) => server.sent.push(m) }
    delete server.hot

    await hook()({
      file:    `${ROOT}/Broken.mesa`,
      modules: [],
      read:    async () => '<script>let a = (</script><p>x</p>',
      server:  { ...server, ws }
    })

    expect(server.sent).toHaveLength(1)
    expect(server.sent[0].type).toBe('error')
  })
})
