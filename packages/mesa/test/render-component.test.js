/**
 * render-component.test.js
 *
 * Run: npx vitest run render-component.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFile, unlink, mkdir, readdir, utimes } from 'fs/promises'
import { existsSync, rmSync } from 'fs'
import path from 'path'
import { renderComponent, renderFile } from '../src/render-component.js'
import { initRenderer } from '../src/render.js'

// ── Test fixtures directory ───────────────────────────────────────────────────
// Every `cwd:` below is this directory and fixture() writes into it, so it has to
// exist before the first test runs. It was not created: beforeAll made a
// per-run directory nothing ever used, and the seven tests that call fixture()
// only passed on a machine where /tmp/mesa happened to survive from something
// else. A fresh runner has no such directory and all seven die on ENOENT — the
// first thing CI found that no local run could (FJS-009).
const FIXTURES = '/tmp/mesa'

beforeAll(async () => {
  await mkdir(FIXTURES, { recursive: true })
})

afterAll(async () => {
  const files = ['Badge.mesa', 'Card.mesa', 'Email.mesa', 'Static.mesa', 'WithStore.mesa']
  for (const f of files) {
    try { await unlink(path.join(FIXTURES, f)) } catch {}
  }
})

async function fixture(name, content) {
  const p = path.join(FIXTURES, name)
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
  it('does not run $.onMount on the server', async () => {
    globalThis.__ssrMount = 0
    for (let i = 0; i < 3; i++) {
      await renderComponent(
        `<script>$.onMount(() => { globalThis.__ssrMount++ })</script><p>x</p>`,
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

  it("renders a component that imports its own NEIGHBOUR by relative path", async () => {
    // The compiled module is written to a temp directory, so every relative
    // specifier in it points somewhere else. A bare specifier survives (Node
    // walks up to a node_modules) and an absolute one survives; a relative one
    // did not — so a component importing a sibling store, formatter or table
    // of constants failed to render, which is an ordinary thing for a page or
    // an island to do. Measured on `example`'s prerendered catalogue, where
    // the whole page silently stopped being built.
    await writeFile(path.join(APP, 'money.js'),
      `export const money = (n) => '$' + n.toFixed(2)\n`)
    await writeFile(path.join(APP, 'Priced.mesa'),
      `<script>\n  import { money } from './money.js'\n</script>\n<p>{money(28)}</p>`)

    const { html } = await renderFile(path.join(APP, 'Priced.mesa'), {
      target: 'fragment',
      // ROOT and not APP: the temp module has to land somewhere OTHER than the
      // source directory, or a relative specifier resolves by accident and the
      // test proves nothing. ROOT is inside packages/mesa, so the runtime import
      // still resolves.
      tmpDir: ROOT,
    })
    expect(html).toBe('<p>$28.00</p>')
  })

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

// ── Import aliases ────────────────────────────────────────────────────────────
// A compiled module is imported under NODE, which knows nothing about a
// bundler's aliases: `@/money.js` is a bare specifier there and resolves as a
// package called `@`. Sierra's prerender is itself running a Vite build, so it
// hands over the table Vite is already using and both resolvers agree.
describe('renderComponent — options.alias', () => {
  const ALIAS_DIR = path.join(FIXTURES, 'alias-src')

  beforeAll(async () => {
    await mkdir(path.join(ALIAS_DIR, 'lib'), { recursive: true })
    await writeFile(path.join(ALIAS_DIR, 'money.js'), 'export const money = (n) => `$${n}`\n')
    await writeFile(path.join(ALIAS_DIR, 'lib', 'deep.js'), "export const deep = 'DEEP'\n")
    await writeFile(
      path.join(ALIAS_DIR, 'Aliased.mesa'),
      "<script>\n  import { money } from '@/money.js'\n</script>\n<p>{money(5)}</p>\n",
    )
  })

  afterAll(() => { try { rmSync(ALIAS_DIR, { recursive: true, force: true }) } catch {} })

  it('resolves an aliased sibling module', async () => {
    const src = "<script>\n  import { money } from '@/money.js'\n</script>\n<p>{money(7)}</p>\n"
    const out = await renderComponent(src, {
      cwd: FIXTURES, filename: path.join(FIXTURES, 'A.mesa'), alias: { '@': ALIAS_DIR },
    })
    expect(out.html).toContain('$7')
  })

  it('resolves an aliased path below the alias root', async () => {
    const src = "<script>\n  import { deep } from '@/lib/deep.js'\n</script>\n<p>{deep}</p>\n"
    const out = await renderComponent(src, {
      cwd: FIXTURES, filename: path.join(FIXTURES, 'B.mesa'), alias: { '@': ALIAS_DIR },
    })
    expect(out.html).toContain('DEEP')
  })

  it('resolves an aliased .mesa import, and the dependency keeps its own alias', async () => {
    const src = "<script>\n  import Aliased from '@/Aliased.mesa'\n</script>\n<Aliased />\n"
    const out = await renderComponent(src, {
      cwd: FIXTURES, filename: path.join(FIXTURES, 'C.mesa'), alias: { '@': ALIAS_DIR },
    })
    expect(out.html).toContain('$5')
  })

  // The negative control: without the table, the same source is a bare
  // specifier and Node refuses it. If this ever passes, the tests above prove
  // nothing about the alias.
  it('without the table the same import fails', async () => {
    const src = "<script>\n  import { money } from '@/money.js'\n</script>\n<p>{money(7)}</p>\n"
    await expect(renderComponent(src, {
      cwd: FIXTURES, filename: path.join(FIXTURES, 'D.mesa'),
    })).rejects.toThrow()
  })

  // Longest prefix wins, and a key matches on a path boundary — otherwise `@`
  // swallows every specifier starting with `@`, npm scopes included.
  it('does not swallow a scoped package specifier', async () => {
    const src = "<script>\n  import { money } from '@/money.js'\n</script>\n<p>{money(1)}</p>\n"
    const out = await renderComponent(src, {
      cwd: FIXTURES, filename: path.join(FIXTURES, 'E.mesa'),
      alias: { '@': ALIAS_DIR, '@acme': '/nowhere' },
    })
    expect(out.html).toContain('$1')
  })
})

// ─── Temp modules must not outlive the process that wrote them ───────────────
//
// The `finally` blocks in renderComponent cover every path this process gets to
// run, and two it does not: a caller that ABANDONS the render — sierra's
// prerender races it against a timeout with Promise.race, so a component that
// hangs at import leaves a promise that never settles — and a process that dies
// with a render in flight. Both stranded a .mjs in the default tmpDir, which is
// this package's own root, where `bun run ci`'s hygiene phase reports it as an
// ignored source file until somebody deletes it by hand. Two sat there for
// three days.
//
// The abandonment case runs in a CHILD PROCESS because what it asserts is an
// 'exit' handler, which cannot be observed from inside the process that has it.

describe('renderComponent — temp module lifetime', () => {
  const ROOT = path.join(process.cwd(), `_tmp_life_${process.pid}`)

  beforeAll(async () => { await mkdir(ROOT, { recursive: true }) })
  afterAll(() => { rmSync(ROOT, { recursive: true, force: true }) })

  it('cleans up a render the caller abandoned', async () => {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')

    const scratch = path.join(ROOT, 'abandoned')
    await mkdir(scratch, { recursive: true })
    const renderer = path.join(process.cwd(), 'src', 'render-component.js')

    // A component that never finishes importing, raced against a clock — the
    // shape of prerender.js's `bounded()`. The render is still pending when the
    // process exits.
    const script = [
      `import { renderComponent } from ${JSON.stringify(renderer)}`,
      `const src = '<script module>\\nawait new Promise(() => {})\\n</` + `script>\\n<p>x</p>'`,
      `const work = renderComponent(src, {`,
      `  filename: ${JSON.stringify(path.join(scratch, 'Hang.mesa'))},`,
      `  tmpDir: ${JSON.stringify(scratch)}, target: 'html',`,
      `})`,
      `const clock = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 300))`,
      `try { await Promise.race([work, clock]) } catch { /* the build reports the route skipped */ }`,
    ].join('\n')

    const probe = path.join(ROOT, 'abandon-probe.mjs')
    await writeFile(probe, script)
    await promisify(execFile)(process.execPath, [probe], { cwd: ROOT })

    const left = (await readdir(scratch)).filter((f) => f.startsWith('__mesa_render_'))
    expect(left).toEqual([])
  })

  it('sweeps a leftover a killed process left, and spares one still in use', async () => {
    // Nothing covers SIGKILL, so leftovers accumulate in the default tmpDir and
    // are reported by CI rather than by anyone who was looking. The sweep is
    // age-gated: a concurrent render's file is minutes old at most.
    const scratch = path.join(ROOT, 'stale')
    await mkdir(scratch, { recursive: true })

    const stale = path.join(scratch, '__mesa_render_Killed.mesa_1_aaa.mjs')
    const live  = path.join(scratch, '__mesa_render_Running.mesa_2_bbb.mjs')
    await writeFile(stale, '// from a process that was killed')
    await writeFile(live,  '// from a render happening right now')
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    await utimes(stale, twoDaysAgo, twoDaysAgo)

    await renderComponent('<p>ok</p>', {
      filename: path.join(scratch, 'Ok.mesa'), tmpDir: scratch, target: 'fragment',
    })

    expect(existsSync(stale)).toBe(false)
    expect(existsSync(live)).toBe(true)
  })
})
