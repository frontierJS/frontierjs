/**
 * tests/islands.test.js — the island pipeline, end of Mesa's SSR_SPEC W3.
 *
 * Mesa marks `client:*` components in SSR output; this is the half that turns a
 * marker into a mounted component. Before it, `sierraContext.islandMap` was
 * populated during transform and read by nothing, and a `target: 'static'` page
 * shipped no script at all — so every prerendered page was permanently inert.
 *
 * The end-to-end proof is not here and cannot be: it needs a real build and a
 * real browser. `tests/fixtures/island-site/` is that app, and the check is a
 * click on a prerendered button in headless Chrome. These cover the pieces.
 */

import { describe, test, expect, beforeAll, afterEach, vi } from 'vitest'
import { resolve, dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'

import { islandEntrySource, injectIslandScript, injectIntoPages } from '../src/build/island-bundle.js'
import { prerenderRoutes } from '../src/build/prerender.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ── The generated entry ───────────────────────────────────────────────────────

describe('islandEntrySource', () => {
  test('registers each island under the name its marker carries, as a lazy import', () => {
    const src = islandEntrySource([
      { component: 'Counter', module: '/app/src/islands/Counter.mesa' },
      { component: 'Later',   module: '/app/src/islands/Later.mesa' },
    ])
    // Dynamic, not static: the chunk for an island must not be fetched until
    // its directive fires, which is what makes client:visible worth declaring.
    expect(src).toContain(`"Counter": () => import("/app/src/islands/Counter.mesa")`)
    expect(src).toContain(`"Later": () => import("/app/src/islands/Later.mesa")`)
    expect(src).not.toMatch(/^import \S+ from "\/app/m)
    expect(src).toContain('hydrateIslands(registry)')
    expect(src).toContain(`from "@frontierjs/sierra/islands"`)
  })

  test('quotes component names that are not bare identifiers', () => {
    // The registry is keyed by the name a marker carries, which is whatever the
    // component was imported as — it never has to be a valid identifier here,
    // because it is a string key and an arrow function, not a binding.
    const src = islandEntrySource([
      { component: 'My-Widget', module: '/a.mesa' },
      { component: 'My.Widget', module: '/b.mesa' },
    ])
    expect(src).toContain(`"My-Widget": () => import("/a.mesa")`)
    expect(src).toContain(`"My.Widget": () => import("/b.mesa")`)
  })
})

// ── Script injection ──────────────────────────────────────────────────────────

describe('injectIslandScript', () => {
  test('inserts a module script before </body>', () => {
    const out = injectIslandScript('<html><body><p>x</p></body></html>', '/assets/i.js')
    expect(out).toContain('<script type="module" src="/assets/i.js"></script>')
    expect(out.indexOf('/assets/i.js')).toBeLessThan(out.indexOf('</body>'))
  })

  test('is idempotent — rebuilding over an existing output cannot stack tags', () => {
    const once  = injectIslandScript('<html><body></body></html>', '/assets/i.js')
    const twice = injectIslandScript(once, '/assets/i.js')
    expect(twice).toBe(once)
    expect(twice.match(/assets\/i\.js/g)).toHaveLength(1)
  })

  test('appends when there is no </body> rather than dropping the script', () => {
    const out = injectIslandScript('<p>fragment</p>', '/assets/i.js')
    expect(out).toContain('/assets/i.js')
  })
})

describe('injectIntoPages', () => {
  test('only touches pages that actually have an island', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sierra-islands-'))
    mkdirSync(join(dir, 'plain'), { recursive: true })
    writeFileSync(join(dir, 'index.html'), '<html><body>has island</body></html>')
    writeFileSync(join(dir, 'plain', 'index.html'), '<html><body>no island</body></html>')

    const pages = new Map([
      ['index.html', new Set(['Counter'])],
      ['plain/index.html', new Set()],
    ])
    const touched = await injectIntoPages(dir, pages, '/assets/i.js')

    expect(touched).toEqual(['index.html'])
    // The whole point of islands: a page with no interactive component ships
    // no JavaScript at all.
    expect(readFileSync(join(dir, 'plain', 'index.html'), 'utf8')).not.toContain('script')
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('/assets/i.js')
  })
})

// ── Collection during prerender ───────────────────────────────────────────────

describe('prerenderRoutes — island collection', () => {
  /** Minimal fake renderer: returns whatever islands the test declares. */
  function fakeRenderer(islands) {
    return async () => ({ html: '<p>page</p>', css: '', islands, exports: {} })
  }

  function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'sierra-prerender-'))
    mkdirSync(join(root, 'src/routes'), { recursive: true })
    writeFileSync(join(root, 'src/routes/index.mesa'), '---\nrender: static\n---\n<p>x</p>')
    return root
  }

  const tree = (root) => ({
    id: '/', path: '/', file: 'src/routes/index.mesa',
    meta: { render: 'static' }, children: [],
  })

  test('resolves a component name to a module through the import specifier', async () => {
    const root = fixture()
    const res = await prerenderRoutes({
      tree: tree(root), root, outDir: 'dist',
      renderComponent: fakeRenderer([
        { component: 'Counter', directive: 'load',
          specifier: '../islands/Counter.mesa',
          file: join(root, 'src/routes/__prerender__.mesa') },
      ]),
    })

    expect(res.islands).toEqual([
      { component: 'Counter', module: join(root, 'src/islands/Counter.mesa') },
    ])
    expect([...res.islandPages.get('index.html')]).toEqual(['Counter'])
  })

  test('warns and skips an island with no specifier instead of emitting an unbundlable entry', async () => {
    const root = fixture()
    const warn = vi.fn()
    const res = await prerenderRoutes({
      tree: tree(root), root, outDir: 'dist', warn,
      renderComponent: fakeRenderer([{ component: 'Ghost', directive: 'load' }]),
    })

    expect(res.islands).toEqual([])
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Ghost.*no import specifier/s)
  })

  test('warns when one name maps to two modules — a marker carries only the name', async () => {
    const root = fixture()
    const warn = vi.fn()
    const here = join(root, 'src/routes/__prerender__.mesa')
    const res = await prerenderRoutes({
      tree: tree(root), root, outDir: 'dist', warn,
      renderComponent: fakeRenderer([
        { component: 'Box', directive: 'load', specifier: '../a/Box.mesa', file: here },
        { component: 'Box', directive: 'load', specifier: '../b/Box.mesa', file: here },
      ]),
    })

    expect(res.islands).toHaveLength(1)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/two different modules.*Box/s)
  })

  test('reports no islands when a page has none', async () => {
    const root = fixture()
    const res = await prerenderRoutes({
      tree: tree(root), root, outDir: 'dist', renderComponent: fakeRenderer([]),
    })
    expect(res.islands).toEqual([])
    expect(res.islandPages.size).toBe(0)
  })
})

// ── The loader ────────────────────────────────────────────────────────────────

describe('island loader', () => {
  let loader, mesa, win

  beforeAll(async () => {
    const { Window } = await import('happy-dom')
    win = new Window({ url: 'http://localhost' })
    // ShadowRoot is not optional: `mount` evaluates `option?.root instanceof
    // ShadowRoot` unconditionally, so a missing global is a ReferenceError
    // inside mount rather than a falsy check. Browsers define it; a bare Node
    // process does not.
    for (const k of ['document', 'window', 'Node', 'Element', 'HTMLElement', 'Comment',
                     'Text', 'DocumentFragment', 'CustomEvent', 'Event', 'NodeFilter',
                     'MutationObserver', 'getComputedStyle', 'ShadowRoot',
                     'IntersectionObserver', 'matchMedia']) {
      const v = win[k]
      if (v !== undefined) globalThis[k] = v
    }
    mesa = await import('@frontierjs/mesa/runtime.js')
    // The runtime decides `_isBrowser` at import time from `typeof document`,
    // and this suite runs under vitest's `node` environment. Say so explicitly
    // rather than depending on import order.
    mesa.setRenderEnvironment(true, true)
    loader = await import('../src/islands/loader.js')
  })

  afterEach(() => { win.document.body.innerHTML = '' })

  const marker = (meta, inner) =>
    `<!--mesa-island ${JSON.stringify(meta)}-->${inner}<!--/mesa-island-->`

  test('finds an island and its prerendered nodes', () => {
    win.document.body.innerHTML =
      `<main><p>static</p>${marker({ component: 'C', directive: 'load', props: { n: 1 } }, '<button>1</button>')}</main>`

    const found = loader.findIslands(win.document.body)
    expect(found).toHaveLength(1)
    expect(found[0].meta).toEqual({ component: 'C', directive: 'load', props: { n: 1 } })
    expect(found[0].nodes.map((n) => n.outerHTML)).toEqual(['<button>1</button>'])
  })

  test('finds nested islands, innermost first, and links each to its parent', () => {
    win.document.body.innerHTML = marker({ component: 'Outer', directive: 'load' },
      `<div>${marker({ component: 'Inner', directive: 'idle' }, '<b>i</b>')}</div>`)

    const found = loader.findIslands(win.document.body)
    expect(found.map((i) => i.meta.component)).toEqual(['Inner', 'Outer'])
    // Nesting is the client's only way to know an island is already covered by
    // an ancestor — a marker records a component, not a position in a tree.
    expect(found[0].parent).toBe(found[1])
    expect(found[1].parent).toBe(null)
  })

  test('skips an unreadable marker and keeps the rest of the page', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    win.document.body.innerHTML =
      `<!--mesa-island {not json-->` +
      marker({ component: 'Good', directive: 'load' }, '<i>ok</i>')

    const found = loader.findIslands(win.document.body)
    expect(found.map((i) => i.meta.component)).toEqual(['Good'])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  test('client:static never mounts — it means "no JS even if reactive"', () => {
    const fn = vi.fn()
    loader.schedule('static', undefined, win.document.body, fn)
    expect(fn).not.toHaveBeenCalled()
  })

  test('client:load mounts immediately', () => {
    const fn = vi.fn()
    loader.schedule('load', undefined, win.document.body, fn)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  test('an unknown directive mounts rather than stranding the island', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fn = vi.fn()
    loader.schedule('nonsense', undefined, win.document.body, fn)
    expect(fn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('hydrateIslands reports an unregistered component loudly and leaves it inert', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    win.document.body.innerHTML = marker({ component: 'Missing', directive: 'load' }, '<b>x</b>')

    const scheduled = loader.hydrateIslands({}, { root: win.document.body })
    expect(scheduled).toEqual([])
    // The markup is still there — which is exactly why this has to be loud. An
    // unmounted island looks correct and does nothing.
    expect(win.document.body.innerHTML).toContain('<b>x</b>')
    expect(err.mock.calls.flat().join(' ')).toMatch(/no component registered for "Missing"/)
    err.mockRestore()
  })

  test('mounting replaces the prerendered markup with a live component', async () => {
    win.document.body.innerHTML =
      `<main>${marker({ component: 'C', directive: 'load', props: { start: 5 } }, '<button>stale</button>')}</main>`

    // A hand-written stand-in for a compiled Mesa component: append before the
    // anchor, which is the calling convention the compiler emits.
    const Component = (anchor, props) => {
      const b = win.document.createElement('button')
      b.textContent = `live:${props.start}`
      anchor.before(b)
    }

    const scheduled = loader.hydrateIslands({ C: Component }, { root: win.document.body })
    expect(scheduled).toEqual([{ component: 'C', directive: 'load' }])

    // Mounting is async even for an eager registry entry — the loader awaits
    // resolveComponent so that a lazy chunk and a plain component take the same
    // path. Scheduling is what returns synchronously.
    await new Promise((r) => setTimeout(r, 0))
    expect(win.document.body.innerHTML).toContain('live:5')
    expect(win.document.body.innerHTML).not.toContain('stale')
  })

  test('a lazy registry entry is not called until its directive fires', async () => {
    win.document.body.innerHTML =
      marker({ component: 'C', directive: 'static' }, '<b>prerendered</b>')

    let fetches = 0
    const entry = () => { fetches++; return Promise.resolve({ default: () => {} }) }

    loader.hydrateIslands({ C: entry }, { root: win.document.body })
    await new Promise((r) => setTimeout(r, 0))

    // client:static never mounts, so its chunk must never be requested — that
    // is the whole economic argument for splitting per island.
    expect(fetches).toBe(0)
    expect(win.document.body.innerHTML).toContain('prerendered')
  })

  test('resolveComponent tells a component from an import thunk by arity', async () => {
    const component = (anchor, props, block) => {}          // length 3
    expect(await loader.resolveComponent(component)).toBe(component)

    // A thunk takes no arguments and yields a module or a component.
    const viaModule = await loader.resolveComponent(() => Promise.resolve({ default: component }))
    expect(viaModule).toBe(component)
    const viaBare = await loader.resolveComponent(() => Promise.resolve(component))
    expect(viaBare).toBe(component)
  })

  // ── Nested islands ──────────────────────────────────────────────────────────
  //
  // On the client there is no nesting to honour: Mesa's island() short-circuits
  // when it is already on the client, so an outer island's render calls the
  // inner component directly. An ancestor's mount is therefore authoritative,
  // and these pin the three places this file defers to it.

  /** A stand-in for a compiled component: appends `<b id=…>` before the anchor. */
  const stub = (id) => (anchor) => {
    const b = win.document.createElement('b')
    b.id = id
    b.textContent = `live:${id}`
    anchor.before(b)
  }

  test('an island whose ancestor already mounted is skipped, not reported as failed', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    win.document.body.innerHTML = `<main>${
      marker({ component: 'Outer', directive: 'load' },
        `<div>${marker({ component: 'Inner', directive: 'idle' }, '<b>i</b>')}</div>`)
    }</main>`

    let innerFetches = 0
    const registry = {
      Outer: stub('outer'),
      // A lazy entry, like the build emits. It must not even be requested: the
      // component is already live inside Outer's render.
      Inner: () => { innerFetches++; return Promise.resolve({ default: stub('inner') }) },
    }
    loader.hydrateIslands(registry, { root: win.document.body })
    await new Promise((r) => setTimeout(r, 20))   // let client:idle come round

    expect(win.document.body.innerHTML).toContain('live:outer')
    expect(innerFetches).toBe(0)
    // The old failure mode: mount() throws on a detached anchor and the catch
    // logs a load failure for an island that is working perfectly.
    expect(err).not.toHaveBeenCalled()
    err.mockRestore()
  })

  test('an ancestor mounting over a live descendant removes and disposes it', () => {
    win.document.body.innerHTML = `<main>${
      marker({ component: 'Outer', directive: 'load' },
        `<div>${marker({ component: 'Inner', directive: 'load' }, '<b>i</b>')}</div>`)
    }</main>`

    const [inner, outer] = loader.findIslands(win.document.body)

    // Inner wins the race — client:load inside client:idle, or just scheduling
    // order. Its prerendered markup is replaced by a live render.
    loader.mountIsland(inner, stub('inner'))
    expect(win.document.body.innerHTML).toContain('live:inner')

    // Now the ancestor mounts. It must clear the range as it stands NOW: the
    // scan-time list no longer describes the page, so removing that would leave
    // the descendant's live nodes beside Outer's fresh render.
    loader.mountIsland(outer, stub('outer'))
    expect(win.document.body.querySelectorAll('#inner')).toHaveLength(0)
    expect(win.document.body.querySelectorAll('#outer')).toHaveLength(1)
  })

  test('mountIsland on detached markers returns null instead of throwing', () => {
    win.document.body.innerHTML = marker({ component: 'C', directive: 'load' }, '<b>x</b>')
    const [island] = loader.findIslands(win.document.body)
    win.document.body.innerHTML = ''
    // mount() throws on an anchor with no parentNode. That is the right error
    // for a caller mounting into nowhere and the wrong one here, where a
    // vanished marker means an ancestor did the work.
    expect(loader.mountIsland(island, stub('c'))).toBe(null)
  })

  test('client:static under a live ancestor warns — it cannot be honoured', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    win.document.body.innerHTML = marker({ component: 'Outer', directive: 'load' },
      `<div>${marker({ component: 'Frozen', directive: 'static' }, '<b>f</b>')}</div>`)

    loader.hydrateIslands({ Outer: stub('outer'), Frozen: stub('frozen') },
      { root: win.document.body })

    expect(warn.mock.calls.flat().join(' ')).toMatch(/Frozen.*client:static inside <Outer>/s)
    warn.mockRestore()
  })

  test('a static ancestor leaves its descendants to mount themselves', async () => {
    // client:static is the one directive that never mounts, so it is the one
    // ancestor that does not subsume what is inside it.
    win.document.body.innerHTML = marker({ component: 'Frozen', directive: 'static' },
      `<div>${marker({ component: 'Live', directive: 'load' }, '<b>l</b>')}</div>`)

    loader.hydrateIslands({ Frozen: stub('frozen'), Live: stub('live') },
      { root: win.document.body })
    await new Promise((r) => setTimeout(r, 0))

    expect(win.document.body.innerHTML).toContain('live:live')
    expect(win.document.body.innerHTML).not.toContain('live:frozen')
  })

  test('a chunk that fails to load leaves the island as prerendered, loudly', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    win.document.body.innerHTML =
      marker({ component: 'C', directive: 'load' }, '<b>prerendered</b>')

    loader.hydrateIslands({ C: () => Promise.reject(new Error('network')) }, { root: win.document.body })
    await new Promise((r) => setTimeout(r, 0))

    expect(win.document.body.innerHTML).toContain('prerendered')
    expect(err.mock.calls.flat().join(' ')).toMatch(/failed to load or mount/)
    err.mockRestore()
  })
})
