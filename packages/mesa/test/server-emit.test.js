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
import { describe, it, expect, beforeAll } from 'vitest'
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
async function build(src, target) {
  const { result } = await compile(src, { target, filename: `S${n}.mesa`, dev: false, css: false, warning: quiet })
  const js = result
    .replace(/'@frontierjs\/mesa\/runtime\/server'/g, `'./src/runtime-server.js'`)
    .replace(/'@frontierjs\/mesa\/runtime'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_tmp_srv_${n++}.mjs`)
  writeFileSync(file, js)
  try { return (await import('file://' + file)).default } finally { try { unlinkSync(file) } catch {} }
}
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
    await expect(server(`<script>import Row from './Row.mesa'</script>\n<Row a="1" />\n`))
      .rejects.toThrow('<Row> at Counter.mesa:2:1 has no server lowering')
    await expect(server(`<script>let h = ''</script>\n<p>{@html h}</p>\n`))
      .rejects.toThrow('{@html} at Counter.mesa:2:4 has no server lowering')
  })
})

describe('server target — the same HTML as the DOM path', () => {
  beforeAll(async () => { await initRenderer() })

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
    'a spread overrides in place and appends': '<p {...o} id="x" data-z="2">t</p><p id="x" {...o}>t</p><p title={c} {...o} data-z="2">t</p>',
    'a once-written attribute lands ahead of the effects in its run': '<button disabled={on} hidden={!on} aria-expanded={!on} aria-hidden={!on} data-n={null} data-t={true} data-f={false} data-0={0}>b</button><button disabled={on} tabindex={-1} aria-hidden={true} title={c} data-k={null}>b</button>',
    'every piece in source order': '<p title={c} class:on={on} style:gap={c} {...o} data-a={c} data-k={null} class={c}>b</p><i {...o} title={c}>b</i>',
    'an object stringifies as the DOM does': '<p title={{a:1}} data-arr={[1,2]}>t</p>',
    'a comment is dropped': '<p>a<!-- hi -->b</p>',
    'whitespace follows the DOM builder': '<div>\n  <span>a</span>\n  text  here\n  <b>c</b>\n</div>',
    'a textarea and a pre keep their text whole': '<textarea>\n  hi {c}\n</textarea><pre>\n x </pre>',
    'entities and template syntax in text': '<p>a&nbsp;b &quot;q&quot; &#39;s&#39; &gt; &lt; {"$" + "{" + c + "}"} {`${c}`}</p>',
  }
  for (const [name, src] of Object.entries(table)) {
    it(name, async () => {
      const { dom, str } = await both(S + src)
      expect(str).toBe(dom)
    })
  }

  it('a preserved comment is written', async () => {
    const { result } = await server('<p>a<!-- hi -->b</p>', 'C.mesa', { preserveComments: true })
    expect(result).toContain("$$out.push('<p>a<!-- hi -->b</p>');")
  })
})
