/**
 * `lower(ctx)` — the IR a compile leaves on `ctx.ir`. Pins the tree for the
 * terminal contract's Counter fixture node for node, including the `loc`
 * strings; that a node with no lowering is NAMED rather than dropped; the
 * each-row accessor frame (`it` → `it()`, a destructured name → `$$pat1().a`,
 * the key with plain parameters); and a text with two bindings as one node.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'

const quiet = { warning: () => {} }
const ir = async (source, filename) => (await compile(source, { ...quiet, filename })).ir

const stat = (value) => ({ kind: 'static', value })
const el = (tag, loc, children, extra = {}) => ({
  kind: 'element', tag, loc, attrs: [], handlers: [], directives: [], styles: [], children, selfClosing: false, ...extra,
})
const text = (...parts) => ({ kind: 'text', parts, static: parts.every((p) => p.kind === 'static') })

const COUNTER = `<script>
  let count = 0
  let items = ['a', 'b']
  const inc = () => { count++; items = [...items, 'x' + count] }
</script>
<div class="box">
  <h1>Counter</h1>
  <p>Count: {count}</p>
  <button on:click={inc}>Add</button>
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

describe('lower()', () => {
  it('lowers the Counter fixture to the contract tree', async () => {
    const tree = await ir(COUNTER, 'Counter.mesa')
    expect(tree).toEqual({
      kind: 'root',
      diagnostics: [],
      children: [
        el('div', 'Counter.mesa:6:1', [
          el('h1', 'Counter.mesa:7:3', [text(stat('Counter'))]),
          el('p', 'Counter.mesa:8:3', [
            text(stat('Count: '), {
              kind: 'binding', to: 'text',
              expr: { raw: 'count', code: '$$runtime.get($$sig_count)', reads: ['count'] },
            }),
          ]),
          el('button', 'Counter.mesa:9:3', [text(stat('Add'))], {
            handlers: [{
              event: 'click', modifiers: [], loc: 'Counter.mesa:9:11',
              expr: { raw: 'inc', code: '$$runtime.get(inc)', reads: ['inc'] },
            }],
          }),
          {
            kind: 'if',
            loc: 'Counter.mesa:10:3',
            branches: [{
              test: { raw: 'count > 2', code: '$$runtime.get($$sig_count) > 2', reads: ['count'] },
              children: [text(stat('\n    ')), el('p', 'Counter.mesa:11:5', [text(stat('Many'))]), text(stat('\n  '))],
            }],
            else: [text(stat('\n    ')), el('p', 'Counter.mesa:13:5', [text(stat('Few'))]), text(stat('\n  '))],
          },
          el('ul', 'Counter.mesa:15:3', [{
            kind: 'each',
            loc: 'Counter.mesa:16:5',
            items: { raw: 'items', code: '$$runtime.get($$sig_items)', reads: ['items'] },
            item: { name: 'it' },
            index: 'i',
            key: { raw: 'it', code: 'it', reads: [] },
            children: [
              text(stat('\n      ')),
              el('li', 'Counter.mesa:17:7', [
                text(
                  { kind: 'binding', to: 'text', expr: { raw: 'i', code: 'i()', reads: ['i'] } },
                  stat(': '),
                  { kind: 'binding', to: 'text', expr: { raw: 'it', code: 'it()', reads: ['it'] } },
                ),
              ]),
              text(stat('\n    ')),
            ],
            else: null,
          }]),
        ], { attrs: [{ name: 'class', value: 'box' }] }),
      ],
    })
  })

  it('names {#await} and a dynamic <component> as unlowered, with their position', async () => {
    const tree = await ir(`<script>
  import Foo from './Foo.mesa'
  let p = Promise.resolve(1)
</script>
{#await p}
  <p>wait</p>
{:then v}
  <p>{v}</p>
{/await}
<component this={Foo} />
`, 'U.mesa')
    expect(tree.children).toEqual([
      { kind: 'unlowered', what: 'await', loc: 'U.mesa:5:1', node: expect.objectContaining({ type: 'await' }) },
      { kind: 'unlowered', what: 'component', loc: 'U.mesa:10:1', node: expect.objectContaining({ name: 'component' }) },
    ])
  })

  it('lowers a component call: props, directives, refusals, slots routed as the DOM path routes them', async () => {
    const tree = await ir(`<script>
  import Card from './Card.mesa'
  let n = 0
</script>
<Card title="A" count={n} flag class="x" label="n is {n}" onpick={() => n++} bind:open={n} on:close={() => {}} client:load>
  <!-- not content -->
  <p>{n}</p>
  <b slot="actions">go</b>
  {#if n}<i slot="aside">a</i>{/if}
  {#snippet row(r)}<p>{r}</p>{/snippet}
</Card>
<slot name="tail"><p>none</p></slot>
`, 'C.mesa')
    const [card, slot] = tree.children.filter((c) => c.kind !== 'text')
    expect(card).toMatchObject({ kind: 'component', name: 'Card', call: 'Card', loc: 'C.mesa:5:1' })
    expect(card.props.map((p) => [p.name, typeof p.value === 'object' ? p.value.expr.code : p.value])).toEqual([
      ['title', 'A'],
      ['count', '$$runtime.get($$sig_n)'],
      ['flag', true],
      ['$class', 'x'],
      ['label', '`n is ${$$runtime.get($$sig_n)}`'],
      ['onpick', '() => $$runtime.postUpdate($$sig_n, $$set_n, +1)'],
    ])
    expect(card.directives.map((d) => d.name)).toEqual(['bind:open'])
    // Refused for every target by componentAttributes: reported, never passed.
    expect(tree.diagnostics).toEqual([expect.stringMatching(/^on:close is not valid on a component\..* — C\.mesa:5:1$/)])
    expect(Object.keys(card.slots)).toEqual(['actions', 'aside', 'default'])
    expect(card.slots.default.map((c) => c.kind === 'element' ? c.tag : c.kind)).toEqual(['comment', 'p'])
    expect(card.slots.actions[0]).toMatchObject({ kind: 'element', tag: 'b', attrs: [] })
    expect(card.slots.aside[0]).toMatchObject({ kind: 'if' })
    expect(card.slots.aside[0].branches[0].children[0]).toMatchObject({ tag: 'i', attrs: [] })
    expect(card.snippets).toEqual([expect.objectContaining({ kind: 'unlowered', what: 'snippet' })])
    expect(slot).toMatchObject({ kind: 'slot', name: 'tail', directives: [], fallback: [expect.objectContaining({ tag: 'p' })] })
  })

  it('lowers a destructuring each with an index under the row frame', async () => {
    const tree = await ir(`<script>
  let rows = [[1, 2]]
</script>
<ul>
  {#each rows as [a, b], i (a)}
    <li>{a}{i}</li>
  {/each}
</ul>
`, 'E.mesa')
    expect(tree.children).toEqual([
      el('ul', 'E.mesa:4:1', [{
        kind: 'each',
        loc: 'E.mesa:5:3',
        items: { raw: 'rows', code: '$$runtime.get($$sig_rows)', reads: ['rows'] },
        item: { pattern: '[a, b]', names: ['a', 'b'], fn: '$$pat1' },
        index: 'i',
        key: { raw: 'a', code: 'a', reads: [] },
        children: [
          text(stat('\n    ')),
          el('li', 'E.mesa:6:5', [
            text(
              { kind: 'binding', to: 'text', expr: { raw: 'a', code: '$$pat1().a', reads: ['a'] } },
              { kind: 'binding', to: 'text', expr: { raw: 'i', code: 'i()', reads: ['i'] } },
            ),
          ]),
          text(stat('\n  ')),
        ],
        else: null,
      }]),
    ])
  })

  it('keeps a text with two bindings as one node of four parts', async () => {
    const tree = await ir(`<script>
  let a = 1, b = 2
</script>
<p>{a} and {b}!</p>
`, 'T.mesa')
    expect(tree.children).toEqual([
      el('p', 'T.mesa:4:1', [
        text(
          { kind: 'binding', to: 'text', expr: { raw: 'a', code: '$$runtime.get($$sig_a)', reads: ['a'] } },
          stat(' and '),
          { kind: 'binding', to: 'text', expr: { raw: 'b', code: '$$runtime.get($$sig_b)', reads: ['b'] } },
          stat('!'),
        ),
      ]),
    ])
  })

  it('lowers style: in its three spellings, apart from the attributes', async () => {
    const tree = await ir(`<script>
  let fontSize = 2, w = 3
</script>
<p style:font-size style:gap={w} style:width="{w}ch" class="x">t</p>
`, 'S.mesa')
    const p = tree.children[0]
    expect(p.attrs).toEqual([{ name: 'class', value: 'x' }])
    expect(p.directives).toEqual([])
    expect(p.styles).toEqual([
      { prop: 'font-size', loc: 'S.mesa:4:4', expr: { raw: 'fontSize', code: '$$runtime.get($$sig_fontSize)', reads: ['fontSize'] } },
      { prop: 'gap', loc: 'S.mesa:4:20', expr: { raw: 'w', code: '$$runtime.get($$sig_w)', reads: ['w'] } },
      { prop: 'width', loc: 'S.mesa:4:34', expr: { raw: '{w}ch', code: '`${$$runtime.get($$sig_w)}ch`', reads: ['w'] } },
    ])
  })

  it('leaves the DOM compile where it found it', async () => {
    // Lowering enters the each frame and bumps the same counters the DOM
    // builder numbers `$$pat1` by; the DOM output must still start at 1.
    const ctx = await compile(`<script>
  let rows = [[1, 2]]
</script>
{#each rows as [a, b]}<i>{a}</i>{/each}
`, quiet)
    expect(ctx.result).toContain('const $$pat1 = () => {')
    expect(ctx.result).not.toContain('$$pat2')
  })
})
