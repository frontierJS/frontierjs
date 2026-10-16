/**
 * `target: 'terminal'` — the emitted module, graded on its text. Imports
 * nothing from `runtime-terminal.js` or OpenTUI: node 22 cannot load the
 * engine, so what the module DOES is `test/terminal/` under bun; what it SAYS
 * is here. Pins the `$$host` import and calls, that no DOM machinery leaks in
 * (Invariant 15 — the output parses), and that every refusal names the
 * construct and its line in the one shape a portability report collects.
 */
import { describe, it, expect } from 'vitest'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'
import { hostOffenses } from '../src/host/emit.js'
import { TARGETS } from '../src/host/targets.js'

const terminal = (source, filename = 'Counter.mesa') =>
  compile(source, { target: 'terminal', filename, dev: false, warning: () => {} })

const COUNTER = `<script>
  let count = 0
  let items = ['a', 'b']
  const inc = () => { count++; items = [...items, 'x' + count] }
</script>
<div class="box">
  <h1>Counter</h1>
  <p>Count: {count}</p>
  <button onclick={inc}>Add</button>
  {#if count > 2}
    <p>Many</p>
  {:else}
    <p>Few</p>
  {/if}
  <ul>
    {#each items as it, i (it)}
      <li>{i}: {it}</li>
    {/each}
  </ul>
</div>
`

describe('terminal target', () => {
  it('emits a $$host module that parses and carries no DOM machinery', async () => {
    const { result } = await terminal(COUNTER)
    expect(() => acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()

    expect(result).toContain("import * as $$runtime from '@frontierjs/mesa/runtime.js';\nimport * as $$host from '@frontierjs/mesa/runtime/terminal.js';")
    expect(result).toContain("const $$el0 = $$host.element('div', { class: 'box' });")
    expect(result).toContain("$$host.append($$el1, $$host.text('Counter'));")
    expect(result).toContain('$$host.ifBlock($$m0, () => ($$runtime.get($$sig_count) > 2) ? 0 : 1, [')
    expect(result).toContain('$$host.eachBlock($$m1, () => ($$runtime.get($$sig_items)), (it, i) => (it), (it, i) => {')
    expect(result).toContain("$$host.on($$el3, 'click', $$runtime.get(inc));")
    expect(result).toContain("if (__prev.a !== __a) $$host.set_text($$t0, __prev.a = __a);")
    expect(result).toContain('$$host.append(__anchor, $$parentElement);')

    for (const dom of ['$$runtime.template(', '$$delegate', 'addStyles', 'document', '$$runtime.child(', '$$runtime.append(']) {
      expect(result).not.toContain(dom)
    }
  })

  it('writes an {:else} each factory and a bare if selector', async () => {
    const { result } = await terminal(`<script>
  let rows = []
  let on = false
</script>
{#each rows as r}<p>{r}</p>{:else}<p>none</p>{/each}
{#if on}<p>on</p>{/if}
`)
    expect(result).toContain('$$host.eachBlock($$m0, () => ($$runtime.get($$sig_rows)), null, (r) => {')
    expect(result).toContain('}, () => {')
    expect(result).toContain("$$host.append($$el1, $$host.text('none'));")
    expect(result).toContain('$$host.ifBlock($$m1, () => ($$runtime.get($$sig_on)) ? 0 : null, [')
  })

  it('destructures a row from the $$item getter', async () => {
    const { result } = await terminal(`<script>
  let rows = [[1, 2]]
</script>
{#each rows as [a, b], i (a)}<p>{a}{b}{i}</p>{/each}
`)
    expect(result).toContain('($$item, i) => { const [a, b] = $$item; return (a); }, ($$item, i) => {')
    expect(result).toContain('const $$pat1 = () => { const [a, b] = $$item(); return { a, b }; };')
    expect(result).toContain("${($$pat1().a) ?? ''}${($$pat1().b) ?? ''}${(i()) ?? ''}")
  })

  it('writes a live attribute through set_attribute from a guarded render, beside the static ones', async () => {
    const { result } = await terminal(`<script>
  let n = 0
</script>
<input placeholder="name" value={n} class="c {n}" />
`)
    expect(result).toContain("const $$el0 = $$host.element('input', { placeholder: 'name' });")
    expect(result).toContain('var __a; try { __a = ($$runtime.get($$sig_n)); } catch (e) { __a = $$runtime.contain(e, __prev.a); }')
    expect(result).toContain("if (__prev.a !== __a) $$host.set_attribute($$el0, 'value', __prev.a = __a);")
    expect(result).toContain('__a = (`c ${$$runtime.get($$sig_n)}`)')
    expect(result).toContain("$$host.set_attribute($$el0, 'class', __prev.a = __a);")
  })

  it('paints no style:, as it paints no static style or scoped CSS', async () => {
    const { result } = await terminal(`<script>
  let w = 3
</script>
<p style:gap="1rem" style:display={w ? 'none' : null}>t</p>
`)
    expect(result).toContain("const $$el0 = $$host.element('p');")
    expect(result).not.toMatch(/gap|display|none/)
  })

  describe('refuses by name, with the line', () => {
    const refusal = async (source, filename, message) => {
      await expect(terminal(source, filename)).rejects.toThrow(message)
    }
    const shape = /^\S.* at [A-Z]\.mesa:\d+:\d+ has no terminal lowering$/

    it('<iframe>', async () => {
      const source = `<div>\n<iframe></iframe>\n</div>\n`
      await refusal(source, 'A.mesa', '<iframe> at A.mesa:2:1 has no terminal lowering')
      await expect(terminal(source, 'A.mesa')).rejects.toThrow(shape)
    })

    // A caller that stripped a frontmatter block hands over `locLines`, and a
    // refusal names the FILE's line, as `data-fjs-loc` does (FJS-2519).
    it('the file\'s line when the caller rewrote the source', async () => {
      const prepared = `<div>\n<iframe></iframe>\n</div>\n`
      const locLines = [4, 5, 6, 7]
      await expect(compile(prepared, { target: 'terminal', filename: 'A.mesa', dev: false, locLines, warning: () => {} }))
        .rejects.toThrow('<iframe> at A.mesa:5:1 has no terminal lowering')
    })

    // Columns are equal shares of a row, so a spanning cell would put the
    // row's later values under the wrong header.
    it('colspan and rowspan on a cell, static or live', async () => {
      await refusal(`<table><tr><td>a</td>\n<td colspan="2">x</td></tr></table>\n`, 'S.mesa',
        'colspan on <td> at S.mesa:2:1 has no terminal lowering')
      await refusal(`<script>let n = 2</script>\n<table><tr><th rowspan={n}>x</th></tr></table>\n`, 'R.mesa',
        'rowspan on <th> at R.mesa:2:12 has no terminal lowering')
    })

    it('but not colspan on the only cell in its row, which fills the row already', async () => {
      await expect(terminal(`<script>let n = 2</script>\n<table><tr>\n  <!-- empty -->\n  <td colspan={n}>none</td>\n</tr></table>\n`, 'T.mesa')).resolves.toBeTruthy()
      await refusal(`<table><tr><td colspan="2" rowspan="2">x</td></tr></table>\n`, 'U.mesa',
        'rowspan on <td> at U.mesa:1:12 has no terminal lowering')
    })

    // `bind:value` is heard back only from a control, and only plain: a mask
    // reformats as the person types, which no terminal field does.
    it('an element bind: other than a plain bind:value on a control', async () => {
      await refusal(`<script>let v = false</script>\n<input type="checkbox" bind:checked|x={v} />\n`, 'B.mesa',
        'bind:checked|x at B.mesa:2:24 has no terminal lowering')
      await refusal(`<script>let v = ''</script>\n<input bind:value|mask({"99"})={v} />\n`, 'K.mesa',
        'bind:value|mask({"99"}) at K.mesa:2:8 has no terminal lowering')
      await refusal(`<script>let v = ''</script>\n<div bind:value={v}></div>\n`, 'V.mesa',
        'bind:value on <div> at V.mesa:2:6 has no terminal lowering')
    })

    // `type` is what makes an `<input>` a control; a live one is checked
    // where it is written, in the runtime.
    it('a static input type with no terminal control, and a bind that does not fit the type', async () => {
      await refusal(`<input type="range" />\n`, 'T.mesa', 'type="range" on <input> at T.mesa:1:1 has no terminal lowering')
      await refusal(`<input type="txt" />\n`, 'X.mesa', 'type="txt" on <input> at X.mesa:1:1 has no terminal lowering')
      await refusal(`<script>let v = false</script>\n<input bind:checked={v} />\n`, 'C.mesa',
        'bind:checked on <input type="text"> at C.mesa:2:8 has no terminal lowering')
      await refusal(`<script>let v = ''</script>\n<input type="radio" bind:value={v} />\n`, 'R.mesa',
        'bind:value on <input type="radio"> at R.mesa:2:21 has no terminal lowering')
      await refusal(`<script>let o = { v: [] }</script>\n<input type="checkbox" bind:group={o.v} />\n`, 'G.mesa',
        'bind:group at G.mesa:2:24 has no terminal lowering')
      for (const ok of [
        `<script>let t = 'range'</script>\n<input type={t} />\n`,
        `<script>let v = ''</script>\n<input type="datetime-local" bind:value={v} /><input type="week" />\n`,
        `<script>let v = []</script>\n<input type="checkbox" value="a" bind:group={v} /><input type="hidden" value="x" />\n`,
        `<script>let v = false</script>\n<input type="CheckBox" bind:checked={v} /><input type="password" />\n`,
      ]) await expect(terminal(ok, 'O.mesa')).resolves.toBeTruthy()
    })

    // A file input is a path field whatever hides it; only a bind is refused.
    it('a bound file input', async () => {
      await refusal(`<script>let v = ''</script>\n<input type="file" hidden bind:value={v} />\n`, 'V.mesa',
        'bind:value on <input type="file"> at V.mesa:2:27 has no terminal lowering')
      await refusal(`<script>let f</script>\n<input type="file" hidden bind:files={f} />\n`, 'B.mesa',
        'bind:files at B.mesa:2:27 has no terminal lowering')
      for (const ok of [
        `<input type="file" class="field" />\n`,
        `<script>let h = true</script>\n<input type="file" hidden={h} />\n`,
        `<input type="file" hidden />\n`,
        `<script>let a = '*/*'</script>\n<input type="file" accept={a} class="x visually-hidden" />\n`,
      ]) await expect(terminal(ok, 'O.mesa')).resolves.toBeTruthy()
    })

    // FJS-D895: a terminal draws no canvas to point at, so these stay out of
    // TERMINAL_EVENTS and the route that uses one stays refused.
    it('a pointer or wheel gesture', async () => {
      for (const event of ['pointerdown', 'pointermove', 'pointerup', 'wheel']) {
        await refusal(`<div on${event}={() => {}}></div>\n`, 'P.mesa', `on${event} at P.mesa:1:6 has no terminal lowering`)
      }
    })

    // A live `multiple` is checked where it is written, in the runtime.
    it('a static multiple on a <select>', async () => {
      await refusal(`<select multiple><option>a</option></select>\n`, 'M.mesa',
        'multiple on <select> at M.mesa:1:1 has no terminal lowering')
      await expect(terminal(`<script>let m = false</script>\n<select multiple={m}><option>a</option></select>\n`, 'L.mesa')).resolves.toBeTruthy()
    })

    it('ondblclick', async () => {
      await refusal(`<div ondblclick={() => {}}></div>\n`, 'D.mesa',
        'ondblclick at D.mesa:1:6 has no terminal lowering')
    })

    // The window is the end of every event's path; nothing in the corpus
    // listens at a document or a body, and a window property has no terminal.
    it('<mesa:document>, <mesa:body>, and a bind: or an unknown event on <mesa:window>', async () => {
      await refusal(`<mesa:document onkeydown={() => {}} />\n`, 'D.mesa',
        '<mesa:document> at D.mesa:1:1 has no terminal lowering')
      await refusal(`<mesa:body onclick={() => {}} />\n`, 'B.mesa',
        '<mesa:body> at B.mesa:1:1 has no terminal lowering')
      await refusal(`<script>let y = 0</script>\n<mesa:window bind:scrollY={y} />\n`, 'Y.mesa',
        'bind:scrollY at Y.mesa:2:14 has no terminal lowering')
      await refusal(`<mesa:window onresize={() => {}} />\n`, 'R.mesa',
        'onresize at R.mesa:1:14 has no terminal lowering')
    })

    // A portal's children are checked where they paint, which is in place.
    it('an offender inside a <mesa:portal>', async () => {
      await refusal(`<mesa:portal to={document.body}>\n  <div ondblclick={() => {}}></div>\n</mesa:portal>\n`, 'P.mesa',
        'ondblclick at P.mesa:2:8 has no terminal lowering')
    })

    // A browser moves live text into a field only until someone types.
    it('live text in a <textarea> with no value=', async () => {
      await refusal(`<script>let t = 'a'</script>\n<textarea>{t}</textarea>\n`, 'T.mesa',
        'live text in <textarea> without value= at T.mesa:2:1 has no terminal lowering')
    })

    it('{#await}', async () => {
      await refusal(`<script>let p = Promise.resolve(1)</script>\n{#await p}<p>w</p>{:then v}<p>{v}</p>{/await}\n`, 'E.mesa',
        '{#await} at E.mesa:2:1 has no terminal lowering')
    })

    it('a dynamic <component>', async () => {
      await refusal(`<script>import Foo from './Foo.mesa'</script>\n<component this={Foo} />\n`, 'F.mesa',
        '<component> at F.mesa:2:1 has no terminal lowering')
    })

    it('a literal <mesa:element> tag the table does not hold', async () => {
      await refusal(`<mesa:element this="iframe">x</mesa:element>\n`, 'M.mesa', '<iframe> at M.mesa:1:1 has no terminal lowering')
    })

    it('names the first offender only', async () => {
      await refusal(`<iframe></iframe>\n<Foo />\n`, 'G.mesa', '<iframe> at G.mesa:1:1 has no terminal lowering')
    })
  })

  // A resource file carries its model's default form (Invariant 18), and a
  // route importing only the data half must not inherit the form's refusal.
  describe('a refused file with a <script module> keeps its data half (FJS-2182)', () => {
    const RESOURCE = `<script module>\n  export const things = { name: 'things' }\n</script>\n<script>\n  import Form from './Form.mesa'\n  let record\n</script>\n<Form bind:record={record} />\n<iframe></iframe>\n`

    it('exports the module half, and a default that throws the refusal when mounted', async () => {
      const ctx = await terminal(RESOURCE, 'Thing.mesa')
      const message = '<iframe> at Thing.mesa:9:1 has no terminal lowering'
      expect(ctx.targetRefusal).toBe(message)
      acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
      // The instance script's imports go with it: Form.mesa is never loaded.
      expect(ctx.result).not.toMatch(/Form\.mesa|\$\$tui|\$\$runtime/)
      const mod = await import(/* @vite-ignore */ `data:text/javascript,${encodeURIComponent(ctx.result)}`)
      expect(mod.things).toEqual({ name: 'things' })
      expect(() => mod.default()).toThrow(message)
    })

    it('a lowering file sets no refusal', async () => {
      const ctx = await terminal(`<script module>\n  export const x = 1\n</script>\n<p>{x}</p>\n`, 'X.mesa')
      expect(ctx.targetRefusal).toBeUndefined()
      expect(ctx.result).toContain('$$host')
    })

    it('without a <script module> there is nothing to keep, and the compile throws', async () => {
      await expect(terminal(RESOURCE.replace(/<script module>[\s\S]*?<\/script>\n/, ''), 'Thing.mesa'))
        .rejects.toThrow('<iframe> at Thing.mesa:6:1 has no terminal lowering')
    })
  })

  it('calls a component at a marker, with its props, its content as snippets and a push for the live ones', async () => {
    const { result } = await terminal(`<script>
  import Card from './Card.mesa'
  let n = 0
</script>
<Card title="A" count={n} flag aria-label="x" onpick={() => n++}>
  <p>{n}</p>
  <b slot="actions">go</b>
</Card>
<Card />
`, 'P.mesa')
    expect(() => acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
    const props = "{title: 'A', count: $$runtime.get($$sig_n), flag: true, 'aria-label': 'x', onpick: () => $$runtime.postUpdate($$sig_n, $$set_n, +1), actions: $$snip0_actions, children: $$snip1_children}"
    expect(result).toContain('const $$m0 = $$host.marker();\n    $$host.append($$parentElement, $$m0);')
    expect(result).toContain(`Card($$m0, ${props}, null);`)
    expect(result).toContain("const $$snip0_actions = $$runtime.content((__anchor) => {\n      const $$b = $$host.fragment();\n      const $$el0 = $$host.element('b');")
    expect(result).toContain("const $$snip1_children = $$runtime.content((__anchor) => {\n      const $$b = $$host.fragment();\n      const $$el1 = $$host.element('p');")
    expect(result).toContain(`$$runtime.registerComponentAnchor($$m0);\n    $$runtime.createEffect(() => { $$runtime.pushProps($$m0, ${props}); });`)
    // All-static props: nothing to push, so no registration either.
    expect(result).toContain('Card($$m1, {}, null);\n    $$host.append(__anchor, $$parentElement);')
  })

  it('hands an element spread to $$host.spread in attribute order, after the static attributes', async () => {
    const { result } = await terminal(`<script>
  let a = { title: 'x' }
  let v = 'y'
</script>
<input placeholder="p" {...a} value={v} />
`, 'S.mesa')
    expect(() => acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
    expect(result).toContain("const $$el0 = $$host.element('input', { placeholder: 'p' });")
    const at = (s) => result.indexOf(s)
    expect(at('$$host.spread($$el0, () => ($$runtime.get($$sig_a)));')).toBeGreaterThan(at("$$host.element('input'"))
    expect(at("$$host.set_attribute($$el0, 'value'")).toBeGreaterThan(at('$$host.spread($$el0'))
  })

  it('merges a spread under the written props and pushes the whole object', async () => {
    const { result } = await terminal(`<script>
  import Card from './Card.mesa'
  let card = { title: 'S' }
</script>
<Card title="W" {...card} />
`, 'P.mesa')
    expect(() => acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
    const props = "Object.assign({}, ($$runtime.get($$sig_card)), {title: 'W'})"
    expect(result).toContain(`Card($$m0, ${props}, null);`)
    expect(result).toContain(`$$runtime.registerComponentAnchor($$m0);\n    $$runtime.createEffect(() => { $$runtime.pushProps($$m0, ${props}); });`)
  })

  it('reports an attribute no component takes, as the DOM path does, and passes nothing', async () => {
    const source = `<script>import Card from './Card.mesa'; const f = () => {}</script>
<Card onpick|capture={() => {}} class:on={true} #ref {*f} {@attach f} title="A" />
`
    const said = (target) => {
      const out = []
      return compile(source, { target, filename: 'P.mesa', dev: false, warning: (w) => out.push(w.message) })
        .then(({ result }) => ({ out, result }))
    }
    const dom = await said(undefined)
    const tui = await said('terminal')
    expect(tui.out).toEqual(dom.out)
    expect(tui.out.map((m) => m.split(' ')[0])).toEqual(['<Card', '<Card', '<Card', '<Card', '{@attach}'])
    expect(tui.out.every((m) => m.endsWith('P.mesa:2:1'))).toBe(true)
    expect(tui.result).toContain("Card($$m0, {title: 'A'}, null);")
    expect(dom.result).toContain("Card($$el0, {title: `A`}, null);")
  })

  // Both halves the DOM path wires, in its order: the bound value is a live
  // prop pushed down, bindProp takes the child's writes back up, and bind:this
  // is handed the child's exported interface.
  it('wires bind: and bind:this on a component through the anchor registry', async () => {
    const { result } = await terminal(`<script>import Foo from './Foo.mesa'\nlet v = 1\nlet value = 2\nlet r = null</script>
<Foo bind:value={v} bind:this={r} />
<Foo bind:value />
`, 'F.mesa')
    const m0 = [
      "Foo($$m0, {value: $$runtime.get($$sig_v)}, null);",
      '$$runtime.registerComponentAnchor($$m0);',
      "$$runtime.bindProp($$m0, 'value', (v) => $$set_v(v));",
      '$$set_r($$runtime.componentApi($$m0));',
      '$$runtime.createEffect(() => { $$runtime.pushProps($$m0, {value: $$runtime.get($$sig_v)}); });',
    ]
    expect(result).toContain(m0.join('\n    '))
    expect(result).toContain("$$runtime.bindProp($$m1, 'value', (v) => $$set_value(v));")
  })

  it('reports a component bind: with no setter in the same words on both targets, and wires nothing', async () => {
    const source = `<script>import Foo from './Foo.mesa'\nconst c = 1</script>\n<Foo bind:value={c} bind:this={c} />\n`
    const said = async (target) => {
      const out = []
      const { result } = await compile(source, { target, filename: 'P.mesa', dev: false, warning: (w) => out.push(w.message) })
      return { out, result }
    }
    const dom = await said(undefined)
    const tui = await said('terminal')
    expect(tui.out).toEqual(dom.out)
    expect(tui.out).toEqual([
      expect.stringMatching(/^bind:value=\{c\} — 'c' must be a writable top-level `let`.* — P\.mesa:3:1$/),
      expect.stringMatching(/^bind:this=\{c\} — 'c' must be a top-level let variable — P\.mesa:3:1$/),
    ])
    expect(tui.result).toContain('Foo($$m0, {}, null);')
    expect(tui.result).not.toMatch(/bindProp|componentApi|registerComponentAnchor/)
  })

  // The node goes to the setter once its handlers are on, and a listener's
  // options are the DOM's: `capture` and `once`, never `passive`.
  it('hands an element to bind:this and passes capture and once as listener options', async () => {
    const { result } = await terminal(`<script>let el = null\nconst f = () => {}</script>
<form bind:this={el} onsubmit|preventDefault={f} onblur|capture={f} oninput|once|passive={f}></form>
`, 'E.mesa')
    expect(result).toContain([
      "const $$el0 = $$host.element('form');",
      '$$host.append($$parentElement, $$el0);',
      "$$host.on($$el0, 'submit', ($$e) => { $$e.preventDefault(); (f)($$e); });",
      "$$host.on($$el0, 'blur', f, { capture: true });",
      "$$host.on($$el0, 'input', f, { once: true });",
      '$$set_el($$el0);',
    ].join('\n    '))
  })

  it('binds an element value after its handlers, through the getter and setter the DOM path writes', async () => {
    const { result } = await terminal(`<script>let v = ''\nlet d = {}\nconst f = () => {}</script>
<select bind:value={v} onchange={f}><option>a</option></select>
<input bind:value={d.name} />
`, 'V.mesa')
    expect(result).toContain([
      "$$host.on($$el0, 'change', f);",
      "$$host.bind($$el0, 'value', () => $$runtime.get($$sig_v), $$set_v);",
    ].join('\n    '))
    expect(result).toContain("$$host.bind($$el2, 'value', () => ($$runtime.get($$sig_d).name), ($$v) => { $$runtime.get($$sig_d).name = $$v; });")
  })

  it('reports an element bind:value it cannot write in the same words on both targets, and wires nothing', async () => {
    const source = `<script>const c = 1</script>\n<input bind:value={c} />\n`
    const said = async (target) => {
      const out = []
      const { result } = await compile(source, { target, filename: 'C.mesa', dev: false, warning: (w) => out.push(w.message) })
      return { out, result }
    }
    const dom = await said(undefined)
    const tui = await said('terminal')
    expect(tui.out).toEqual(dom.out)
    expect(tui.out).toEqual(['bind:value={c} — cannot two-way bind: `const c` cannot be reassigned. Declare it `let`.'])
    expect(tui.result).not.toMatch(/\$\$tui\.bind/)
  })

  it('reports an element bind:this with no setter in the same words on both targets, and wires nothing', async () => {
    const source = `<script>const c = 1</script>\n<div bind:this={c}></div>\n<p bind:this></p>\n`
    const said = async (target) => {
      const out = []
      const { result } = await compile(source, { target, filename: 'P.mesa', dev: false, warning: (w) => out.push(w.message) })
      return { out, result }
    }
    const dom = await said(undefined)
    const tui = await said('terminal')
    expect(tui.out).toEqual(dom.out)
    expect(tui.out).toEqual([
      "bind:this={c} — 'c' must be a top-level let variable",
      'bind:this requires a variable: bind:this={myRef}',
    ])
    expect(tui.result).not.toMatch(/\$\$set_c/)
  })

  it('reports a component bind:this whose target is not a let, which the DOM path dropped', async () => {
    const out = []
    await compile(`<script>import Card from './Card.mesa'; const r = null</script>\n<Card bind:this={r} />\n`,
      { filename: 'P.mesa', dev: false, warning: (w) => out.push(w.message) })
    expect(out).toEqual([expect.stringMatching(/^bind:this=\{r\} — 'r' must be a top-level let variable — P\.mesa:2:1$/)])
  })

  it('renders a <slot> from the prop of its name, its fallback when the caller passed none, and declares the prop', async () => {
    const { result } = await terminal(`<section>
  <slot><p>empty</p></slot>
  <slot name="actions" />
</section>
`, 'Card.mesa')
    expect(result).toContain(`$$runtime.unclaimedContent(__props, ["children","actions"], 'Card', ["children","actions"]);`)
    expect(result).toContain('$$host.ifBlock($$m0, () => ($$runtime.get($$sig_children)) ? 0 : 1, [')
    expect(result).toContain('{ const $$sf = $$runtime.get($$sig_actions); if ($$sf) $$sf($$m2); }')
  })

  // The author marked it as carrying nothing a reader needs, so the terminal
  // paints what assistive technology reads; outside one it is still refused.
  it('drops a tag it cannot paint on or inside aria-hidden="true", and only there', async () => {
    const { result } = await terminal(`<div aria-hidden="true"><svg><path d="M0 0" /></svg><b>*</b></div>
<svg aria-hidden="true"><path d="M0 0" /></svg>
<p>t</p>
`)
    expect(result).not.toMatch(/svg|path/)
    expect(result).toContain("$$host.element('b')")
    expect(result).toContain("$$host.element('p')")
    await expect(terminal(`<div aria-hidden="false"><iframe></iframe></div>\n`, 'N.mesa')).rejects.toThrow('<iframe> at N.mesa:1:26')
  })

  it('declares a body snippet before its renders, and hands each argument over as a getter', async () => {
    const { result } = await terminal(`<script>export let action = null\nlet n = 1</script>
{@render body(n + 1)}
{@render action?.()}
{#snippet body(x)}<p>{x}</p>{/snippet}
`)
    const decl = result.indexOf('const $$snippet_body = (__anchor, x) => {')
    expect(decl).toBeGreaterThan(-1)
    expect(result.indexOf('$$snippet_body($$m0, () => ($$runtime.get($$sig_n) + 1));')).toBeGreaterThan(decl)
    expect(result).toContain('{ const $$sf = $$runtime.get($$sig_action); if ($$sf) $$sf($$m1); }')
    expect(result).toContain('`${(x()) ?? \'\'}`')
  })

  it('passes a snippet to a component under a name of its own, and keys a <mesa:element> on its tag', async () => {
    const { result } = await terminal(`<script>import T from './T.mesa'\nlet l = 2</script>
<T>{#snippet row(r)}<p>{r}</p>{/snippet}</T>
<T>{#snippet row(r)}<b>{r}</b>{/snippet}</T>
<mesa:element this={'h' + l}>x</mesa:element>
`)
    expect(result).toContain('T($$m0, {row: $$snip0_row}, null);')
    expect(result).toContain('T($$m1, {row: $$snip1_row}, null);')
    expect(result).toContain("$$host.keyBlock($$m2, () => ('h' + $$runtime.get($$sig_l)), ($$tag) => {")
    expect(result).toContain('$$host.element($$tag);')
  })

  it('hostOffenses lists every offender in document order, grouped by shape', async () => {
    const { ir } = await compile(`<script>import Foo from './Foo.mesa'
  let v = ''
  let x = 'a'
</script>
<table><tr><td class={x} colspan={x}>{v}</td><td>z</td></tr></table>
<input bind:value={v} bind:checked={v} />
{#if v}<button onclick|once={() => {}} onpointerenter={() => {}}>b</button>{/if}
{#each [1] as n}<Foo {...v} bind:x={v} onpick={() => {}}><iframe>{#snippet s()}x{/snippet}</iframe></Foo>{/each}
`, { filename: 'H.mesa', dev: false, warning: () => {} })
    expect(hostOffenses(ir, TARGETS.terminal).map((o) => [o.what, o.shape, o.loc])).toEqual([
      ['colspan on <td>', 'colspan on <td>', 'H.mesa:5:12'],
      ['bind:checked on <input type="text">', 'bind:checked on <input type="text">', 'H.mesa:6:23'],
      ['onpointerenter', 'onpointerenter', 'H.mesa:7:40'],
      ['<iframe>',     '<iframe>',          'H.mesa:8:58'],
    ])
  })
})
