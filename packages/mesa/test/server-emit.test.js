/**
 * `target: 'server'` — the host emitter's string mode (`FJS-D1634`), graded
 * on its text and on what it writes. Three things are pinned: the module
 * parses and carries no node machinery (Invariant 15 — a push per static run,
 * `if` and `for` for the blocks); a kind the mode does not write yet is
 * refused by name and line, in the shape every target's refusal takes; and
 * the HTML it writes is BYTE-IDENTICAL to what the DOM path serializes
 * through happy-dom for the same source, which is what makes the mode
 * admissible (plan § 3). The parity table is the attribute arrangements that
 * disagreed while the mode was built: each row is a rule the serializer
 * mirrors — where happy-dom places a `class` a toggle created, which live
 * attribute a `set_attribute` writes once ahead of the effects, what a spread
 * overrides in place.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'
import { createRoot } from '../src/runtime.js'
import { initRenderer, renderToHTML } from '../src/render.js'

const quiet = () => {}
const server = (source, filename = 'Counter.mesa', extra = {}) =>
  compile(source, { target: 'server', filename, dev: false, css: false, warning: quiet, ...extra })

let n = 0
/** Compile and import as a build tool would; the module is written to the package root so its runtime imports resolve. */
async function build(src, target, extra = {}) {
  const { result } = await compile(src, { target, filename: `S${n}.mesa`, dev: false, css: false, warning: quiet, ...extra })
  const js = result
    .replace(/'@frontierjs\/mesa\/runtime\/server'/g, `'./src/runtime-server.js'`)
    .replace(/'@frontierjs\/mesa\/runtime'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_tmp_srv_${n++}.mjs`)
  writeFileSync(file, js)
  try { return (await import('file://' + file)).default } finally { try { unlinkSync(file) } catch {} }
}
// A child a parent imports by path, kept on disk until the suite ends.
const kept = []
async function buildKept(src, target, extra = {}) {
  const { result } = await compile(src, { target, filename: `S${n}.mesa`, dev: false, css: false, warning: quiet, ...extra })
  const js = result
    .replace(/'@frontierjs\/mesa\/runtime\/server'/g, `'./src/runtime-server.js'`)
    .replace(/'@frontierjs\/mesa\/runtime'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_tmp_srv_${n++}.mjs`)
  writeFileSync(file, js)
  kept.push(file)
  return './' + path.basename(file)
}
afterAll(() => { for (const f of kept) try { unlinkSync(f) } catch {} })
const renderString = (Comp, props = {}) => {
  let html = ''
  createRoot((dispose) => { const out = []; Comp(out, props); html = out.join(''); dispose() })
  return html
}
async function both(src, props = {}) {
  const dom = await renderToHTML(await build(src), props)
  const str = renderString(await build(src, 'server'), props)
  return { dom, str }
}
/** `parent` names its child `__CHILD__`; each path imports the child built for it. */
async function bothTree(parent, child, props = {}, extra = {}) {
  const dom = await renderToHTML(await build(parent.replace('__CHILD__', await buildKept(child, undefined, extra)), undefined, extra), props)
  const str = renderString(await build(parent.replace('__CHILD__', await buildKept(child, 'server', extra)), 'server', extra), props)
  return { dom, str }
}

const COUNTER = `<script>
  let count = 0
  let items = ['a', 'b']
</script>
<div class="box" title={count}>
  <h1>Counter &amp; more</h1>
  <p>Count: {count} ok</p>
  <button onclick={() => count++}>Add</button>
  {#if count > 2}<p>Many</p>{:else}<p>Few</p>{/if}
  <ul>{#each items as it, i (it)}<li>{i}: {it}</li>{:else}<li>none</li>{/each}</ul>
  <input value="x">
</div>
`

describe('server target — the emitted module', () => {
  it('parses, pushes a static run at a time and carries no node machinery', async () => {
    const { result } = await server(COUNTER)
    expect(() => acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
    expect(result).toContain("import * as $$host from '@frontierjs/mesa/runtime/server';")
    expect(result).toContain('const $$out = __anchor;')
    expect(result).toMatch(/\$\$out\.push\(`<div\$\{\$\$host\.attrs\('div', \[\['class', 'box'\], \['title', \(\$\$runtime\.get\(\$\$sig_count\)\), 1\]\], 'm[0-9a-z]+'\)\}><h1>Counter &amp; more<\/h1><p>Count: \$\{\$\$host\.esc\(\$\$runtime\.get\(\$\$sig_count\)\)\} ok<\/p><button>Add<\/button>`\);/)
    expect(result).toContain('if ($$runtime.get($$sig_count) > 2) {')
    expect(result).toContain("$$out.push('<p>Many</p>');")
    expect(result).toContain('if ($$arr0.length) for (let $$i0 = 0; $$i0 < $$arr0.length; $$i0++) {')
    expect(result).toContain('const it = () => $$arr0[$$i0], i = () => $$i0;')
    expect(result).toContain("$$out.push('</ul><input value=\"x\"></div>');")
    for (const dom of ['$$host.element(', '$$host.append(', '$$host.ifBlock', '$$host.eachBlock', '$$runtime.render(', '$$runtime.template(', 'document']) {
      expect(result).not.toContain(dom)
    }
  })

  it('escapes static text and attributes at compile time, through the runtime\'s own functions', async () => {
    const { result } = await server(`<p title="a &amp; &quot;b&quot;">&lt;b&gt; &amp; x</p>`)
    expect(result).toContain(`$$out.push('<p title="a &amp; &quot;b&quot;">&lt;b&gt; &amp; x</p>');`)
  })

  it('refuses a kind it does not write yet, naming the construct and its line', async () => {
    const M = `<script>const m = $.mounted(async () => {})</script>`
    await expect(server(`${M}<mesa:portal><p>x</p></mesa:portal>\n<p><mesa:mounted><b>c</b></mesa:mounted></p>\n`))
      .rejects.toThrow('<mesa:mounted> at Counter.mesa:2:4 has no server lowering')
  })

  it('drops every bind: on an element and hands bind:this null', async () => {
    const { result } = await server(`<script>let v = 'hi'; let on = true; let g = ['b']; let m = '12'; let f = null; let el; let c</script>
<input bind:value={v}><input type="checkbox" bind:checked={on}><input type="checkbox" value="b" bind:group={g}>
<input bind:value|mask("99-99")={m}><input type="checkbox" :checked={on}><input type="file" bind:files={f}>
<div bind:this={el}>a</div><mesa:element this="b" bind:this={el}>q</mesa:element>`)
    expect(result).toContain(`'<input><input type="checkbox"><input type="checkbox" value="b"><input><input type="checkbox"><input type="file"><div>a</div>'`)
    for (const dom of ['bindInput', 'bindGroup', 'bindMask', '$$host.bind']) expect(result).not.toContain(dom)
    expect(result.match(/\$\$set_el\(null\);/g)).toHaveLength(2)
  })

  it('writes {@html} as a hole the runtime parses', async () => {
    const { result } = await server(`<script>let h = '<b>x</b>'</script>\n<div>{@html h}</div>\n`)
    expect(result).toContain('$$out.push(`<div>${$$host.html($$runtime.get($$sig_h))}</div>`);')
  })

  it('writes a dynamic element through the runtime\'s tag, a head into its buffer, a portal into nothing and a boundary as branches', async () => {
    const { result } = await server(`<script>
  let tag = 'h2'
  const user = await Promise.resolve({ name: 'a' })
</script>
<mesa:element this={tag} class="t">Hi</mesa:element>
<mesa:head><title>T</title><style>b { color: red }</style></mesa:head>
<mesa:portal><p>gone</p></mesa:portal>
<mesa:boundary>
  {#snippet pending()}<p>wait</p>{/snippet}
  <p>{user.name}</p>
</mesa:boundary>
{#snippet failed(error, reset)}<em>{error.message}</em>{/snippet}
`)
    expect(() => acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
    expect(result).toContain('const $$tag = $$host.dynamicTag($$runtime.get($$sig_tag));')
    expect(result).toContain("$$out.push(`<${$$tag}${$$host.attrs($$tag, [['class', 't']], ")
    expect(result).toContain('if (!$$host.VOID.has($$tag)) {')
    expect(result).toContain('const $$head = $$host.head($$out);')
    expect(result).toContain("$$out.push('<style>b { color: red }</style><title>T</title>');")
    expect(result).toContain("const $$out = [];\n      $$out.push('<p>gone</p>');")
    expect(result).toContain('const $$states = [$$async_user];')
    expect(result).toContain('if ($$err) { $$snippet_failed($$out, () => $$err.error, () => {}); }')
    expect(result).toContain('else if ($$states.some((s) => s.loading)) { $$snippet_pending($$out); }')
    for (const dom of ['keyBlock', 'boundaryBlock', 'addToHead', 'addHeadStyle', 'portal(']) expect(result).not.toContain(dom)
  })

  it('calls a child with $$out and the props once, and renders an island inline without islands', async () => {
    const { result } = await server(`<script>import Row from './Row.mesa'; let n = 1</script>\n<Row a="1" n={n} bind:n client:load>{#snippet cell(x)}<i>{x}</i>{/snippet}<b>k</b></Row>\n`)
    expect(() => acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
    expect(result).toMatch(/Row\(\$\$out, \{a: '1', n: \$\$runtime\.get\(\$\$sig_n\), n: \$\$runtime\.get\(\$\$sig_n\), cell: \$\$snip0_cell, children: \$\$snip1_children\}\);/)
    for (const dom of ['registerComponentAnchor', 'pushProps', 'bindProp', 'island(']) expect(result).not.toContain(dom)
  })

  it('wraps an island in $$host.island under islands, with the DOM path\'s meta', async () => {
    const src = `<script>import Row from './Row.mesa'; let n = 1</script>\n<Row a="1" n={n} client:media="(max-width: 600px)" />\n`
    const { result } = await server(src, 'Counter.mesa', { islands: true })
    expect(result).toContain(`$$host.island($$out, Row, {a: '1', n: $$runtime.get($$sig_n)}, {"component":"Row","directive":"media","media":"(max-width: 600px)"});`)
  })
})

describe('server target — the same HTML as the DOM path', () => {
  beforeAll(async () => { await initRenderer() })

  it('an island: the marker, its payload and the child inside it, nested and in a table', async () => {
    const child = `<script>export let start = 0; export let rows = []</script>\n<button>{start}</button>{#each rows as r}<tr><td>{r}</td></tr>{/each}`
    const parent = `<script>import C from '__CHILD__'; let k = 2</script>\n` +
      `<article><p>s</p><C client:load start={k + 1} /><C start={9} /></article>` +
      `<table><tbody><C client:media="(min-width: 600px)" rows={['a']} /></tbody></table>`
    const { dom, str } = await bothTree(parent, child, {}, { islands: true })
    expect(str).toBe(dom)
    expect(str).toContain('<!--mesa-island {"component":"C","directive":"load","props":{"start":3}}--><button>3</button><!--/mesa-island--><button>9</button></article>')
    expect(str).toContain('<tbody><!--mesa-island {"component":"C","directive":"media","media":"(min-width: 600px)","props":{"rows":["a"]}}--><button>0</button><tr><td>a</td></tr><!--/mesa-island--></tbody>')
    // Without the flag neither path writes a marker.
    const off = await bothTree(parent, child)
    expect(off.str).toBe(off.dom)
    expect(off.str).not.toContain('mesa-island')
  })

  it('a component of elements, text, blocks, a const and a snippet', async () => {
    const { dom, str } = await both(`<script>
  let count = 3
  let rows = [[1, 2], [3, 4]]
  let items = []
</script>
<div class="box" title={count}>
  <h1>Counter &amp; more &lt;3 &nbsp;x</h1>
  <p>Count: {count} ok</p>
  {#if count > 2}<p>Many</p>{:else if count > 1}<p>Some</p>{:else}<p>Few</p>{/if}
  <ul>{#each items as it, i (it)}<li>{i}: {it}</li>{:else}<li>none</li>{/each}</ul>
  {#each rows as [a, b], i (a)}<p>{a}{b}{i}</p>{/each}
  {#key count}<span>{count}</span>{/key}
  {@const twice = count * 2}
  <i>{twice}</i>
  {#snippet cell(x)}<td>{x}</td>{/snippet}
  <table><tbody>{#each rows as r}<tr>{@render cell(r[0])}</tr>{/each}</tbody></table>
  <pre>
line1
  line2
</pre>
  <span>a</span> <span>b</span>
  <img src="/a.png" alt="x"><br>
  <svg viewBox="0 0 1 1"><path d="M0 0" /></svg>
</div>
`)
    expect(str).toBe(dom)
    expect(str).toContain('<p>Many</p><ul><li>none</li></ul><p>120</p><p>341</p><span>3</span><i>6</i><table><tbody><tr><td>1</td></tr><tr><td>3</td></tr></tbody></table><pre>\nline1\n  line2\n</pre><span>a</span> <span>b</span>')
  })

  it('a child component: props, a spread, bind:, content and a named snippet', async () => {
    const { dom, str } = await bothTree(`<script>
  import Row from '__CHILD__'
  let n = 7
  let extra = { b: 'B' }
  let items = [1, 2]
</script>
<ul>{#each items as it}<Row a="x" n={it} {...extra}>{#snippet cell(x)}<i>{x}</i>{/snippet}<b>kid</b></Row>{/each}<Row bind:n /></ul>
`, `<script>
  export let a = 'none'
  export let b = ''
  export let n = 0
  export let cell = null
  export let children = null
</script>
<li class="row" data-a={a}>{b}{n}{#if children}{@render children()}{/if}{#if cell}{@render cell(n * 10)}{/if}</li>
`)
    expect(str).toBe(dom)
    expect(str.replace(/ m[0-9a-z]+"/g, '"')).toBe('<ul><li class="row" data-a="x">B1<b>kid</b><i>10</i></li><li class="row" data-a="x">B2<b>kid</b><i>20</i></li><li class="row" data-a="none">7</li></ul>')
  })

  it('a style a directive, a spread and a literal fight over, where the DOM path serializes it', async () => {
    const { dom, str } = await both(`<script>
  let sp = { id: 'x', 'aria-label': 'L', style: '--a: 1' }
  let empty = { style: '' }
  let nil = null
</script>
<div class="c" style:opacity={nil} {...sp}></div>
<div class="c" style:opacity={0.5} {...sp}></div>
<div class="c" {...sp} style:opacity={0.5}></div>
<div class="c" style:opacity={nil} id="x" style="--a: 1"></div>
<div class="c" style:opacity={0.5} id="x" style={sp.style} style:left="1px"></div>
<div class="c" style:opacity={nil} {...empty} id="x"></div>
<div class="c" {...empty} style:opacity={nil} id="x"></div>
<div class="c" id="x" style="" style:opacity={nil}></div>
<div class="c" id="x" style=""></div>
`)
    expect(str).toBe(dom)
    // A directive that writes nothing creates no attribute; a spread's style
    // is the CSSOM's text, replaces every directive before it and keeps an
    // empty one unless a directive runs after.
    expect(str.replace(/ m[0-9a-z]+"/g, '"').replace(/<\/div>/g, '</div>\n').trim()).toBe(`<div class="c" id="x" aria-label="L" style="--a: 1;"></div>
<div class="c" style="--a: 1;" id="x" aria-label="L"></div>
<div class="c" id="x" aria-label="L" style="--a: 1; opacity: 0.5;"></div>
<div id="x" class="c" style="--a: 1;"></div>
<div id="x" class="c" style="--a: 1; left: 1px;"></div>
<div id="x" class="c" style=""></div>
<div id="x" class="c"></div>
<div id="x" class="c"></div>
<div id="x" style="" class="c"></div>`)
  })

  it('a hostile value cannot leave its text or its attribute', async () => {
    const { dom, str } = await both(`<script>
  let v = '<img src=x onerror=alert(1)>" onmouseover="x'
  let u = 'javascript:alert(1)'
</script>
<p title={v}>{v}</p><a href={u}>x</a><a href="/x?a=1&b=2">&amp; "q" 'q'</a>
`)
    expect(str).toBe(dom)
    // happy-dom's attribute serializer escapes `&` and `"` only, which is
    // correct HTML5: a `<` inside a quoted value cannot open a tag.
    expect(str).toBe(`<p title="<img src=x onerror=alert(1)>&quot; onmouseover=&quot;x">&lt;img src=x onerror=alert(1)&gt;" onmouseover="x</p><a>x</a><a href="/x?a=1&amp;b=2">&amp; "q" 'q'</a>`)
  })

  const S = `<script>let c = 'live'; let on = true; let v = 'val'; let o = { 'data-s': 1, id: 'spread' }; let st = 'color: red'</script>\n`
  const table = {
    'a static class is written after the other statics, with the scope id': '<p id="x" class="a" data-y="1">t</p>',
    'a styled component stamps the scope on every element': '<style>p{color:red}</style><p id="x" data-y="1">t</p>',
    'a live class': '<p id="x" class={c} data-y="1">t</p>',
    'a live class under a scope': '<style>p{color:red}</style><p id="x" class={c} data-y="1">t</p>',
    'a toggle creates the class where it ran': '<p id="x" class:on={on} data-y="1">t</p><tr class:odd={on} data-id={c}></tr>',
    'class tokens compose in the order they ran': '<p class="a" class:on={on} class:off={!on}>t</p><p class={c} class:on={on} id="i">b</p><p class:on={on} class={c}>b</p>',
    'a style: directive re-serializes the whole style': '<p style="color:red" style:gap="1px" style:margin={v ? "2px" : null}>t</p><p style={st} style:gap="1px">t</p><p style:gap="1px">t</p><p style="color:red;">t</p>',
    'checked, selected and a select value are properties, an input value an attribute': '<input type="checkbox" checked={on} value={v}><input value="x" checked><select value={v}><option value="val">A</option><option value="b" selected>B</option></select>',
    'a spread overrides in place and appends, and its handlers are not attributes': '<p {...o} id="x" data-z="2">t</p><p id="x" {...o}>t</p><p title={c} {...o} data-z="2">t</p><button {...{ onclick: () => {}, title: c }}>b</button>',
    'a once-written attribute lands ahead of the effects in its run': '<button disabled={on} hidden={!on} aria-expanded={!on} aria-hidden={!on} data-n={null} data-t={true} data-f={false} data-0={0}>b</button><button disabled={on} tabindex={-1} aria-hidden={true} title={c} data-k={null}>b</button>',
    'every piece in source order': '<p title={c} class:on={on} style:gap={c} {...o} data-a={c} data-k={null} class={c}>b</p><i {...o} title={c}>b</i>',
    'an object stringifies as the DOM does': '<p title={{a:1}} data-arr={[1,2]}>t</p>',
    'a comment is dropped': '<p>a<!-- hi -->b</p>',
    'whitespace follows the DOM builder': '<div>\n  <span>a</span>\n  text  here\n  <b>c</b>\n</div>',
    'a textarea and a pre keep their text whole': '<textarea>\n  hi {c}\n</textarea><pre>\n x </pre>',
    'entities and template syntax in text': '<p>a&nbsp;b &quot;q&quot; &#39;s&#39; &gt; &lt; {"$" + "{" + c + "}"} {`${c}`}</p>',
    'a literal style is the first write after the template': '<p style="color:red" id="a" class="k" title={c}>t</p><p {...o} style="color:red">t</p><style>p{}</style><td align="center" style="padding:24px 0;">t</td><p class={c} style="color:red">t</p>',
    'the scope class sits after the statics when no class is authored': '<style>p{}</style><p title={c} data-x="1">t</p><p title={c} class={c}>t</p><p {...o}>t</p><p class:on={on} data-x="1">t</p>',
    'an empty style stays from a plain write and goes once a directive touched it': '<tr style="{\'\'}"></tr><p style="">t</p><p style={null} id="a">t</p><p style:gap={null}>t</p><p style="{\'\'}" style:gap={null}>t</p>',
    'a live value is a property on a text-like input, a textarea and a select, an attribute elsewhere': '<input value={c}><input type="number" value={c}><input type={c} value={c}><input value={\'\'}><input {...{ value: c }}><input type="checkbox" value={c}><input type="hidden" value={c}><input type="submit" value={c}><textarea value={c}></textarea><select value={c}><option value={c}>a</option></select><progress value={3} max="10"></progress><meter value={3}></meter><ol><li value={3}>a</li></ol><button value={c}>b</button><data value={c}>d</data>',
    'a touched class is a token list, a lone static one is the template\'s text': '<p class={\'a  b \'}>t</p><p class="x {c} ">t</p><p class="x {\'\'}">t</p><p class="x " class:on={on}>t</p><p class={\' a \'} class:on={on}>t</p><p class="y  z ">t</p><style>p{}</style><p class="w ">t</p>',
    'an each body loses the whitespace at its edges, an if branch keeps it': '<ul>{#each [1, 2] as it}\n  <li>{it}</li> \n{/each}</ul><ul>{#each [] as it}<li>{it}</li>{:else}\n  <li>none</li>\n{/each}</ul><div>{#if on}\n  <p>x</p>\n{/if}</div>',
  }
  for (const [name, src] of Object.entries(table)) {
    it(name, async () => {
      const { dom, str } = await both(S + src)
      expect(str).toBe(dom)
    })
  }

  it('a dynamic element: its tag, attributes, children, a void tag, and the refusals both paths share', async () => {
    const src = `<script>
  export let tag = 'h2'
  export let id = 'x'
  export let on = true
</script>
<mesa:element this={tag} class="t" id={id} class:on={on} style:color="red" data-k>Hi <b>{id}</b></mesa:element><p>after</p>`
    for (const props of [{ tag: 'h2' }, { tag: 'SECTION', id: null, on: false }, { tag: 'br' }, { tag: 'input', id: 'q' }]) {
      const { dom, str } = await both(src, props)
      expect(str).toBe(dom)
    }
    const h2 = await both(src, { tag: 'h2' })
    expect(h2.str).toBe('<h2 data-k="" class="t mztntfp9zlo on" id="x" style="color: red;">Hi <b>x</b></h2><p>after</p>')
    expect((await both(src, { tag: 'br' })).str).toBe('<br data-k="" class="t mztntfp9zlo on" id="x" style="color: red;"><p>after</p>')
    // A void tag writes no children on either path, as a parser would place none inside it.
    for (const bad of ['script', 'style', 'meta']) {
      const Str = await build(src, 'server')
      expect(() => renderString(Str, { tag: bad })).toThrow(`<${bad}> refused`)
      await expect(renderToHTML(await build(src), { tag: bad })).rejects.toThrow(`<${bad}> refused`)
    }
    const Str = await build(src, 'server')
    expect(() => renderString(Str, { tag: '' })).toThrow('expected a tag name')
    await expect(renderToHTML(await build(src), { tag: null })).rejects.toThrow('expected a tag name')
    // happy-dom's createElement takes any string, so the DOM path would
    // write these as markup too.
    for (const bad of ['div onmouseover=alert(1)', 'b><img src=x onerror=alert(1)', 'p/x']) {
      expect(() => renderString(Str, { tag: bad })).toThrow('not a name an element can have')
      await expect(renderToHTML(await build(src), { tag: bad })).rejects.toThrow('not a name an element can have')
    }
  })

  it('a spread\'s keys are data: a hostile name, a markup key and a string handler are refused on both paths, each with its warning', async () => {
    const src = `<script>
  let a = { 'x" onmouseover="alert(1)': 'y', title: 'kept', innerHTML: '<b>x</b>', srcdoc: 'q', text: 't', onclick: 'alert(1)', href: 'javascript:alert(1)', 'aria-expanded': false, hidden: true, n: null, f: false, num: 0, 'data-ü': 1, '@click': 'z', 'x:y': 2 }
</script>
<div {...a}>hi</div><iframe {...a}></iframe>`
    const warned = []
    const warn = console.warn
    console.warn = (m) => warned.push(String(m))
    let dom, str
    try { ({ dom, str } = await both(src)) } finally { console.warn = warn }
    expect(str).toBe(dom)
    expect(str).not.toMatch(/onmouseover|onclick|srcdoc|innerHTML|javascript/i)
    expect(str).toContain('title="kept"')
    for (const k of ['onmouseover', 'innerHTML', 'srcdoc', 'onclick']) expect(warned.some((w) => w.includes(k))).toBe(true)
  })

  it('a head and a portal: neither path writes them into the body; the string mode keeps the head for the page', async () => {
    const src = `<script>
  export let title = 'T'
  export let throws = false
  const boom = () => { throw new Error('portal content') }
</script>
<mesa:head><title>{title}</title><meta name="k" content="v"><style>b { color: red }</style></mesa:head>
<main>body</main>
<mesa:portal><p>{throws ? boom() : 'in the body'}</p></mesa:portal>`
    const { dom, str } = await both(src)
    expect(str).toBe(dom)
    expect(str).toBe('<main>body</main>')
    // The DOM path builds the portal's content into a detached body, so a
    // throw inside it fails the render; the string mode builds it too.
    const Str = await build(src, 'server')
    expect(() => renderString(Str, { throws: true })).toThrow('portal content')
    await expect(renderToHTML(await build(src), { throws: true })).rejects.toThrow('portal content')
    // The head lands in the page, once, as written; the DOM path has nowhere to put it.
    const page = await renderToHTML(Str, { title: 'A & B' }, { target: 'server', full: true, title: 'Page' })
    expect(page).toContain('<title>Page</title>\n<style>b { color: red }</style><title>A &amp; B</title><meta name="k" content="v">\n</head>')
    expect(page).toContain('<body>\n<main>body</main>\n</body>')
    expect(page.match(/<meta name="k"/g)).toHaveLength(1)
    expect(await renderToHTML(Str, {}, { target: 'server' })).toBe('<main>body</main>')
  })

  it('a boundary: content, pending while an await is open, failed on its error, and a throw that fails both renders', async () => {
    const src = `<script>
  export let mode = 'content'
  export let throws = false
  const user = await (mode === 'pending' ? new Promise(() => {}) : mode === 'error' ? Promise.reject(new Error('nope')) : Promise.resolve({ name: 'ann' }))
  const boom = () => { throw new Error('content threw') }
</script>
<mesa:boundary>
  {#snippet pending()}<p class="p">wait</p>{/snippet}
  <p>{throws ? boom() : user?.name ?? 'none'}</p>
</mesa:boundary>
<mesa:boundary><i>plain</i></mesa:boundary>
{#snippet failed(error, reset)}<em>{error.message}</em>{/snippet}`
    for (const mode of ['content', 'pending', 'error']) {
      const { dom, str } = await both(src, { mode })
      expect(str).toBe(dom)
    }
    // Serialization runs before the promise settles on both paths: a resolved
    // await is still pending at the time of the write (plan Q3).
    expect((await both(src, { mode: 'content' })).str).toBe('<p class="p mztntfp9zlo">wait</p><i>plain</i>')
    expect((await both(src, { mode: 'pending' })).str).toBe('<p class="p mztntfp9zlo">wait</p><i>plain</i>')
    const Str = await build(src, 'server')
    expect(() => renderString(Str, { throws: true, mode: 'content' })).not.toThrow()
    // A boundary reading no await writes its content now, and a throw there
    // is caught on neither path (FJS-D377).
    const plain = `<script>export let throws = false; const boom = () => { throw new Error('content threw') }</script>
<mesa:boundary><p>{throws ? boom() : 'ok'}</p></mesa:boundary>{#snippet failed(e)}<em>{e.message}</em>{/snippet}`
    expect((await both(plain)).str).toBe('<p>ok</p>')
    expect((await both(plain)).dom).toBe('<p>ok</p>')
    const Plain = await build(plain, 'server')
    expect(() => renderString(Plain, { throws: true })).toThrow('content threw')
    await expect(renderToHTML(await build(plain), { throws: true })).rejects.toThrow('content threw')
  })

  // The DOM path writes a bound value to a property — `bindInput`,
  // `bindGroup`, `bindMask` — and happy-dom serializes no property, so the
  // string mode writes nothing for a bind (`FJS-D1643`); what an authored
  // `value=`, `checked` or `selected` beside it says is kept on both paths.
  it('bind: on a control writes nothing on either path, whatever the control holds', async () => {
    const S = `<script>let v = 'hi'; let n = 3; let u; let on = true; let off = false; let t = 'multi\\nline'; let s = 'b'; let many = ['a', 'c']; let none = 'zz'; let g = ['b']; let m = '1234'; let f = null</script>\n`
    const src = [
      '<input bind:value={v}><input value="zz" bind:value={v}><input type="number" bind:value={n}><input bind:value={u}>',
      '<input type="checkbox" bind:checked={on}><input type="checkbox" checked bind:checked={off}><input type="checkbox" :checked={on}>',
      '<textarea bind:value={t}></textarea><textarea bind:value={v}>seed</textarea>',
      '<select bind:value={s}><option value="a">A</option><option value="b">B</option></select>',
      '<select multiple bind:value={many}><option value="a">A</option><option value="b">B</option><option value="c">C</option></select>',
      '<select bind:value={none}><option value="a">A</option><option value="b" selected>B</option></select>',
      '<input type="checkbox" value="a" bind:group={g}><input type="checkbox" value="b" bind:group={g}><input type="radio" value="a" bind:group={s}><input type="radio" value="b" bind:group={s}>',
      '<input bind:value|mask("99-99")={m}><input type="file" bind:files={f}>',
    ].join('')
    const { dom, str } = await both(S + src)
    expect(str).toBe(dom)
    expect(str).toBe('<input><input value="zz"><input type="number"><input><input type="checkbox"><input type="checkbox" checked=""><input type="checkbox"><textarea></textarea><textarea>seed</textarea><select><option value="a">A</option><option value="b">B</option></select><select multiple=""><option value="a">A</option><option value="b">B</option><option value="c">C</option></select><select><option value="a">A</option><option value="b" selected="">B</option></select><input type="checkbox" value="a"><input type="checkbox" value="b"><input type="radio" value="a"><input type="radio" value="b"><input><input type="file">')
  })

  // The DOM path hands the node, so a script that writes on it lands an
  // attribute the string mode cannot: the corpus sets such a tree aside as
  // `boundNode` (`FJS-D1640`). A script that guards on the node agrees.
  it('bind:this is null on the string path and a node on the DOM path; a guarded write agrees, an unguarded one is the boundNode set-aside', async () => {
    const guarded = `<script>let el; let c; $: el && el.setAttribute('x', '1')</script><div bind:this={el}>a</div><p>{el === null ? 'null' : 'node'}</p>`
    const { dom, str } = await both(guarded)
    expect(str).toBe('<div>a</div><p>null</p>')
    expect(dom).toBe('<div x="1">a</div><p>node</p>')
    const comp = await bothTree(`<script>import C from '__CHILD__'; let c</script><C /><p>{c === null ? 'null' : typeof c}</p>`.replace('<C />', '<C bind:this={c} />'), '<i>k</i>')
    expect(comp.str).toBe('<i>k</i><p>null</p>')
    expect(comp.dom).toBe('<i>k</i><p>object</p>')
  })

  it('a dev build stamps data-fjs-loc where the DOM path does: before class, from a recorded field, and completing a Markdown stamp', async () => {
    const src = `<script>
import { recorded } from './src/runtime.js'
let t = 'x'
const item = recorded({ name: 'N', other: 'o' }, [[['name'], 'data.md:3:1']])
</script>
<div id="a" class="b" title="c">x</div><p class:on={t} data-k="1" title={t}>y</p><span>{t}</span><b>{item.name}</b><i>{item.other}</i><em data-fjs-loc="6:1">md</em>`
    const extra = { loc: true, filename: 'L.mesa' }
    const dom = await renderToHTML(await build(src, undefined, extra))
    const str = renderString(await build(src, 'server', extra))
    expect(str).toBe(dom)
    expect(str).toContain('<div id="a" title="c" data-fjs-loc="L.mesa:6:1" class="b')
    expect(str).toContain('<b data-fjs-loc="data.md:3:1">N</b><i data-fjs-loc="L.mesa:6:')
    expect(str).toContain('<em data-fjs-loc="L.mesa:6:1">md</em>')
    expect(renderString(await build(src, 'server', { filename: 'L.mesa' }))).not.toContain('data-fjs-loc')
  })

  it('a preserved comment is written', async () => {
    const { result } = await server('<p>a<!-- hi -->b</p>', 'C.mesa', { preserveComments: true })
    expect(result).toContain("$$out.push('<p>a<!-- hi -->b</p>');")
  })
  it('{@html}: parsed as the client parses it — repaired, anchors stripped, authored comments kept — on both paths', async () => {
    const src = (h) => `<script>let h = ${JSON.stringify(h)}; let n = 0</script>
<div>{@html h}</div><pre>{@html h}</pre><table><tbody>{#each [1, 2] as i}{@html h}{/each}</tbody></table><p>{@html n}</p><p>{@html null}</p><p>{@html undefined}</p>`
    const cases = [
      '<b>bold</b> & <i>open',
      '<p>a<p>b',
      '<!--$--><!--$ name --><!-- keep --><!--[if mso]>x<![endif]--><!--mesa-root-->',
      '<tr><td>cell &amp; more</td></tr>',
      'a & b < c > d',
      '<script>1<2</script><style>a > b {}</style>',
      '<svg><path d="M0"/></svg>',
      '',
    ]
    for (const h of cases) {
      const { dom, str } = await both(src(h))
      expect(str, h).toBe(dom)
    }
    const { str } = await both(src('<p>a<p>b<!--$--><!-- keep -->'))
    expect(str).toContain('<div><p>a</p><p>b<!-- keep --></p></div>')
    expect(str).toContain('<p>0</p><p></p><p></p>')
  })

  it('a spread key with no document installed is refused by the characters that end a name, and that answer is not kept', async () => {
    const Comp = await build(`<script>export let a = {}</script>\n<p {...a}>x</p>\n`, 'server')
    const doc = globalThis.document
    const warn = console.warn
    console.warn = () => {}
    delete globalThis.document
    try {
      expect(renderString(Comp, { a: { 'x" onclick="y': 1, '-k': 2 } })).toBe('<p -k="2">x</p>')
    } finally { globalThis.document = doc; console.warn = warn }
    // happy-dom refuses `-k`, and the render with no document did not decide it.
    console.warn = () => {}
    try { expect(renderString(Comp, { a: { '-k': 2 } })).toBe('<p>x</p>') } finally { console.warn = warn }
  })

  it('{@html} with no document installed throws by name', async () => {
    const Comp = await build(`<script>let h = '<b>x</b>'</script>\n<div>{@html h}</div>\n`, 'server')
    const doc = globalThis.document
    delete globalThis.document
    try { expect(() => renderString(Comp)).toThrow('initRenderer()') } finally { globalThis.document = doc }
  })
})

// ─── {#await} (FJS-D1647) ─────────────────────────────────────────────────────

describe('{#await}: both paths wait and write the settled branch', () => {
  // renderToHTML on both paths: the harness's synchronous renderString cannot wait.
  async function bothAwait(src, props = {}) {
    const dom = await renderToHTML(await build(src), props)
    const str = await renderToHTML(await build(src, 'server'), props, { target: 'server' })
    return { dom, str }
  }

  const CASES = {
    resolved: `<script>let p = Promise.resolve({ n: 2, name: 'a<b' })</script>
<div>{#await p}<i>wait</i>{:then { n, name }}<b>{n} {name}</b>{:catch e}<s>{e.message}</s>{/await}</div>`,
    rejected: `<script>let p = Promise.reject(new Error('no & way'))</script>
<p>{#await p}wait{:then v}{v}{:catch e}<s>{e.message}</s>{/await}</p>`,
    rejectedNoCatch: `<script>let p = Promise.reject(new Error('x'))</script>
<p>a{#await p}wait{:then v}{v}{/await}b</p>`,
    plainValue: `<script>let v = 7</script>
<p>{#await v}wait{:then x}<b>{x}</b>{/await}</p>`,
    noThen: `<script>let p = Promise.resolve(1)</script>
<p>{#await p}wait{/await}done</p>`,
    nested: `<script>
  const inner = () => new Promise((r) => setTimeout(() => r('deep'), 5))
  let p = Promise.resolve(inner)
</script>
<ul>{#await p}<li>1</li>{:then f}<li>outer</li>{#await f()}<li>2</li>{:then d}<li>{d}</li>{/await}{/await}<li>tail</li></ul>`,
    shadowedProp: `<script>export let value = 'prop'; let p = Promise.resolve('then')</script>
<p>{value}{#await p}{:then value}<b>{value}</b>{/await}</p>`,
    formatted: `<script>let p = Promise.resolve('v'); let q = Promise.reject(new Error('e'))</script>
<section>
  {#await p}
    <i>wait</i>
  {:then v}
    <b>{v}</b>
    tail
  {/await}
  {#await q}
    wait
  {:catch e}
    <s>{e.message}</s>
  {/await}
</section>`,
    inEach: `<script>let rows = [1, 2, 3].map((n) => Promise.resolve(n * 10))</script>
<ol>{#each rows as r}<li>{#await r}…{:then v}{v}{/await}</li>{/each}</ol>`,
  }
  for (const [name, src] of Object.entries(CASES)) {
    it(name, async () => {
      const { dom, str } = await bothAwait(src)
      expect(str).toBe(dom)
      expect(dom).not.toMatch(/wait|…/)
    })
  }

  it('writes the settled bytes, a pattern bound and the value escaped', async () => {
    const { dom, str } = await bothAwait(CASES.resolved)
    expect(dom).toBe('<div><b>2 a&lt;b</b></div>')
    expect(str).toBe(dom)
    expect((await bothAwait(CASES.nested)).str).toBe('<ul><li>outer</li><li>deep</li><li>tail</li></ul>')
    expect((await bothAwait(CASES.shadowedProp)).dom).toBe('<p>prop<b>then</b></p>')
  })

  it('a component in {:then} finds $context across the await, and its head joins the page', async () => {
    const parent = `<script>
  import Child from '__CHILD__'
  $context.tone = 'warm'
  let p = new Promise((r) => setTimeout(() => r('x'), 5))
</script>
<main>{#await p}wait{:then v}<Child {v} />{/await}</main>`
    const child = `<script>export let v; const tone = $context.tone</script>
<mesa:head><title>{v}</title></mesa:head><i>{v}:{tone}</i>`
    const domComp = await build(parent.replace('__CHILD__', await buildKept(child)))
    const strComp = await build(parent.replace('__CHILD__', await buildKept(child, 'server')), 'server')
    const dom = await renderToHTML(domComp)
    expect(dom).toBe('<main><i>x:warm</i></main>')
    expect(await renderToHTML(strComp, {}, { target: 'server' })).toBe(dom)
    expect(await renderToHTML(strComp, {}, { target: 'server', full: true })).toMatch(/<head>[\s\S]*<title>x<\/title>[\s\S]*<\/head>/)
  })

  it('renders queue: one waiting on a slow promise does not take the next one\'s', async () => {
    const slow = await build(`<script>let p = new Promise((r) => setTimeout(() => r('slow'), 20))</script>
<p>{#await p}{:then v}{v}{/await}</p>`)
    const fast = await build(`<script>let p = Promise.resolve('fast')</script>
<p>{#await p}{:then v}{v}{/await}</p>`)
    const [a, b] = await Promise.all([renderToHTML(slow), renderToHTML(fast)])
    expect([a, b]).toEqual(['<p>slow</p>', '<p>fast</p>'])
  })

  it('a render that throws leaves no promise for the next one to wait on', async () => {
    const thrower = await build(`<script>let p = new Promise(() => {})</script>
<p>{#await p}{:then v}{v}{/await}{(() => { throw new Error('late') })()}</p>`)
    await expect(renderToHTML(thrower)).rejects.toThrow(/late/)
    const ok = await build(`<script>let p = Promise.resolve(1)</script><p>{#await p}{:then v}{v}{/await}</p>`)
    expect(await renderToHTML(ok)).toBe('<p>1</p>')
  })

  it('a settled branch that throws fails the render on both paths', async () => {
    const src = `<script>let p = Promise.resolve(1); const boom = () => { throw new Error('in then') }</script>
<p>{#await p}wait{:then v}<b>{boom()}</b>{/await}</p>`
    await expect(renderToHTML(await build(src))).rejects.toThrow(/in then/)
    await expect(renderToHTML(await build(src, 'server'), {}, { target: 'server' })).rejects.toThrow(/in then/)
  })

  it('<mesa:mounted> is not waited on: onMount never runs on a server', async () => {
    const Comp = await build(`<script>const mounting = $.mounted(async () => {})</script>
<mesa:mounted>{#snippet pending()}<i>loading</i>{/snippet}<b>content</b></mesa:mounted>`)
    expect(await renderToHTML(Comp)).toBe('<i>loading</i>')
  })
})
