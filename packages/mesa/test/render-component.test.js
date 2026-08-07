/**
 * render-component.test.js
 *
 * Run: npx vitest run render-component.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, unlink, mkdir, readdir } from 'fs/promises'
import { existsSync, rmSync } from 'fs'
import path from 'path'
import { renderComponent, renderFile } from '../src/render-component.js'
import { initRenderer } from '../src/render.js'

// ── Test fixtures directory ───────────────────────────────────────────────────
const FIXTURES = path.join('/tmp', 'mesa-render-test-' + Date.now())

beforeAll(async () => {
  await mkdir(FIXTURES, { recursive: true })
  // copy package.json so @frontierjs/mesa resolves from the fixture dir
  // by symlinking node_modules — simplest: write fixtures into /tmp/mesa directly
})

afterAll(async () => {
  // Cleanup fixture files
  const files = ['Badge.mesa', 'Card.mesa', 'Email.mesa', 'Static.mesa', 'WithStore.mesa']
  for (const f of files) {
    try { await unlink(path.join('/tmp/mesa', f)) } catch {}
  }
})

// Write a fixture file into /tmp/mesa so @frontierjs/mesa resolves
async function fixture(name, content) {
  const p = path.join('/tmp/mesa', name)
  await writeFile(p, content)
  return p
}

// ── Basic rendering ───────────────────────────────────────────────────────────

describe('renderComponent — target: html', () => {
  it('renders a simple component with props', async () => {
    const result = await renderComponent(
      `<script>export let name = 'World'</script><h1>Hello {name}</h1>`,
      { data: { name: 'Mesa' }, cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('Hello Mesa')
    expect(result.html).toContain('<h1>')
  })

  it('renders conditional block', async () => {
    const result = await renderComponent(
      `<script>export let show = false</script>{#if show}<p>visible</p>{/if}`,
      { data: { show: true }, cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('visible')
  })

  it('renders each block', async () => {
    const result = await renderComponent(
      `<script>export let items = []</script><ul>{#each items as item}<li>{item}</li>{/each}</ul>`,
      { data: { items: ['a', 'b', 'c'] }, cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('<li>a</li>')
    expect(result.html).toContain('<li>b</li>')
    expect(result.html).toContain('<li>c</li>')
  })

  it('returns css from <style> block', async () => {
    const result = await renderComponent(
      `<p class="x">text</p><style>.x { color: red; }</style>`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.css).toContain('color')
    expect(result.html).toContain('<style>')
  })

  it('result.exports contains named exports', async () => {
    const result = await renderComponent(
      `<script module>export const title = 'My Page'</script><p>hi</p>`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.exports.title).toBe('My Page')
  })

  it('result.subject is extracted from export const subject', async () => {
    const result = await renderComponent(
      `<script module>export const subject = 'Welcome, Alice!'</script><script>export let name = ''</script><p>hi</p>`,
      { data: { name: 'Alice' }, cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.subject).toBe('Welcome, Alice!')
  })
})

// ── Import resolution ─────────────────────────────────────────────────────────

describe('renderComponent — import resolution', () => {
  it('resolves and renders a child component', async () => {
    await fixture('Badge.mesa', `<script>export let label = 'OK'</script><span class="badge">{label}</span>`)

    const result = await renderComponent(
      `<script>import Badge from './Badge.mesa'</script><Badge label="works" />`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('works')
    expect(result.html).toContain('badge')
  })

  it('resolves a two-level deep import chain', async () => {
    await fixture('Badge.mesa', `<script>export let label = 'OK'</script><span class="badge">{label}</span>`)
    await fixture('Card.mesa',  `<script>import Badge from './Badge.mesa'\nexport let heading = ''</script><div class="card"><h2>{heading}</h2><Badge label="inner" /></div>`)

    const result = await renderComponent(
      `<script>import Card from './Card.mesa'</script><Card heading="Test" />`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.html).toContain('Test')
    expect(result.html).toContain('inner')
    expect(result.html).toContain('card')
  })

  it('collects CSS from all files in the tree', async () => {
    await fixture('Badge.mesa', `<span class="badge">ok</span><style>.badge { background: teal; }</style>`)

    const result = await renderComponent(
      `<script>import Badge from './Badge.mesa'</script><div class="wrap"><Badge /></div><style>.wrap { padding: 16px; }</style>`,
      { cwd: '/tmp/mesa', target: 'html' }
    )
    expect(result.css).toContain('background')
    expect(result.css).toContain('padding')
  })
})

// ── Email target ──────────────────────────────────────────────────────────────

describe('renderComponent — target: email', () => {
  it('inlines CSS into style attributes', async () => {
    const result = await renderComponent(
      `<p class="greeting">Hello</p><style>.greeting { color: #ee380d; font-size: 16px; }</style>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.html).toContain('color:#ee380d')
    expect(result.html).toContain('font-size:16px')
    expect(result.html).not.toContain('<style>')
  })

  it('resolves CSS variables before inlining', async () => {
    const result = await renderComponent(
      `<p class="btn">Click</p><style>:root{--brand:#ee380d} .btn{background:var(--brand)}</style>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.html).toContain('background:#ee380d')
  })

  it('produces a plain text fallback in result.text', async () => {
    const result = await renderComponent(
      `<h1>Welcome Alice</h1><p>Your order is confirmed.</p>`,
      { data: {}, cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.text).toBeDefined()
    expect(result.text).toContain('Welcome Alice')
    expect(result.text).toContain('Your order is confirmed')
  })

  it('extracts subject line from export const subject', async () => {
    const result = await renderComponent(
      `<script module>export const subject = 'Hi Alice!'</script><script>export let firstName = ''</script><p>body</p>`,
      { data: { firstName: 'Alice' }, cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.subject).toBe('Hi Alice!')
  })

  it('preserves @media in a <style> block by default', async () => {
    const result = await renderComponent(
      `<p class="x">text</p><style>@media(max-width:600px){.x{display:none}} .x{color:red}</style>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.html).toContain('@media')
    expect(result.html).toContain('color:red')
  })

  it('drops @media when preserveMediaQueries:false', async () => {
    const result = await renderComponent(
      `<p class="x">text</p><style>@media(max-width:600px){.x{display:none}} .x{color:red}</style>`,
      { cwd: '/tmp/mesa', target: 'email', preserveMediaQueries: false }
    )
    expect(result.html).not.toContain('@media')
    expect(result.html).toContain('color:red')
  })

  it('inlines CSS from child components too', async () => {
    await fixture('Badge.mesa', `<span class="badge">ok</span><style>.badge { padding: 4px 8px; }</style>`)

    const result = await renderComponent(
      `<script>import Badge from './Badge.mesa'</script><div><Badge /></div>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.html).toContain('padding:4px 8px')
  })
})

// ── Fragment target ───────────────────────────────────────────────────────────

describe('renderComponent — target: fragment', () => {
  it('returns inlined HTML without a wrapping document', async () => {
    const result = await renderComponent(
      `<p class="note">Hello</p><style>.note { font-size: 14px; }</style>`,
      { cwd: '/tmp/mesa', target: 'fragment' }
    )
    expect(result.html).toContain('font-size:14px')
    expect(result.html).not.toContain('<!DOCTYPE')
    expect(result.html).not.toContain('<html')
  })

  it('does not include result.text', async () => {
    const result = await renderComponent(
      `<p>text</p>`,
      { cwd: '/tmp/mesa', target: 'fragment' }
    )
    expect(result.text).toBeUndefined()
  })
})

// ── JS target ─────────────────────────────────────────────────────────────────

describe('renderComponent — RULE 19 server semantics', () => {
  it('does not run $onMount on the server', async () => {
    globalThis.__ssrMount = 0
    for (let i = 0; i < 3; i++) {
      await renderComponent(
        `<script>$onMount(() => { globalThis.__ssrMount++ })</script><p>x</p>`,
        { filename: `Mount${i}.mesa`, cwd: '/tmp/mesa', target: 'html' }
      )
    }
    await new Promise((r) => setTimeout(r, 20))
    expect(globalThis.__ssrMount).toBe(0)
  })

  it('builds no reactive graph for path watches on the server', async () => {
    // initRenderer() has to enable the DOM so components can call
    // htmlToFragment(); it must not thereby turn on client behaviour.
    await renderComponent(`<p>x</p>`, { filename: 'Warm.mesa', cwd: '/tmp/mesa', target: 'html' })
    const { watchProxy, watchPath, createEffect, flushSync } = await import('../src/runtime.js')
    const store = { n: 0 }
    expect(watchProxy(store)).toBe(store)
    const [read] = watchPath(store, 'n')
    let fired = 0
    createEffect(() => { read(); fired++ })
    flushSync()
    const before = fired
    store.n = 1
    flushSync()
    expect(fired - before).toBe(0)
  })

  it('still renders signals and derived values correctly', async () => {
    const out = await renderComponent(
      `<script>let n = 2; const d = n * 3</script><p>{n} {d}</p>`,
      { filename: 'Vals.mesa', cwd: '/tmp/mesa', target: 'html' }
    )
    expect(out.html).toContain('2 6')
  })
})

describe('renderComponent — target: js', () => {
  it('returns a module map with compiled JS', async () => {
    const result = await renderComponent(
      `<script>let count = 0</script><p>{count}</p>`,
      { filename: 'Counter.mesa', cwd: '/tmp/mesa', target: 'js' }
    )
    expect(result.modules).toBeInstanceOf(Map)
    expect(result.entry).toBe('Counter.mesa')
    const js = result.modules.get('Counter.mesa')
    expect(js).toBeDefined()
    expect(js).toContain('push_component')
  })

  it('includes child modules in the map', async () => {
    await fixture('Badge.mesa', `<span>badge</span>`)

    const result = await renderComponent(
      `<script>import Badge from './Badge.mesa'</script><div><Badge /></div>`,
      { filename: 'Parent.mesa', cwd: '/tmp/mesa', target: 'js' }
    )
    expect(result.modules.size).toBe(2)
    expect([...result.modules.keys()].some(k => k.includes('Badge'))).toBe(true)
  })

  it('collects CSS from the JS target too', async () => {
    const result = await renderComponent(
      `<p>text</p><style>p { margin: 0; }</style>`,
      { filename: 'Styled.mesa', cwd: '/tmp/mesa', target: 'js' }
    )
    expect(result.css).toContain('margin')
  })

  it('leaves no temp modules behind', async () => {
    // This call used to hand compileTree a throwaway tempFiles array, so every
    // js-target compile stranded one .mjs per module next to the source.
    await fixture('LeakChild.mesa', `<span>child</span>`)
    await renderComponent(
      `<script>import C from './LeakChild.mesa'</script><div><C /></div>`,
      { filename: 'LeakProbe.mesa', cwd: '/tmp/mesa', target: 'js' }
    )
    // Scoped to this test's own filenames so a parallel suite cannot skew it.
    const stray = (await readdir(process.cwd()))
      .filter((f) => /^__mesa_render_(LeakProbe|LeakChild)\.mesa_/.test(f))
    expect(stray).toEqual([])
  })
})

// ── renderFile ────────────────────────────────────────────────────────────────

describe('renderFile', () => {
  it('renders a .mesa file from disk', async () => {
    const p = await fixture('Static.mesa', `<script>export let msg = 'hi'</script><p>{msg}</p>`)

    const result = await renderFile(p, { data: { msg: 'from file' }, target: 'html' })
    expect(result.html).toContain('from file')
  })
})

// ── htmlToText (via email target) ─────────────────────────────────────────────

describe('htmlToText — via email target', () => {
  it('converts headings and paragraphs', async () => {
    const result = await renderComponent(
      `<h1>Title</h1><p>Body text here.</p>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.text).toContain('Title')
    expect(result.text).toContain('Body text here')
  })

  it('preserves link URLs', async () => {
    const result = await renderComponent(
      `<a href="https://example.com">Click here</a>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.text).toContain('https://example.com')
    expect(result.text).toContain('Click here')
  })

  it('decodes HTML entities', async () => {
    const result = await renderComponent(
      `<p>AT&amp;T loves Mesa</p>`,
      { cwd: '/tmp/mesa', target: 'email' }
    )
    expect(result.text).toContain('AT&T loves Mesa')
  })
})

/**
 * `tmpDir` — where the renderer's temp modules land (SSR_SPEC W1).
 *
 * The renderer compiles each module in the tree to a temp `.mjs` and imports
 * it. Node resolves a bare specifier relative to the *importing* file, so the
 * directory those temp modules live in decides which `node_modules` a rendered
 * tree can reach. It defaulted to Mesa's own package root, which is correct for
 * rendering Mesa's trees and wrong for rendering an app's: a layout containing
 * `import { page } from '@frontierjs/sierra/router'` died with "Cannot find
 * package", because the app's node_modules is nowhere on the lookup path from
 * inside packages/mesa.
 */
describe('renderComponent — tmpDir', () => {
  // Inside the package, not /tmp: vitest resolves the renderer's dynamic
  // import() through Vite, which refuses to serve a file outside the project
  // root ("Failed to load url … Does the file exist?"). Plain Node has no such
  // limit — the scratch dir only has to be somewhere Vite will serve from.
  const ROOT = path.join(process.cwd(), `_tmp_w1_${process.pid}`)
  const APP  = path.join(ROOT, 'app-root')

  beforeAll(async () => {
    // An app tree with a package only IT can resolve: node_modules/@probe/kit.
    const pkgDir = path.join(APP, 'node_modules', '@probe', 'kit')
    await mkdir(pkgDir, { recursive: true })
    await writeFile(path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@probe/kit', version: '1.0.0', type: 'module', main: 'index.js' }))
    await writeFile(path.join(pkgDir, 'index.js'), `export const label = 'from-app-node-modules'\n`)
    await writeFile(path.join(APP, 'Page.mesa'),
      `<script>\n  import { label } from '@probe/kit'\n</script>\n<p>{label}</p>`)

    // A component with no imports at all, for the plumbing cases below.
    await mkdir(ROOT, { recursive: true })
    await writeFile(path.join(ROOT, 'Simple.mesa'), `<p>Simple</p>`)
  })

  afterAll(async () => { try { rmSync(ROOT, { recursive: true, force: true }) } catch {} })

  it('renders a bare specifier that only resolves from the caller tree', async () => {
    const { html } = await renderFile(path.join(APP, 'Page.mesa'), {
      target: 'fragment',
      tmpDir: APP,
    })
    expect(html).toBe('<p>from-app-node-modules</p>')
  })

  it('cannot resolve that same import under the default tmpDir', async () => {
    // The failure W1 describes, pinned so the fix cannot silently regress: with
    // temp modules in Mesa's package root, '@probe/kit' is unreachable.
    await expect(
      renderFile(path.join(APP, 'Page.mesa'), { target: 'fragment' })
    ).rejects.toThrow(/@probe\/kit|Cannot find package/)
  })

  it('writes temp modules under tmpDir, and cleans them up', async () => {
    const scratch = path.join(ROOT, 'scratch-tmp')   // deliberately absent
    expect(existsSync(scratch)).toBe(false)

    await renderFile(path.join(ROOT, 'Simple.mesa'), { target: 'fragment', tmpDir: scratch })

    // Created on demand — a build should not have to mkdir it first.
    expect(existsSync(scratch)).toBe(true)
    const left = (await readdir(scratch)).filter((f) => f.startsWith('__mesa_render_'))
    expect(left).toEqual([])
  })

  it('leaves the default untouched when tmpDir is omitted', async () => {
    const { html } = await renderFile(path.join(ROOT, 'Simple.mesa'), { target: 'fragment' })
    expect(html).toContain('Simple')

    // Scoped to this fixture's own name on purpose. The default tmpDir IS the
    // mesa package root, and vitest runs test FILES in parallel, so a bare
    // `startsWith('__mesa_render_')` scan here races every other suite's
    // in-flight render and fails intermittently.
    const stray = (await readdir(process.cwd()))
      .filter((f) => f.startsWith('__mesa_render_Simple.mesa'))
    expect(stray).toEqual([])
  })
})

// ─── The default tmpDir must not depend on where you started the process ─────
//
// A temp render module carries `import '@frontierjs/mesa/runtime.js'`, so it has
// to be written somewhere that specifier resolves from — the mesa package root.
// `findMesaDir()` used to test `dirname(import.meta.url)` for a package.json,
// which stopped being true when these sources moved into `src/`; it then fell
// back to searching up from `process.cwd()`, so it found mesa only when the
// process happened to be started inside it, and every other caller silently got
// the OS temp dir where nothing resolves.
//
// Every test in this file passes either way, because vitest runs them from the
// mesa package root. So this one runs the renderer in a CHILD PROCESS with its
// cwd somewhere else — which is what `@frontierjs/email-kit` does, and what had
// all 34 of its tests failing while this suite stayed green. `FJS-100`.

describe('renderComponent from another working directory', () => {
  it('resolves the runtime regardless of cwd', async () => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const { tmpdir }    = await import('os')
    const { fileURLToPath } = await import('url')

    const mesaSrc = path.join(
      path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'render-component.js')

    const script = path.join(tmpdir(), `mesa-cwd-probe-${Date.now()}.mjs`)
    await writeFile(script, `
      import { renderComponent } from ${JSON.stringify(mesaSrc)}
      const { html } = await renderComponent('<p>from elsewhere</p>', { target: 'fragment' })
      process.stdout.write(html)
    `)

    try {
      // cwd is deliberately NOT inside the repo.
      const { stdout } = await promisify(execFile)(
        process.execPath, [script], { cwd: tmpdir() })
      expect(stdout).toContain('from elsewhere')
    } finally {
      await unlink(script).catch(() => {})
    }
  })
})
