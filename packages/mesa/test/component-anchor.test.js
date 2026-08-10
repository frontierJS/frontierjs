/**
 * component-anchor.test.js
 *
 * A component's anchor must be a node of its own.
 *
 * `FJS-110`. A pending label request is satisfied by the next text node, and the
 * compiler's `tpl` keeps those as separate entries while the emitted template is
 * one STRING — where adjacent text parses as a single DOM Text node. So two
 * components separated only by whitespace, inside a block, both resolved their
 * anchor to that one node.
 *
 * Nothing looked wrong. The DOM was correct — each component inserts before the
 * same node, in source order — so it rendered, laid out and clicked exactly as
 * written. But `_componentRegistry` is keyed BY ANCHOR, so the second
 * registration replaced the first, and the first component never received
 * another prop push for the life of the page.
 *
 * In `basecamp` that was
 *
 *   <Button disabled={busy === n.id || !picked}>Attach</Button>
 *   <Button onclick={…}>Cancel</Button>
 *
 * where Attach stayed disabled forever while a plain <button> carrying the
 * identical expression, two lines up, followed it. Eight probes against the real
 * kit components missed it because every one of them put a static element
 * between the two, which is exactly the thing that made the anchors distinct.
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

let n = 0
const compile = (src) =>
  compileSource(src, { filename: `/anchor${n++}.mesa`, dev: false }).then(c => c.result)

const anchorsOf = (js) => [...js.matchAll(/\bChild\((\w+),/g)].map(m => m[1])

const HEAD = `<script>\n  import Child from './Child.mesa'\n  let flag = true\n</script>\n`

describe('a component anchor is never shared', () => {
  // Whitespace between them is the whole point — with a static element or a bare
  // text run in between, the anchors were already distinct and the bug hid.
  const SHAPES = {
    'inside {#if}, newline-separated':
      `{#if flag}\n  <Child a={flag} />\n  <Child b={flag} />\n{/if}`,
    'inside {#if}, three of them':
      `{#if flag}\n  <Child a={flag} />\n  <Child b={flag} />\n  <Child c={flag} />\n{/if}`,
    'inside {:else}':
      `{#if flag}\n  <p>x</p>\n{:else}\n  <Child a={flag} />\n  <Child b={flag} />\n{/if}`,
    'inside {#each}':
      `{#each [1] as i}\n  <Child a={flag} />\n  <Child b={flag} />\n{/each}`,
    'inside an element':
      `<div>\n  <Child a={flag} />\n  <Child b={flag} />\n</div>`,
    'at component root':
      `<Child a={flag} />\n<Child b={flag} />`,
    'adjacent, no whitespace':
      `{#if flag}<Child a={flag} /><Child b={flag} />{/if}`,
  }

  for (const [name, body] of Object.entries(SHAPES)) {
    it(name, async () => {
      const anchors = anchorsOf(await compile(HEAD + body))
      expect(anchors.length, 'every component was emitted').toBeGreaterThan(1)
      expect(new Set(anchors).size, `anchors: ${anchors.join(', ')}`).toBe(anchors.length)
    })
  }

  // The registry is keyed by anchor, so a shared anchor means the second
  // registration wins and the first component is deaf from then on. This is the
  // consequence the shapes above are guarding — stated once, so a future reader
  // knows why distinct anchors matter rather than only that they are asserted.
  it('each component registers its own anchor and pushes to it', async () => {
    const js = await compile(HEAD + `{#if flag}\n  <Child a={flag} />\n  <Child b={flag} />\n{/if}`)
    const registered = [...js.matchAll(/registerComponentAnchor\((\w+)\)/g)].map(m => m[1])
    const pushed = [...js.matchAll(/pushProps\((\w+),/g)].map(m => m[1])
    expect(new Set(registered).size).toBe(registered.length)
    expect(new Set(pushed).size).toBe(pushed.length)
  })
})
