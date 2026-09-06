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

  const element = (loc) => ({
    nodeType: 1,
    hasAttribute: (n) => n === 'data-fjs-loc',
    getAttribute: (n) => (n === 'data-fjs-loc' ? loc : null),
    parentElement: null,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 })
  })
  const altClick = (loc) => {
    const el = element(loc)
    const ev = { type: 'click', altKey: true, preventDefault: () => {}, stopPropagation: () => {}, composedPath: () => [el] }
    for (const fn of listeners.get('mousemove')) fn({ ...ev, type: 'mousemove' })
    for (const fn of listeners.get('click')) fn(ev)
  }
  return { window, fetched, warned, altClick }
}

describe('the inspector only ever asks the editor for a file under the root', () => {

  test('a stamped location is joined onto the root', () => {
    const i = runInspector()
    i.altClick('src/pages/Home.mesa:12:3')
    expect(i.fetched).toEqual(['/__open-in-editor?file=' + encodeURIComponent('/app/src/pages/Home.mesa:12:3')])
  })

  test('a planted absolute path is refused', () => {
    const i = runInspector()
    i.altClick('/etc/shadow:1:1')
    expect(i.fetched).toEqual([])
    expect(i.warned.join(' ')).toContain('refusing to open')
  })

  test('traversal out of the root is refused', () => {
    const i = runInspector()
    i.altClick('../../etc/shadow.mesa:1:1')
    expect(i.fetched).toEqual([])
  })

  test('a location naming something that is not a compiled source is refused', () => {
    const i = runInspector()
    i.altClick('src/secrets.env:1:1')
    i.altClick('src/App.mesa')
    expect(i.fetched).toEqual([])
  })

  test('`open` is not on the global — a page script would need no gesture', () => {
    const i = runInspector()
    expect(i.window.__fjsInspect.open).toBeUndefined()
    expect(typeof i.window.__fjsInspect.locate).toBe('function')
    expect(i.window.__fjsInspect.root).toBe('/app')
  })
})
