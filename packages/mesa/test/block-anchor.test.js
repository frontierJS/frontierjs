/**
 * block-anchor.test.js
 *
 * A BLOCK's anchor must be a node of its own — the rule `component-anchor.test.js`
 * pins for a component invocation (`FJS-110`), applied to `{#if}`, `{#each}`,
 * `{#key}`, `{#await}`, `{@render}` and `{@html}`.
 *
 * A pending label request is satisfied by the next text node, and the compiler's
 * `tpl` keeps those as separate entries while the emitted template is one
 * STRING — where adjacent text parses as a single DOM Text node. So two blocks
 * separated only by whitespace resolved their anchor to that one node.
 *
 * For a component the cost was a prop push landing on the wrong registration.
 * For a block it is DOM: each block inserts its content before the shared
 * anchor, so the second block's nodes sit inside the first block's
 * [marker, anchor) range. Tearing the first branch down removes the second
 * one's content with it, and the block that built it has no reason to run
 * again — so it stays gone until something rebuilds the whole subtree.
 *
 * That is `FJS-512`, which was read as a `{#if}` going stale while an attribute
 * on the same element stayed current: the blocks did re-run, and their content
 * was eaten by a sibling's removal in the same flush. Which of the two happens
 * first is what decides whether a given page shows it, which is why the same
 * shape passed in one fixture and failed in an app.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import { flushSync, mount } from '../src/runtime.js'

let n = 0
const compile = (src) =>
  compileSource(src, { filename: `/block${n++}.mesa`, dev: false }).then(c => c.result)

const HEAD = `<script>\n  let a = true\n  let b = true\n</script>\n`

// The first argument of every block call is its anchor.
const anchorsOf = (js) =>
  [...js.matchAll(/\$\$runtime\.(?:ifBlock|keyBlock|awaitBlock|\$\$eachBlock)\((\w+),/g)].map(m => m[1])

describe('a block anchor is never shared', () => {
  // Whitespace between them is the whole point — a static element or a bare text
  // run in between already made the anchors distinct, which is where every
  // earlier probe of this looked.
  const SHAPES = {
    '{#if} beside {#if}, newline-separated':
      `{#if a}<i>A</i>{/if}\n{#if b}<i>B</i>{/if}`,
    'three of them, inside an element':
      `<div>\n  {#if a}<i>A</i>{/if}\n  {#if b}<i>B</i>{/if}\n  {#if a && b}<i>C</i>{/if}\n</div>`,
    'inside a branch of an outer chain':
      `{#if a}\n  <div>\n    {#if a}<i>A</i>{/if}\n    {#if b}<i>B</i>{/if}\n  </div>\n{/if}`,
    '{#if} beside {#each}':
      `<div>\n  {#if a}<i>A</i>{/if}\n  {#each [1] as i}<i>{i}</i>{/each}\n</div>`,
    '{#key} beside {#if}':
      `<div>\n  {#key a}<i>K</i>{/key}\n  {#if b}<i>B</i>{/if}\n</div>`,
    'separated by an interpolation':
      `<div>\n  {#if a}<i>A</i>{/if}\n  {a}\n  {#if b}<i>B</i>{/if}\n</div>`,
    'adjacent, no whitespace':
      `<div>{#if a}<i>A</i>{/if}{#if b}<i>B</i>{/if}</div>`,
  }

  for (const [name, body] of Object.entries(SHAPES)) {
    it(name, async () => {
      const anchors = anchorsOf(await compile(HEAD + body))
      expect(anchors.length, 'every block was emitted').toBeGreaterThan(1)
      expect(new Set(anchors).size, `anchors: ${anchors.join(', ')}`).toBe(anchors.length)
    })
  }
})

// ─── the cost, through the compiler and a real mount ────────────────────────

const tick = () => new Promise((r) => setTimeout(r, 0))

async function render(src, deps = {}) {
  // Written to the package root (cwd), not beside this file, so the rewritten
  // runtime import resolves — and so does a sibling module written beside it.
  const id = n
  const written = []
  const emit = async (source, name) => {
    const js = (await compile(source)).replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'./src/runtime.js'`)
    const file = path.join(process.cwd(), `${name}.mjs`)
    writeFileSync(file, js)
    written.push(file)
    return file
  }
  for (const [name, source] of Object.entries(deps)) await emit(source, `_tmp_block_anchor_${id}_${name}`)
  const file = await emit(src.replace(/__ID__/g, `_tmp_block_anchor_${id}_`), `_tmp_block_anchor_${id}_main`)
  let Comp
  try { Comp = (await import('file://' + file)).default }
  finally { for (const f of written) { try { unlinkSync(f) } catch {} } }
  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const label = document.createElement('span')
  wrap.appendChild(label)
  mount(label, Comp, { props: {} })
  flushSync(); await tick(); flushSync(); await tick()
  return wrap
}

const click = async (wrap, sel) => {
  wrap.querySelector(sel).click()
  flushSync(); await tick(); flushSync(); await tick()
}

describe('one block tearing down leaves its siblings alone', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('a sibling {#if} whose test did not change keeps its content', async () => {
    // Inside an outer branch, because that is where the shared anchor was
    // reachable: a component-root template has its whitespace collapsed, which
    // removed the text node the two blocks were sharing. A block body keeps it.
    const wrap = await render(`<script>
  let shown = true
  let a = true
  let b = true
</script>
{#if shown}
  <div id="box">
    {#if a}<i id="a">A</i>{/if}
    {#if b}<i id="b">B</i>{/if}
  </div>
{/if}
<button id="off" on:click={() => a = false}>off</button>`)

    expect(wrap.querySelector('#a')).toBeTruthy()
    expect(wrap.querySelector('#b')).toBeTruthy()
    await click(wrap, '#off')
    expect(wrap.querySelector('#a'), 'the block that turned off is gone').toBeFalsy()
    expect(wrap.querySelector('#b'), 'the block beside it is untouched').toBeTruthy()
  })

  it('one branch turning off while the next turns on — both land', async () => {
    // basecamp's action row: a set of legal moves derived from a row, one
    // {#if} per move. The move that becomes legal is built before the move that
    // stopped being legal is removed, so the new content was inside the old
    // block's range and went with it — an empty action row (`FJS-512`).
    // A COMPONENT in each branch, because what decides whether this shape shows
    // the bug is which of the two blocks the flush reaches first. With plain
    // elements the removal happened to run before the insertion and the page
    // was correct; a component adds a prop-push effect, the subscriber order
    // inverts, and the new content is built into the range that is about to go.
    const wrap = await render(`<script>
  import Action from './__ID__Action.mjs'
  let loading = false
  let busy = null
  let status = 'online'
  const LEGAL = { online: ['drain'], draining: ['undrain'] }
  $: moves = new Set(LEGAL[status] ?? [])
  // Async, like the action it is drawn from: the write that moves the row
  // lands in a later microtask than the click, which is the flush this fails in.
  async function go(name) {
    busy = name
    try { await Promise.resolve(); status = 'draining'; await Promise.resolve() }
    finally { busy = null }
  }
</script>
{#if loading}
  <p>Loading…</p>
{:else}
  <div id="actions" data-moves={[...moves].join(',')}>
    {#if moves.has('drain')}<Action busy={busy === 'drain'}><i id="drain">D</i></Action>{/if}
    {#if moves.has('undrain')}<Action busy={busy === 'undrain'}><i id="undrain">U</i></Action>{/if}
  </div>
{/if}
<button id="go" on:click={() => go('drain')}>go</button>`, {
      Action: `<script>\n  export let busy = false\n</script>\n<span data-busy={busy}><slot /></span>`
    })

    await click(wrap, '#go')
    expect(wrap.querySelector('#actions').getAttribute('data-moves')).toBe('undrain')
    expect(wrap.querySelector('#drain')).toBeFalsy()
    expect(wrap.querySelector('#undrain'), 'the move that became legal is on screen').toBeTruthy()
  })
})
