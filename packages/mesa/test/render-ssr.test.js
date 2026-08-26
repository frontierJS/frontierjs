/**
 * render-ssr.test.js — the low-level static/SSR renderer (`render.js`).
 *
 * This file exists because `renderToHTML` was a public, documented export with
 * a README example that threw on the simplest possible component: it called
 * `Comp({ props, slots })` and read `.$dom` off the result — the pre-2026-05
 * `makeComponent` convention — while the compiler had long since moved to
 * `Comp(anchor, props, block)`. Nothing imported it and nothing tested it, so
 * the break was invisible for months, and the file was still being *edited*
 * during the reactivity pass.
 *
 * The agreement tests at the bottom are the point of the suite. A renderer has
 * no self-evident correct output, but Mesa has two of them — this one and the
 * client runtime — and they must agree. That is an oracle we can build without
 * a reference implementation to copy.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import {
  initRenderer, resetRenderer, renderToHTML, renderAll, wrapPage, escapeHTML,
} from '../src/render.js'
import { renderFile } from '../src/render-component.js'
import {
  createSignal, createEffect, flushSync, mount, onMount, setRenderEnvironment,
} from '../src/runtime.js'

let n = 0

/** Compile `.mesa` source and import it as a module, as a build tool would. */
async function build(src) {
  const ctx = await compileSource(src, { filename: `/S${n}.mesa`, dev: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  // The temp module is written to the package root (cwd), not beside this
  // file, so its runtime import is relative to the package root.
  const js = ctx.result.replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_tmp_ssr_${n++}.mjs`)
  writeFileSync(file, js)
  try { return (await import('file://' + file)).default }
  finally { try { unlinkSync(file) } catch {} }
}

/**
 * Drop the compiler's per-file scope class.
 *
 * The agreement suite below compiles once and feeds one module to both
 * renderers, so scope ids match there and are compared verbatim. The children
 * suite compiles twice — the SSR path goes through `renderFile`, which compiles
 * internally — and the ids differ between compilations, so those compare
 * structure instead.
 */
const unscope = (html) => html
  .replace(/ class="([^"]*)"/g, (_, cls) => {
    const kept = cls.split(/\s+/).filter((c) => c && !/^m[0-9a-z]{6,}$/.test(c))
    return kept.length ? ` class="${kept.join(' ')}"` : ''
  })

/** The same anchor-stripping the renderer applies, for comparing client output. */
const strip = (html) => html
  .replace(/<!--mesa-root-->/g, '')
  .replace(/<!---->/g, '')
  .replace(/<!-- [^>]* -->/g, '')
  .trim()

/** Render the same component through the client runtime, into a real container. */
function renderOnClient(Comp, props = {}) {
  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const label = document.createElement('span')
  wrap.appendChild(label)
  mount(label, Comp, { props })
  flushSync()
  label.remove()
  const html = strip(wrap.innerHTML)
  wrap.remove()
  return html
}

beforeAll(() => { initRenderer() })
afterAll(() => { document.body.innerHTML = '' })

describe('renderToHTML — the serialiser escapes (FJS-500)', () => {
  // A prerendered page is a FILE: public, CDN-cached, unrecallable. `{text}`
  // sets `textContent` at runtime and is the safest expression in the language,
  // but SSR renders into happy-dom and serialises with `container.innerHTML` —
  // and happy-dom 14.12.3 did not re-escape a text node on the way out, so
  // every string a static build baked in came out as live markup. Nothing in
  // Mesa's own code was wrong, which is why nothing here could see it: the
  // client path is correct and only the round trip through the DOM was not.
  //
  // These are assertions about a DEPENDENCY, so they belong in this repo's
  // suite rather than in a version range nobody reads. A downgrade, a second
  // resolved copy, or a serialiser regression is a red test instead of a page
  // that ships an injected script.

  it('escapes markup arriving through a text interpolation', async () => {
    const Comp = await build(`<script>
  export let text = ''
</script>
<p>{text}</p>`)
    const html = await renderToHTML(Comp, { text: '<img src=x onerror=alert(1)>' })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('<img')
  })

  it('escapes a closing tag that would break out of the element it is in', async () => {
    const Comp = await build(`<script>
  export let text = ''
</script>
<p>{text}</p>`)
    const html = await renderToHTML(Comp, { text: '</p><script>alert(1)<\/script>' })
    expect(html).not.toMatch(/<script/)
    expect(html).toContain('&lt;/p&gt;')
  })

  it('escapes an ampersand without double-escaping one already written', async () => {
    // The other direction, and the one a naive fix breaks: `a &amp; b` written
    // in the markup must stay one ampersand, not become `&amp;amp;`.
    const Comp = await build(`<script>
  export let text = ''
</script>
<p>{text}</p>
<i>a &amp; b</i>`)
    const html = await renderToHTML(Comp, { text: 'x & y' })
    expect(html).toContain('x &amp; y')
    expect(html).toContain('a &amp; b')
    expect(html).not.toContain('&amp;amp;')
  })

  // ── The other half: an ATTRIBUTE value ──────────────────────────────────
  //
  // Text nodes are where this was found and attributes are the wider hole, for
  // a reason worth stating: a text node can only inject an element, and an
  // attribute value that escapes its own quotes injects an EVENT HANDLER onto
  // an element the page already trusts. `<img alt={product.alt}>` and
  // `<a href={product.slug}>` are both database strings on every prerendered
  // catalogue page in `example/site`.
  //
  // These assert by RE-PARSING the output rather than by matching text, and
  // that is the whole difference between a real test and a spelling test:
  // `title="&quot; onmouseover=alert(1)"` contains the characters
  // `onmouseover=` and is completely safe. What must be true is that the
  // attacker could not add an ATTRIBUTE — so the question to ask the output is
  // how many attributes the element has, which is the property, not the
  // encoding.

  /** Parse serialised HTML back and answer the first matching element. */
  const reparse = (html, sel) => {
    const host = document.createElement('div')
    host.innerHTML = html
    return host.querySelector(sel)
  }

  it('a dynamic attribute value cannot break out of its own quotes', async () => {
    const Comp = await build(`<script>
  export let label = ''
</script>
<a href="/x" title={label}>go</a>`)
    const html = await renderToHTML(Comp, { label: '" onmouseover=alert(1) autofocus x="' })

    const a = reparse(html, 'a')
    // The payload survives as a VALUE — intact, which is the correct outcome:
    // escaping is not sanitising, and a product genuinely called `5" pipe`
    // must come back as `5" pipe`.
    expect(a.getAttribute('title')).toBe('" onmouseover=alert(1) autofocus x="')
    // …and it added nothing. Asked as a count so a payload shaped differently
    // from this one still fails the test.
    expect(a.getAttributeNames().sort()).toEqual(['href', 'title'])
    expect(a.hasAttribute('onmouseover')).toBe(false)
  })

  it('a URL from the database cannot add a handler to the link carrying it', async () => {
    // The shape a prerendered catalogue actually has: one `<a>` per product,
    // its href a column. A slug is the least-reviewed string in a shop.
    const Comp = await build(`<script>
  export let slug = ''
</script>
<a href={slug}>buy</a>`)
    const html = await renderToHTML(Comp, { slug: 'x" onclick="alert(1)' })

    const a = reparse(html, 'a')
    expect(a.getAttribute('href')).toBe('x" onclick="alert(1)')
    expect(a.getAttributeNames()).toEqual(['href'])
  })

  it('an image alt is the same hole and is the one FJS-500 named', async () => {
    const Comp = await build(`<script>
  export let alt = ''
</script>
<img src="/p.png" alt={alt}>`)
    const html = await renderToHTML(Comp, { alt: '" onerror="alert(1)' })

    const img = reparse(html, 'img')
    expect(img.getAttributeNames().sort()).toEqual(['alt', 'src'])
    expect(img.hasAttribute('onerror')).toBe(false)
  })

  it('an entity written in the markup stays one character', async () => {
    // The direction a naive escaper breaks, in an attribute this time. The
    // PARSER decodes `&amp;` in the source to one ampersand, so the value is
    // `Tea & Co` and serialising it must give back one entity — not
    // `&amp;amp;`, which renders as visible mojibake in a tooltip.
    const Comp = await build(`<a href="/x" title="Tea &amp; Co">go</a>`)
    const html = await renderToHTML(Comp, {})

    expect(reparse(html, 'a').getAttribute('title')).toBe('Tea & Co')
    expect(html).toContain('Tea &amp; Co')
    expect(html).not.toContain('&amp;amp;')
  })

  it('the two renderers agree about a hostile attribute', async () => {
    // The oracle this suite is built on: a renderer has no self-evident correct
    // output, but Mesa has two of them. The client sets the attribute through
    // the DOM and never serialises; SSR sets the same attribute and then
    // serialises. Comparing the two is what says the round trip added nothing
    // and lost nothing.
    const Comp = await build(`<script>
  export let label = ''
</script>
<a href="/x" title={label}>go</a>`)
    const props = { label: '" onmouseover=alert(1) x="' }

    const server = strip(await renderToHTML(Comp, props))
    const client = renderOnClient(Comp, props)

    expect(unscope(server)).toBe(unscope(client))
  })

  it('leaves an entity written INSIDE a script block alone', async () => {
    // Script content is raw text in HTML, so `&lt;` there is four characters
    // and not a `<`. This is the shape that surfaced the defect: a code sample
    // holding an escaped `<script>` came out of a static build as a real one.
    const Comp = await build(`<script module>
  const sample = \`<b>&lt;script&gt;</b>\`
</script>
<pre>{@html sample}</pre>`)
    const html = await renderToHTML(Comp, {})
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toMatch(/<script/)
  })
})

describe('renderToHTML — basics', () => {
  it('renders text, attributes and props', async () => {
    const Comp = await build(`<script>
  export let title = 'untitled'
  let count = 3
</script>
<div class="box"><h1 id="t">{title}: {count}</h1></div>`)

    expect(unscope(await renderToHTML(Comp, { title: 'Hello' })))
      .toBe('<div class="box"><h1 id="t">Hello: 3</h1></div>')
  })

  it('falls back to declared prop defaults when props are omitted', async () => {
    const Comp = await build(`<script>
  export let title = 'untitled'
</script>
<h1>{title}</h1>`)
    expect(await renderToHTML(Comp)).toBe('<h1>untitled</h1>')
  })

  it('renders derived values, {#if} and {#each}', async () => {
    const Comp = await build(`<script>
  let count = 3
  const doubled = count * 2
</script>
<section>
  <p>{doubled}</p>
  {#if count > 0}<em>positive</em>{/if}
  {#if count > 99}<em>huge</em>{/if}
  <ul>{#each [1,2,3] as x}<li>{x}</li>{/each}</ul>
</section>`)
    const html = await renderToHTML(Comp)
    expect(html).toContain('<p>6</p>')
    expect(html).toContain('<em>positive</em>')
    expect(html).not.toContain('huge')
    expect(html).toContain('<li>1</li><li>2</li><li>3</li>')
  })

  it('renders the {:pending} branch of {#await} — nothing settles mid-render', async () => {
    const Comp = await build(`<script>
  const data = Promise.resolve('LATE')
</script>
<div>{#await data}<span>loading</span>{:then v}<span>{v}</span>{/await}</div>`)
    const html = await renderToHTML(Comp)
    expect(html).toContain('loading')
    expect(html).not.toContain('LATE')
  })

  it('strips Mesa comment anchors by default and keeps them on request', async () => {
    const Comp = await build(`<div>{#if true}<b>yes</b>{/if}</div>`)
    expect(await renderToHTML(Comp)).toBe('<div><b>yes</b></div>')
    expect(await renderToHTML(Comp, {}, { keepAnchors: true })).toContain('<!---->')
  })
})

describe('renderToHTML — server semantics (RULE 19)', () => {
  it('does not run $.onMount', async () => {
    let mounted = 0
    globalThis.__ssrMounted = () => { mounted++ }
    const Comp = await build(`<script>
  $.onMount(() => { globalThis.__ssrMounted() })
</script>
<p>hi</p>`)
    expect(await renderToHTML(Comp)).toBe('<p>hi</p>')
    expect(mounted).toBe(0)
    delete globalThis.__ssrMounted
  })

  // An attachment runs when the element MOUNTS, and there is no mount here —
  // the same reason $.onMount is skipped above. Running it handed the function
  // a happy-dom element, which implements no Web Animations API, so a
  // component whose attachment animates threw `el.animate is not a function`
  // and took the WHOLE render with it. `@frontierjs/ui`'s Toast was one, and
  // it meant a Sierra `static` route carrying one could not be prerendered.
  it('does not run an {@attach}, so an animating attachment cannot break a render', async () => {
    let ran = 0
    globalThis.__ssrAttached = () => { ran++ }
    const Comp = await build(`<script>
  function fade(el) {
    globalThis.__ssrAttached()
    el.animate([{ opacity: 0 }, { opacity: 1 }], 120)
  }
</script>
<p {@attach fade}>hi</p>`)
    expect(await renderToHTML(Comp)).toBe('<p>hi</p>')
    expect(ran).toBe(0)
    delete globalThis.__ssrAttached
  })

  it('disposes what a render created — pages do not accumulate effects', () => {
    // The SSG shape: one process, many pages, a shared module-scope store.
    // Each render's effects used to stay subscribed to it forever; after N
    // pages one write re-ran N effect sets against detached DOM.
    const [read, write] = createSignal(0)
    let runs = 0
    const Comp = (anchor) => {
      const p = document.createElement('p')
      createEffect(() => { p.textContent = String(read()); runs++ })
      anchor.before(p)
    }

    return (async () => {
      for (let i = 0; i < 3; i++) {
        expect(await renderToHTML(Comp)).toBe('<p>0</p>')
      }
      expect(runs).toBe(3)          // once per render
      write(1); flushSync()
      expect(runs).toBe(3)          // and nothing survives the render
    })()
  })
})

describe('renderToHTML — no attribute the author did not write', () => {
  // happy-dom's cloneNode re-derives an <input>'s attributes from its default
  // PROPERTIES, so a cloned template gained formaction="<the page URL>" and
  // formmethod="" on every input, and absolutised an authored relative
  // formaction. `formaction` overrides the form's action, so a prerendered
  // form posted to whatever machine built it — with that machine's localhost
  // URL shipped in a public file. template() parses per instance on the server
  // for this reason.
  it('does not invent formaction/formmethod on an input', async () => {
    const Comp = await build(`<form action="/search"><input type="search" name="q" /></form>`)
    const html = await renderToHTML(Comp)
    expect(html).not.toMatch(/formaction/)
    expect(html).not.toMatch(/formmethod/)
    expect(unscope(html)).toBe('<form action="/search"><input type="search" name="q"></form>')
  })

  it('leaves an authored relative formaction relative', async () => {
    const Comp = await build(`<form action="/a"><input type="submit" formaction="/b" /></form>`)
    const html = await renderToHTML(Comp)
    expect(html).toMatch(/formaction="\/b"/)
    expect(html).not.toMatch(/http:\/\//)
  })

  it('repeats a template without accumulating anything', async () => {
    // One template, three instances: the per-instance parse must produce the
    // same markup each time, not diverge from the first.
    const Comp = await build(`<script>
  let rows = [1, 2, 3]
</script>
<ul>{#each rows as r}<li><input value={r} /></li>{/each}</ul>`)
    const html = unscope(await renderToHTML(Comp))
    expect(html.match(/<input/g)).toHaveLength(3)
    expect(html).not.toMatch(/formaction/)
  })
})

describe('renderToHTML — failure modes', () => {
  it('names the cause when the component throws', async () => {
    const boom = () => { throw new Error('kaboom') }
    await expect(renderToHTML(boom)).rejects.toThrow(/Component threw during render: kaboom/)
  })

  it('rejects a module namespace passed instead of the component', async () => {
    await expect(renderToHTML({ default: () => {} })).rejects.toThrow(/Pass the component function itself/)
  })

  it('requires initRenderer() first', async () => {
    resetRenderer()
    try {
      await expect(renderToHTML(() => {})).rejects.toThrow(/initRenderer\(\) must be called/)
    } finally {
      initRenderer()   // restore for the rest of the file
    }
  })
})

describe('renderAll and wrapPage', () => {
  it('renders pages in order, each with its own props', async () => {
    const Comp = await build(`<script>
  export let name = ''
</script>
<p>{name}</p>`)
    const out = await renderAll([
      { component: Comp, props: { name: 'a' } },
      { component: Comp, props: { name: 'b' } },
      { component: Comp, props: { name: 'c' } },
    ])
    expect(out).toEqual(['<p>a</p>', '<p>b</p>', '<p>c</p>'])
  })

  it('does not interleave renders', async () => {
    // The window and the reactive core are process-global; overlapping renders
    // would corrupt each other. renderToHTML is synchronous inside, so each
    // completes before the next starts even under Promise.all.
    const order = []
    const mk = (id) => (anchor) => {
      order.push(`start:${id}`)
      const p = document.createElement('p')
      p.textContent = id
      anchor.before(p)
      order.push(`end:${id}`)
    }
    await renderAll([1, 2, 3].map((id) => ({ component: mk(id), props: {} })))
    expect(order).toEqual(['start:1', 'end:1', 'start:2', 'end:2', 'start:3', 'end:3'])
  })

  it('wraps a full document with head tags in order', async () => {
    const Comp = await build(`<p>body</p>`)
    const html = await renderToHTML(Comp, {}, {
      full: true, title: 'My Page', css: '/site.css',
      scripts: ['/app.js'], islandLoader: '/islands.js',
      meta: { description: 'a page' },
    })
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true)
    expect(html).toContain('<title>My Page</title>')
    expect(html).toContain('<meta name="description" content="a page">')
    expect(html).toContain('<link rel="stylesheet" href="/site.css">')
    expect(html).toContain('<script type="module" src="/app.js"></script>')
    expect(html).toContain('<script type="module" src="/islands.js"></script>')
    expect(html).toContain('<p>body</p>')
  })

  it('escapes user-controlled values in the page shell', () => {
    expect(escapeHTML('<img src=x onerror="alert(1)">'))
      .toBe('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;')
    expect(wrapPage('', { title: '</title><script>bad()</script>' }))
      .not.toContain('<script>bad()')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Server and client must agree. Mesa has two renderers and no reference
// implementation — this is the oracle available without one.
// ─────────────────────────────────────────────────────────────────────────────

describe('SSR output agrees with the client runtime', () => {
  const cases = {
    'static markup':   `<div class="a"><h1>Title</h1><p>text</p></div>`,
    'interpolation':   `<script>let n = 41</script><p>{n + 1}</p>`,
    'derived const':   `<script>let n = 3\n  const sq = n * n</script><p>{sq}</p>`,
    'props':           `<script>export let who = 'world'</script><p>hello {who}</p>`,
    '{#if} taken':     `<script>let ok = true</script><div>{#if ok}<b>y</b>{:else}<i>n</i>{/if}</div>`,
    '{#if} not taken': `<script>let ok = false</script><div>{#if ok}<b>y</b>{:else}<i>n</i>{/if}</div>`,
    '{#each}':         `<script>let xs = ['a','b']</script><ul>{#each xs as x}<li>{x}</li>{/each}</ul>`,
    '{#each} empty':   `<script>let xs = []</script><ul>{#each xs as x}<li>{x}</li>{:else}<li>none</li>{/each}</ul>`,
    'nested blocks':   `<script>let xs = [1,2]\n  let on = true</script><ul>{#each xs as x}{#if on}<li>{x}</li>{/if}{/each}</ul>`,
    'attributes':      `<script>let cls = 'big'\n  let n = 2</script><div class={cls} data-n={n}>x</div>`,
    '{#key}':          `<script>let k = 1</script><div>{#key k}<span>{k}</span>{/key}</div>`,
  }

  for (const [name, src] of Object.entries(cases)) {
    it(name, async () => {
      const Comp = await build(src)
      const server = await renderToHTML(Comp)
      const client = renderOnClient(Comp)
      expect(server).toBe(client)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Component children — Mesa has two unrelated protocols and nothing bridges
// them. Which is fine, and neither is an SSR limitation: both renderers behave
// identically. What is NOT fine is a caller composing with one while the
// component reads the other, which produces empty output and no error. Sierra's
// prerenderer did exactly that until 2026-08-02, dropping the page from every
// `<slot />` layout.
//
//   <slot />                  reads the THIRD argument (element children)
//   {@render children?.()}    reads the `children` PROP
//
// These cases pin both protocols and the two mismatches, in both renderers.
// ─────────────────────────────────────────────────────────────────────────────

describe('component children — protocols, and the cost of mixing them', () => {
  const SLOT_LAYOUT = `<div class="a"><slot /></div>`
  const PROP_LAYOUT = `<script>\n  export let children = null\n</script>\n<div class="b">{@render children?.()}</div>`
  const PAGE        = `<h1>page</h1>`

  let dir
  beforeAll(() => {
    dir = path.join(process.cwd(), `_tmp_slots_${process.pid}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'SlotLayout.mesa'), SLOT_LAYOUT)
    writeFileSync(path.join(dir, 'PropLayout.mesa'), PROP_LAYOUT)
    writeFileSync(path.join(dir, 'Page.mesa'), PAGE)
  })
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  /** Write an entry that composes Page inside Layout, render it both ways. */
  async function bothRenderers(name, entrySrc) {
    const file = path.join(dir, `${name}.mesa`)
    writeFileSync(file, entrySrc)

    const server = strip((await renderFile(file, { target: 'fragment' })).html)

    // Client: compile the tree by hand, rewriting .mesa imports to the
    // compiled siblings, and mount the entry.
    for (const mod of ['SlotLayout', 'PropLayout', 'Page', name]) {
      const src = entrySrc && mod === name ? entrySrc
        : { SlotLayout: SLOT_LAYOUT, PropLayout: PROP_LAYOUT, Page: PAGE }[mod]
      const ctx = await compileSource(src, { filename: path.join(dir, `${mod}.mesa`), dev: false })
      writeFileSync(path.join(dir, `${mod}.mjs`), ctx.result
        .replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'../src/runtime.js'`)
        .replace(/'\.\/(\w+)\.mesa'/g, `'./$1.mjs'`))
    }
    const Comp = (await import(`file://${path.join(dir, `${name}.mjs`)}?v=${n++}`)).default
    const client = renderOnClient(Comp)

    // Scope ids differ because the two paths compiled the same source
    // separately; everything else must be identical.
    return { server: unscope(server), client: unscope(client) }
  }

  const entry = (layout, body) =>
    `<script>\n  import L from './${layout}.mesa'\n  import Page from './Page.mesa'\n</script>\n${body}`

  it('<slot /> renders element children — server and client alike', async () => {
    const { server, client } = await bothRenderers('E1', entry('SlotLayout', `<L><Page /></L>`))
    expect(server).toBe('<div class="a"><h1>page</h1></div>')
    expect(server).toBe(client)
  })

  it('{@render children} renders the children prop — server and client alike', async () => {
    const { server, client } = await bothRenderers('E2',
      entry('PropLayout', `{#snippet s()}<Page />{/snippet}\n<L children={s} />`))
    expect(server).toBe('<div class="b"><h1>page</h1></div>')
    expect(server).toBe(client)
  })

  it('element children into a prop-reading layout render nothing — on BOTH renderers', async () => {
    const { server, client } = await bothRenderers('E3', entry('PropLayout', `<L><Page /></L>`))
    expect(server).toBe('<div class="b"></div>')
    expect(server).toBe(client)   // a protocol mismatch, not an SSR bug
  })

  it('a children prop into a <slot /> layout renders nothing — on BOTH renderers', async () => {
    const { server, client } = await bothRenderers('E4',
      entry('SlotLayout', `{#snippet s()}<Page />{/snippet}\n<L children={s} />`))
    expect(server).toBe('<div class="a"></div>')
    expect(server).toBe(client)
  })

  it('supplying both satisfies either layout, and renders once', async () => {
    // The shape Sierra's composeWrapper emits, so that a prerendered layout
    // works whichever protocol it was written against.
    const both = (layout) => bothRenderers(layout === 'SlotLayout' ? 'E5' : 'E6',
      entry(layout, `{#snippet s()}<Page />{/snippet}\n<L children={s}>{@render s()}</L>`))

    const viaSlot = await both('SlotLayout')
    expect(viaSlot.server).toBe('<div class="a"><h1>page</h1></div>')
    expect(viaSlot.server).toBe(viaSlot.client)

    const viaProp = await both('PropLayout')
    expect(viaProp.server).toBe('<div class="b"><h1>page</h1></div>')
    expect(viaProp.server).toBe(viaProp.client)
  })
})

/**
 * Islands — `client:*` markers in SSR output (SSR_SPEC W3).
 *
 * The compiler has always collected `ctx.islands`, and nothing ever consumed
 * it: SSR emitted an island's markup inline with nothing to identify it, so a
 * client loader had no way to tell `<button>0</button>` from the static text
 * beside it. These tests pin the marker format, the two guards that keep it out
 * of client output, and — the point of the exercise — that a loader can find a
 * marker in served HTML and mount into it.
 *
 * Marker shape is comment-delimited rather than a `<mesa-island>` element. The
 * table case below is why: a real HTML parser foster-parents a non-table
 * element out of `<tbody>`, which would relocate the marker away from the
 * markup it identifies before any loader ran. Verified in headless Chrome as
 * well as here.
 */
describe('islands — client:* markers in SSR output', () => {
  const COUNTER = `<script>\n  export let start = 0\n  let n = start\n</script>\n<button onclick={() => n++}>{n}</button>`
  const ROW     = `<script>\n  export let label = 'x'\n</script>\n<tr><td>{label}</td></tr>`

  let dir
  beforeAll(() => {
    dir = path.join(process.cwd(), `_tmp_isl_${process.pid}`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'Counter.mesa'), COUNTER)
    writeFileSync(path.join(dir, 'Row.mesa'), ROW)
  })
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

  /** Render `src` as a file in the fixture dir, with or without island markers. */
  async function ssr(name, src, islands = true) {
    const file = path.join(dir, `${name}.mesa`)
    writeFileSync(file, src)
    return renderFile(file, { target: 'fragment', islands })
  }

  /** Compile the tree by hand and mount the entry through the client runtime. */
  async function client(name, src, extra = {}, compileOptions = {}) {
    const sources = { Counter: COUNTER, Row: ROW, [name]: src, ...extra }
    for (const [mod, s] of Object.entries(sources)) {
      const ctx = await compileSource(s, { filename: path.join(dir, `${mod}.mesa`), dev: false, ...compileOptions })
      if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
      writeFileSync(path.join(dir, `${mod}.mjs`), ctx.result
        .replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'../src/runtime.js'`)
        .replace(/'\.\/(\w+)\.mesa'/g, `'./$1.mjs'`))
    }
    const Comp = (await import(`file://${path.join(dir, `${name}.mjs`)}?v=${n++}`)).default
    return { Comp, html: renderOnClient(Comp) }
  }

  /** Every comment node under `root`, in document order. */
  function comments(root, out = []) {
    for (let node = root.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 8) out.push(node)
      else if (node.nodeType === 1) comments(node, out)
    }
    return out
  }

  /**
   * A client loader's view: find every island in parsed HTML.
   *
   * Deliberately a manual walk rather than `createTreeWalker(root,
   * NodeFilter.SHOW_COMMENT)`. The TreeWalker is what a real loader should use
   * and it works in a browser — but happy-dom 14.12.3 filters SHOW_COMMENT to
   * nothing, so the obvious implementation silently finds zero islands under
   * this suite's DOM. Worth knowing before writing the loader.
   */
  function findIslands(root) {
    const found = [], open = []
    for (const c of comments(root)) {
      if (c.data.startsWith('mesa-island ')) {
        open.push({ node: c, meta: JSON.parse(c.data.slice('mesa-island '.length)) })
      } else if (c.data === '/mesa-island') {
        const o = open.pop()
        const nodes = []
        for (let node = o.node.nextSibling; node && node !== c; node = node.nextSibling) nodes.push(node)
        found.push({ ...o, close: c, nodes, parent: c.parentNode.nodeName,
                     inner: nodes.map((node) => node.outerHTML ?? node.data).join('') })
      }
    }
    return found
  }

  /** Parse served HTML into a live container, as a browser would. */
  function parse(html) {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    return host
  }

  const entry = (body, imports = `import Counter from './Counter.mesa'`) =>
    `<script>\n  ${imports}\n</script>\n${body}`

  it('is off by default — client:* still renders exactly as today', async () => {
    const src = entry(`<article><p>s</p><Counter client:load start={3} /></article>`)
    const off = await ssr('D1', src, false)
    expect(off.html).toBe('<article><p>s</p><button>3</button></article>')
    expect(off.html).not.toContain('mesa-island')

    // Identical to the same component with no directive at all: RULE 26 holds
    // by default, so turning the feature off is not merely "no markers" but no
    // difference of any kind.
    const bare = await ssr('D2', entry(`<article><p>s</p><Counter start={3} /></article>`), false)
    expect(off.html).toBe(bare.html)
  })

  it('wraps a client:* component, and leaves its neighbours alone', async () => {
    const { html } = await ssr('I1',
      entry(`<article><p>s</p><Counter client:load start={3} /><Counter start={9} /></article>`))

    const islands = findIslands(parse(html))
    expect(islands).toHaveLength(1)
    expect(islands[0].meta).toEqual({ component: 'Counter', directive: 'load', props: { start: 3 } })
    expect(islands[0].inner).toBe('<button>3</button>')
    // The non-island sibling is untouched — no marker, same markup.
    expect(html).toContain('<button>9</button><\/article>')
  })

  it('carries the runtime prop values, not just the statically-analysable ones', async () => {
    // ctx.islands can only see literal attributes at compile time, so
    // `start={2 + 3}` contributes nothing there. The marker is written during
    // the render, where the real value exists — which is what a loader needs to
    // remount with the state the page was prerendered in.
    const src = entry(`<div><Counter client:idle start={2 + 3} /></div>`)
    const { html, islands: meta } = await ssr('I2', src)

    expect(meta.map((i) => ({ component: i.component, directive: i.directive })))
      .toEqual([{ component: 'Counter', directive: 'idle' }])
    expect(meta[0].props).toBeUndefined()
    expect(meta[0].file).toContain('I2.mesa')

    expect(findIslands(parse(html))[0].meta.props).toEqual({ start: 5 })
  })

  it('preserves a client:media query', async () => {
    const { html } = await ssr('I3', entry(`<div><Counter client:media="(min-width: 600px)" /></div>`))
    expect(findIslands(parse(html))[0].meta).toEqual({
      component: 'Counter', directive: 'media', media: '(min-width: 600px)',
    })
  })

  it('nests', async () => {
    writeFileSync(path.join(dir, 'Outer.mesa'),
      entry(`<div><p>outer</p><Counter client:idle start={1} /></div>`))
    const { html } = await ssr('I4',
      entry(`<section><Outer client:load /></section>`, `import Outer from './Outer.mesa'`))

    const islands = findIslands(parse(html))
    // Inner closes first, so it is recorded first.
    expect(islands.map((i) => i.meta.component)).toEqual(['Counter', 'Outer'])
    expect(islands[0].parent).toBe('DIV')
    expect(islands[1].inner).toContain('mesa-island')
  })

  it('survives inside a table — the case an element wrapper would not', async () => {
    // A `<mesa-island>` element between <tbody> and <tr> is foster-parented out
    // of the table by the HTML parser, taking the identity of the island with
    // it. A comment is legal wherever content is. Confirmed in Chrome too.
    const { html } = await ssr('I5',
      entry(`<table><tbody><Row client:load label="a" /><Row label="b" /></tbody></table>`,
            `import Row from './Row.mesa'`))

    const islands = findIslands(parse(html))
    expect(islands).toHaveLength(1)
    expect(islands[0].parent).toBe('TBODY')
    expect(islands[0].inner).toBe('<tr><td>a</td></tr>')
  })

  it('escapes a prop value that would otherwise close the comment', async () => {
    const src = `<script>\n  import Counter from './Counter.mesa'\n  const evil = 'a --> b <!-- c > d'\n</script>\n<div><Counter client:load label={evil} /></div>`
    const { html } = await ssr('I6', src)

    // Nothing in the payload can terminate a comment, under the spec rule
    // (`-->`) or under a naive first-`>` parser like happy-dom's.
    const payload = html.slice(html.indexOf('mesa-island '), html.indexOf('-->'))
    expect(payload).not.toContain('>')
    expect(findIslands(parse(html))[0].meta.props).toEqual({ label: 'a --> b <!-- c > d' })
  })

  it('drops unserializable props with a named warning rather than losing the marker', async () => {
    const warn = []
    const original = console.warn
    console.warn = (m) => warn.push(String(m))
    let html
    try {
      const src = `<script>\n  import Counter from './Counter.mesa'\n  const fn = () => 1\n  const circ = {}; circ.self = circ\n</script>\n<div><Counter client:load cb={fn} start={1} /><Counter client:load bad={circ} /></div>`
      html = (await ssr('I7', src)).html
    } finally { console.warn = original }

    const islands = findIslands(parse(html))
    expect(islands).toHaveLength(2)
    // The function is dropped; the serializable prop beside it survives.
    expect(islands[0].meta.props).toEqual({ start: 1 })
    // The circular prop takes the whole props object with it, but the island is
    // still marked — a loader can mount it with its own defaults.
    expect(islands[1].meta).toEqual({ component: 'Counter', directive: 'load' })

    expect(warn.some((w) => w.includes('cb dropped'))).toBe(true)
    expect(warn.some((w) => w.includes('could not be serialized'))).toBe(true)
  })

  it('emits no markers on the client, even when compiled with islands:true', async () => {
    // Two guards, and this is the second one: the flag switches emission, the
    // environment decides whether a marker is written. A live client has no
    // loader to serve, so it gets the direct call it always got.
    //
    // The flip is explicit because `initRenderer()` in this file's beforeAll
    // put the whole process in server mode — `setRenderEnvironment(true,
    // false)`. Everything else here renders under that flag, which is why
    // `renderOnClient` is a faithful client for markup but not for the
    // environment split this test is about.
    const src = entry(`<article><Counter client:load start={3} /></article>`)
    setRenderEnvironment(true, true)
    let html
    try {
      ;({ html } = await client('C1', src, {}, { islands: true }))
    } finally {
      setRenderEnvironment(true, false)
    }
    expect(html).not.toContain('mesa-island')
    expect(html).toBe('<article><button>3</button></article>')
  })

  it('agrees with the client runtime on the markup inside the marker', async () => {
    const src = entry(`<article><p>s</p><Counter client:load start={7} /></article>`)
    const { html: server } = await ssr('A1', src)
    const { html: browser } = await client('A1', src)

    const island = findIslands(parse(server))[0]
    expect(island.inner).toBe('<button>7</button>')
    // Strip the markers from the server output and the two renderers agree
    // exactly — the marker adds identity, never markup.
    expect(unscope(server.replace(/<!--\/?mesa-island[^>]*-->/g, ''))).toBe(unscope(browser))
  })

  it('a marker is mountable: clear the range, mount() against the open marker', async () => {
    // The whole point of the marker, and the shape of the loader Sierra has to
    // write. The markers are ordinary comment nodes, so `mount()` takes one as
    // its anchor: it inserts its own anchor immediately after the node passed
    // and the component renders before that — i.e. exactly into the range the
    // prerendered markup just vacated.
    //
    // It must be `mount()`, not a bare `Comp(anchor, props, null)`. A direct
    // call renders correct markup and registers no delegation root, so the
    // island comes back inert — the same trap that made all 59 REPL examples
    // render and respond to nothing. Verified below by clicking it.
    const src = entry(`<article><p>s</p><Counter client:load start={4} /></article>`)
    const { html: server } = await ssr('M1', src)
    const { Comp: Counter } = await client('Counter', COUNTER)

    const host = parse(server)
    const island = findIslands(host)[0]
    expect(island.inner).toBe('<button>4</button>')

    for (const node of island.nodes) node.remove()
    mount(island.node, Counter, { props: island.meta.props })
    flushSync()

    // Same markup as the prerender it replaced...
    expect(strip(host.querySelector('article').innerHTML)
      .replace(/<!--\/?mesa-island[^>]*-->/g, '')).toBe('<p>s</p><button>4</button>')
    // ...and now live, which the prerendered HTML was not.
    host.querySelector('button').click()
    flushSync()
    expect(host.querySelector('button').textContent).toBe('5')
    host.remove()
  })
})

/**
 * CSS scoping — does the emitted selector actually match the emitted markup?
 *
 * `addStyles` had 19 assertions covering it as a mechanism: does it insert a
 * style tag, does it dedupe, is it a no-op on the server. Nothing checked the
 * only thing that matters — that the selector Mesa writes matches the elements
 * Mesa writes. It did not, for two compounding reasons:
 *
 *   - selectors were emitted as `.hash <sel>`, an ANCESTOR selector, while the
 *     hash class was put ON the element. `.hash button` matches a button INSIDE
 *     a `.hash` element, never the `<button class="hash">` carrying it — so a
 *     component could not style its own root, silently.
 *   - the hash was only added to elements that already had a `class`
 *     attribute, so `<button>` never got one at all.
 *
 * These are structural assertions on compiler output. The computed-style proof
 * is in a real browser — happy-dom does not implement the cascade — and lives
 * in packages/sierra/tests/fixtures/island-site.
 */
describe('CSS scoping — selectors match the markup they are emitted with', () => {
  /** Compile and return { html, css, id }. */
  async function scoped(src) {
    const ctx = await compileSource(src, { filename: `/Sc${n++}.mesa`, css: false, dev: false, warning: () => {} })
    if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
    const tpl = ctx.result.match(/template\(`([^`]*)`/)
    return { html: tpl ? tpl[1] : '', css: ctx.css.result ?? '', id: ctx.css.id }
  }

  it('a component can style its own root element', async () => {
    const { html, css, id } = await scoped(`<button>x</button>\n<style>button { color: red }</style>`)
    // The subject carries the class, and the selector asks for it on the subject.
    expect(html).toBe(`<button class="${id}">x</button>`)
    expect(css).toContain(`button.${id}`)
    expect(css).not.toContain(`.${id} button`)   // the old, unmatchable form
  })

  it('gives the scope class to an element with no class attribute', async () => {
    const { html, id } = await scoped(`<div><span>x</span></div>\n<style>span { color: red }</style>`)
    expect(html).toBe(`<div class="${id}"><span class="${id}">x</span></div>`)
  })

  it('keeps authored classes alongside the scope class, with one separator', async () => {
    const { html, id } = await scoped(`<button class="a b">x</button>\n<style>button { color: red }</style>`)
    expect(html).toBe(`<button class="a b ${id}">x</button>`)
    expect(html).not.toContain('  ')
    expect(html).not.toContain('class=" ')
  })

  it('scopes a descendant selector on its subject', async () => {
    const { css, id } = await scoped(`<div><span>x</span></div>\n<style>div span { color: red }</style>`)
    expect(css).toContain(`div span.${id}`)
  })

  it('puts the class before a pseudo-element, not after it', async () => {
    // `a::before.hash` is invalid CSS — a pseudo-element must end the compound.
    const { css, id } = await scoped(`<a href="#">x</a>\n<style>a::before { content: "y" }</style>`)
    expect(css).toContain(`a.${id}::before`)
    expect(css).not.toContain(`::before.${id}`)
  })

  it('leaves :global and document-root selectors unscoped', async () => {
    const { css, id } = await scoped(
      `<div>x</div>\n<style>:global(.x) { color: red } :root { --a: 1 } body { margin: 0 }</style>`)
    expect(css).toContain('.x {')
    expect(css).toContain(':root {')
    expect(css).toContain('body {')
    expect(css).not.toContain(`.x.${id}`)
    expect(css).not.toContain(`:root.${id}`)
  })

  it('scopes the subject of a nested `& + sel`, not just the parent', async () => {
    // `& + p` puts `&` on the LEFT: the subject is the trailing `p`, and it
    // needs its own scope or the rule reaches any adjacent p on the page.
    const { css, id } = await scoped(
      `<div><p>a</p><p>b</p></div>\n<style>p { color: red; & + p { color: green } }</style>`)
    expect(css).toContain(`p.${id} + p.${id}`)
  })

  it('does not double-scope a compound that already contains &', async () => {
    const { css, id } = await scoped(`<p>x</p>\n<style>p { &:hover { color: blue } }</style>`)
    expect(css).toContain(`p.${id}:hover`)
    expect(css).not.toContain(`.${id}:hover.${id}`)
  })

  it('emits no scope class when the component has no styles', async () => {
    const { html } = await scoped(`<button>x</button>`)
    expect(html).toBe('<button>x</button>')
  })

  it('server and client agree on the scoped markup', async () => {
    const src = `<button class="b">x</button>\n<style>button { color: red }</style>`
    const Comp = await build(src)
    const server = strip(await renderToHTML(Comp, {}))
    const browser = renderOnClient(Comp)
    expect(server).toBe(browser)
    expect(server).toMatch(/^<button class="b m[0-9a-z]+">x<\/button>$/)
  })
})

/**
 * Scope ids are content-addressed, so compiler output is reproducible.
 *
 * `genId()` was `'m' + (Date.now() + counter).slice(-8)`, so two compilations of
 * the same source produced different scope classes — in one process, seconds
 * apart. Three things depended on that not being true: reproducible builds,
 * comparing compiler output across a change (13 false "differences" the first
 * time it was tried), and giving a component ONE id across the two compilers
 * that see it in a static build — Mesa's prerenderer and Vite — which is what
 * lets `addStyles` recognise a style already in the document.
 */
describe('CSS scope ids are content-addressed', () => {
  const idOf = async (src, filename) => {
    const ctx = await compileSource(src, { filename, css: false, dev: false, warning: () => {} })
    return ctx.css.id
  }

  it('is the same for the same styles, across compilations and filenames', async () => {
    const src = `<button>x</button>\n<style>button { color: red }</style>`
    const a = await idOf(src, '/one/A.mesa')
    const b = await idOf(src, '/somewhere/else/B.mesa')
    expect(a).toBe(b)
    expect(a).toMatch(/^m[0-9a-z]+$/)
  })

  it('differs when the styles differ', async () => {
    const a = await idOf(`<p>x</p>\n<style>p { color: red }</style>`, '/A.mesa')
    const b = await idOf(`<p>x</p>\n<style>p { color: blue }</style>`, '/A.mesa')
    expect(a).not.toBe(b)
  })

  it('makes the whole compiled module byte-identical across compilations', async () => {
    const src = `<script>\n  let n = 1\n</script>\n<div class="a"><button onclick={() => n++}>{n}</button></div>\n<style>button { color: red } div { padding: 2px }</style>`
    const one = await compileSource(src, { filename: '/R.mesa', dev: false, warning: () => {} })
    const two = await compileSource(src, { filename: '/R.mesa', dev: false, warning: () => {} })
    expect(one.result).toBe(two.result)
    expect(one.css.result).toBe(two.css.result)
  })

  it('renderComponent reports the same ids it used in the markup', async () => {
    const dir = path.join(process.cwd(), `_tmp_hash_${process.pid}`)
    mkdirSync(dir, { recursive: true })
    try {
      const file = path.join(dir, 'Styled.mesa')
      writeFileSync(file, `<button>x</button>\n<style>button { color: red }</style>`)
      const { html, styles, css } = await renderFile(file, { target: 'html', styleTag: false })

      expect(styles).toHaveLength(1)
      expect(html).toContain(`class="${styles[0].id}"`)
      expect(styles[0].css).toContain(`button.${styles[0].id}`)
      // styleTag:false means the caller assembles the document; nothing is
      // prepended, so the same rules cannot end up on the page twice.
      expect(html).not.toContain('<style')
      expect(css).toBe(styles[0].css)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
