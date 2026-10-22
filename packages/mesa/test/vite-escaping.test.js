// @vitest-environment node
//
// vite-escaping.test.js
//
// Three places where dev-server output is built out of text nobody in this
// repo wrote — a `.mesa` source, a signal's value, a `data-fjs-loc` — and all
// three used to be assembled by hand, one character class at a time.
//
//   · the dev error module interpolated the compiler's message and the
//     offending source into a TEMPLATE LITERAL, escaping `\` and a backtick
//     and not `${`, so an unclosed tag carrying `${…}` — everyday Mesa markup —
//     was spliced in as a live substitution: the reported error became whatever
//     that expression did, on the origin that also serves `/@fs/` (FJS-861).
//     There is no such module any more (FJS-836): a broken file is RAISED, so
//     the source the compiler quotes crosses as an error payload and is never
//     a program. These cases hold that line — a diagnostic that starts being
//     assembled into code again has to make them fail.
//   · devtools.html's array branch was the one interpolation of eleven that
//     skipped `esc()` (FJS-863).
//   · the inspector took an absolute `data-fjs-loc` verbatim and handed it to
//     `/__open-in-editor`, and exposed `open` on `window` so no gesture was
//     needed at all (FJS-864).
//
// The environment is node: happy-dom's global `URL` makes the plugin's
// `fileURLToPath(new URL(…))` throw.

import { describe, test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import mesaPlugin from '../mesa-vite/index.js'
import { inspectClientSource } from '../mesa-vite/inspect-client.js'

// `this.error` throws in Rollup, and the plugin relies on that: everything
// after the call is dead. A stub that returns instead lets the transform run on
// and report a module the real server would never have built.
async function transform(source, id = '/t/T.mesa') {
  const plugin = mesaPlugin({ hmr: false })
  plugin.configResolved({ root: '/t', command: 'serve' })
  const raised = []
  const self = {
    error: (e) => { raised.push(e); throw Object.assign(new Error(e.message), e) },
    warn:  () => {}
  }
  try {
    const out = await plugin.transform.call(self, source, id)
    return { code: out?.code ?? null, raised }
  } catch {
    return { code: null, raised }
  }
}

// ─── FJS-861 · the dev error module ───────────────────────────────────

describe('a broken file is raised, never assembled into a program', () => {

  // An unclosed tag: the compiler throws and sets `details` to the open tag
  // verbatim, which is what reaches the error payload.
  const UNCLOSED = '<script>let a = 1</script>\n<div data-x="${globalThis.__pwned = 1}">\n<p>hi</p>\n'

  test('a `${` in an unclosed tag is reported, not evaluated', async () => {
    globalThis.__pwned = 0
    const { code, raised } = await transform(UNCLOSED)
    const ran = globalThis.__pwned
    delete globalThis.__pwned

    // Nothing is emitted at all — the module body that used to carry this text
    // was never reached anyway: every importer writes `import X from './X.mesa'`
    // and the linker rejects a module with no `default` before it runs.
    expect(code).toBeNull()
    expect(ran).toBe(0)
    expect(raised).toHaveLength(1)
    expect(raised[0].plugin).toBe('mesa')
    expect(raised[0].id).toBe('/t/T.mesa')
    // The frame is REPORTED: the developer still sees the tag to go and close.
    expect(raised[0].frame).toContain('${globalThis.__pwned = 1}')
  })

  test('an analysis error quoting `${` is reported, not evaluated', async () => {
    // `$: { (a, b) }` is an inert reactive block — a diagnostic the compiler
    // collects rather than throws — and the message quotes the source.
    globalThis.__pwned = 0
    const { code, raised } = await transform(
      '<script>\nlet a = 1, b = 2\n$: { (a, b) }\n</script><p>{a}</p>',
      '/t/${globalThis.__pwned = 1}.mesa')
    const ran = globalThis.__pwned
    delete globalThis.__pwned

    expect(code).toBeNull()
    expect(ran).toBe(0)
    expect(raised[0].message).toContain('error(s) in')
    expect(raised[0].message).toContain('${globalThis.__pwned = 1}.mesa')
  })

  test('a backtick in a diagnostic crosses verbatim', async () => {
    const { raised } = await transform(
      '<script>\nlet a = 1, b = 2\n$: { (a, b) }\n</script><p>{a}</p>', '/t/We`ird.mesa')
    expect(raised[0].message).toContain('We`ird.mesa')
    // `stack` is not optional: Vite's overlay runs a regex over it, and an
    // absent one throws inside the overlay's own constructor, so the report
    // becomes nothing whatsoever.
    expect(typeof raised[0].stack).toBe('string')
  })
})

// ─── FJS-863 · the devtools page ──────────────────────────────────────

// devtools.html is served as an asset and nothing in the suite executes its
// script, so the script body is evaluated here against stubs for the three
// globals it touches. What this cannot reach is the page as a PAGE — that it
// renders, that the tabs work — which stays the browser drive's half.
function devtoolsRender() {
  const html = readFileSync(fileURLToPath(new URL('../mesa-vite/devtools.html', import.meta.url)), 'utf8')
  const body = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>'))
  const el = { addEventListener: () => {}, textContent: '', innerHTML: '', style: {}, classList: { toggle: () => {} }, dataset: {} }
  const document = { getElementById: () => el, querySelectorAll: () => [] }
  class BroadcastChannel { postMessage() {} close() {} }
  const setInterval = () => 0
  return new Function('document', 'BroadcastChannel', 'setInterval',
    body + '\nreturn { renderValue, flatValue, esc }')(document, BroadcastChannel, setInterval)
}

describe('the devtools page escapes every value it renders', () => {
  const { renderValue } = devtoolsRender()

  test('an array member is markup nowhere', () => {
    const out = renderValue(['<img src=x onerror="pwn()">'])
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
  })

  test('the sibling branches are unchanged', () => {
    expect(renderValue('<b>')).toContain('&lt;b&gt;')
    expect(renderValue({ a: '<b>' })).not.toContain('<b>')
    expect(renderValue(1)).toBe('<span class="num">1</span>')
    expect(renderValue(['a', 'b'])).toContain('[a, b]')
  })
})

// ─── FJS-864 · the inspector's editor fence ───────────────────────────

// inspect-client.js is a STRING the plugin serves at a virtual id (Sierra's
// plugin serves the same source at an id of its own), so nothing imports it as
// a module. It is run here in a fake window that records its listeners and its
// fetches, which reaches the click path and the global it publishes; what it
// cannot reach is a real pointer over a real overlay, which is the browser
// drive's `inspect.spec.mjs`.
function runInspector(root = '/app') {
  const listeners = new Map()
  const fetched = []
  const warned = []
  const window = {
    addEventListener: (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(fn)
    }
  }
  const node = () => ({ style: { cssText: '' }, appendChild: () => {}, textContent: '', getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }) })
  const document = { documentElement: { style: {} }, activeElement: null, body: { appendChild: () => {} }, createElement: node }
  const fetch = (url) => { fetched.push(url); return Promise.resolve() }
  const console = { log: () => {}, warn: (...a) => warned.push(a.join(' ')) }
  new Function('window', 'document', 'fetch', 'console',
    inspectClientSource({ root }))(window, document, fetch, console)

  // A list of locations is a chain, innermost first: each is the next one's
  // child. A link written { loc, placed: [...] } is followed by component
  // anchors, each carrying where it was placed.
  const anchors = (placed) => placed.reduceRight((next, at) => ({ nodeType: 8, __fjsPlaced: at, nextSibling: next }), null)
  const element = (link, parentElement = null) => ({
    nodeType: 1,
    hasAttribute: (n) => n === 'data-fjs-loc',
    getAttribute: (n) => (n === 'data-fjs-loc' ? link.loc ?? link : null),
    parentElement,
    nextSibling: anchors(link.placed ?? []),
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
  })
  const swallowed = []
  const altClick = (loc, { shiftKey = false } = {}) => {
    const el = [loc].flat().reduceRight((parent, l) => element(l, parent), null)
    const ev = { type: 'click', altKey: true, shiftKey, preventDefault: () => swallowed.push(ev), stopPropagation: () => {}, composedPath: () => [el] }
    for (const fn of listeners.get('mousemove')) fn({ ...ev, type: 'mousemove' })
    for (const fn of listeners.get('click')) fn(ev)
  }
  // Alt+Z with focus on a located element; `answer` stands for a page handler
  // that runs after the inspector's capture listener.
  const altZ = async (loc, answer) => {
    document.activeElement = element(loc)
    const ev = { type: 'keydown', key: 'z', altKey: true, defaultPrevented: false, preventDefault: () => { ev.defaultPrevented = true } }
    for (const fn of listeners.get('keydown')) fn(ev)
    answer?.(ev)
    await new Promise((r) => setTimeout(r, 0))
  }
  return { window, fetched, warned, swallowed, altClick, altZ }
}

const opened = (loc) => '/__open-in-editor?file=' + encodeURIComponent('/app/' + loc)

describe('the inspector only ever asks the editor for a file under the root', () => {

  // FJS-3408
  test('Alt+Z opens the focused element, unless the page answered the key first', async () => {
    const i = runInspector()
    await i.altZ('src/pages/Home.mesa:12:3')
    expect(i.fetched).toEqual([opened('src/pages/Home.mesa:12:3')])
    const j = runInspector()
    await j.altZ('src/pages/Home.mesa:12:3', (e) => e.preventDefault())
    expect(j.fetched).toEqual([])
  })

  test('a stamped location is joined onto the root', () => {
    const i = runInspector()
    i.altClick('src/pages/Home.mesa:12:3')
    expect(i.fetched).toEqual(['/__open-in-editor?file=' + encodeURIComponent('/app/src/pages/Home.mesa:12:3')])
  })

  test('a planted absolute path is refused, and the click goes to the page', () => {
    const i = runInspector()
    i.altClick('/etc/shadow:1:1')
    expect(i.fetched).toEqual([])
    expect(i.swallowed).toEqual([])
  })

  test('traversal out of the root is refused', () => {
    const i = runInspector()
    i.altClick('../../etc/shadow.mesa:1:1')
    expect(i.fetched).toEqual([])
  })

  test('an absolute path to a compiled source is refused, not joined onto the root', () => {
    const i = runInspector()
    i.altClick('/home/me/packages/ui/src/Button.mesa:3:1')
    expect(i.fetched).toEqual([])
  })

  test('a location naming something that is not a compiled source is refused', () => {
    const i = runInspector()
    i.altClick('src/secrets.env:1:1')
    i.altClick('src/App.mesa')
    expect(i.fetched).toEqual([])
  })

  test("a package's component under the pointer gives way to the app's element around it", () => {
    const i = runInspector()
    i.altClick(['/home/me/packages/ui/src/Button.mesa:3:1', 'src/pages/Home.mesa:12:3'])
    i.altClick(['node_modules/@frontierjs/ui/src/Button.mesa:3:1', 'src/pages/Home.mesa:14:5'])
    expect(i.fetched).toEqual([
      '/__open-in-editor?file=' + encodeURIComponent('/app/src/pages/Home.mesa:12:3'),
      '/__open-in-editor?file=' + encodeURIComponent('/app/src/pages/Home.mesa:14:5'),
    ])
  })

  test("the app's own element inside a package's component is still the one picked", () => {
    const i = runInspector()
    i.altClick(['src/pages/Home.mesa:13:7', 'node_modules/@frontierjs/ui/src/Card.mesa:2:1', 'src/pages/Home.mesa:12:3'])
    expect(i.fetched).toEqual(['/__open-in-editor?file=' + encodeURIComponent('/app/src/pages/Home.mesa:13:7')])
  })

  test("with no app element around it, an unscoped package's file still opens", () => {
    const i = runInspector()
    i.altClick('node_modules/some-kit/src/Shell.mesa:4:2')
    expect(i.fetched).toEqual(['/__open-in-editor?file=' + encodeURIComponent('/app/node_modules/some-kit/src/Shell.mesa:4:2')])
  })

  // FJS-3332: Shell's topbar has no app element above it, because the app's
  // page renders inside the layout rather than around it.
  test("a package's chrome opens the app line that placed the component", () => {
    const i = runInspector()
    const SHELL = '/home/me/packages/ui/src/Shell.mesa'
    i.altClick([`${SHELL}:235:7`, { loc: `${SHELL}:230:3`, placed: ['src/routes/_module.mesa:83:1'] }])
    expect(i.fetched).toEqual([opened('src/routes/_module.mesa:83:1')])
  })

  test('a component the package placed is passed over for the one the app placed', () => {
    const i = runInspector()
    const SHELL = '/home/me/packages/ui/src/Shell.mesa'
    i.altClick([{ loc: `${SHELL}:235:7`, placed: [`${SHELL}:236:5`] }, { loc: `${SHELL}:230:3`, placed: ['src/routes/_module.mesa:83:1'] }])
    expect(i.fetched).toEqual([opened('src/routes/_module.mesa:83:1')])
  })

  test('the placing line outranks an installed copy of the package', () => {
    const i = runInspector()
    i.altClick({ loc: 'node_modules/some-kit/src/Shell.mesa:4:2', placed: ['src/routes/_module.mesa:9:1'] })
    expect(i.fetched).toEqual([opened('src/routes/_module.mesa:9:1')])
  })

  test('a pick of package chrome names the package file it came from', () => {
    const i = runInspector()
    const got = []
    i.window.__fjsInspect.onPick(p => got.push(p))
    i.altClick({ loc: '/home/me/packages/ui/src/Shell.mesa:235:7', placed: ['src/routes/_module.mesa:83:1'] }, { shiftKey: true })
    expect(got[0].loc).toBe('src/routes/_module.mesa:83:1')
    expect(got[0].via).toBe('/home/me/packages/ui/src/Shell.mesa:235:7')
  })

  test("a package's chrome nothing in the app placed is not picked at all", () => {
    const i = runInspector()
    i.altClick('/home/me/packages/ui/src/Shell.mesa:235:7')
    expect(i.fetched).toEqual([])
    expect(i.swallowed).toEqual([])
  })

  test('`open` is not on the global — a page script would need no gesture', () => {
    const i = runInspector()
    expect(i.window.__fjsInspect.open).toBeUndefined()
    expect(typeof i.window.__fjsInspect.locate).toBe('function')
    expect(i.window.__fjsInspect.root).toBe('/app')
  })

  test('a pick carries the modifier and an opener bound to what was picked', () => {
    const i = runInspector()
    const got = []
    i.window.__fjsInspect.onPick(p => got.push(p))
    i.altClick('src/pages/Home.mesa:12:3', { shiftKey: true })
    expect(i.fetched).toEqual([])
    expect(got[0].key).toBe('alt')
    got[0].open()
    expect(i.fetched).toEqual(['/__open-in-editor?file=' + encodeURIComponent('/app/src/pages/Home.mesa:12:3')])
  })
})

describe('`locRoot` moves what a location is relative to, off the Vite root', () => {

  // A tool served from its own root (Haven's scene editor) over sources beside
  // it: against the Vite root every stamp is a `../` path the inspector refuses.
  test('the stamp and the inspector both take it', async () => {
    const plugin = mesaPlugin({ hmr: false, locRoot: '/t/web/src' })
    plugin.configResolved({ root: '/t/editor', command: 'serve' })
    const out = await plugin.transform.call({ error: (e) => { throw e }, warn: () => {} }, '<p>hi</p>\n', '/t/web/src/scenes/Square.mesa')
    expect(out.code).toContain('data-fjs-loc="scenes/Square.mesa:1:1"')
    expect(plugin.load('\0@frontierjs/mesa-inspect')).toContain('const ROOT = "/t/web/src"')
  })
})
