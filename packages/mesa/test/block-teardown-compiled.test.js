/**
 * block-teardown-compiled.test.js
 *
 * The teardown tests in `runtime.test.js` call the block functions directly.
 * These go through the compiler and `mount()` instead, because whether a
 * runtime-level teardown bug is reachable by a real component depends on what
 * the compiler emits.
 *
 * Two of them are the reason this file exists:
 *
 *  - `{#key}` around `{#await}` duplicated its content at the runtime level,
 *    but NOT through the compiler: a block directive at the root of a block
 *    body compiles to a fragment with a leading placeholder comment, which
 *    happens to keep the recorded range valid. Nothing states that invariant,
 *    so these tests pin it — if the emitted shape ever loses the placeholder,
 *    the duplication becomes user-visible and these fail.
 *  - `<mesa:boundary>`'s stranded pending branch WAS reachable: its effects
 *    kept re-rendering into detached DOM after the swap, for the life of the
 *    page. That one is a leak, not a layout artifact, so no emission detail
 *    was hiding it.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'
import { flushSync, mount } from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))
let n = 0

async function render(src) {
  const ctx = await compileSource(src, { filename: `/T${n}.mesa`, dev: false })
  // The temp module is written to the package root (cwd), not beside this
  // file, so its runtime import is relative to the package root.
  const js = ctx.result.replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_tmp_compiled_${n++}.mjs`)
  writeFileSync(file, js)
  let Comp
  try { Comp = (await import('file://' + file)).default }
  finally { try { unlinkSync(file) } catch {} }

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

beforeEach(() => { document.body.innerHTML = '' })

describe('compiled block teardown', () => {
  it('{#key} wrapping a resolved {#await} — no duplication on key change', async () => {
    const wrap = await render(`<script>
  let k = 1
  const p = Promise.resolve('R')
</script>
<button onclick={() => k = k + 1}>go</button>
<div id="box">{#key k}{#await p}<i>loading</i>{:then v}<b>{v}</b>{/await}{/key}</div>`)

    const box = wrap.querySelector('#box')
    expect(box.textContent).toBe('R')
    await click(wrap, 'button')
    expect(box.querySelectorAll('b').length).toBe(1)
  })

  it('{#key} whose body is a component containing a resolved {#await}', async () => {
    const wrap = await render(`<script>
  let k = 1
  const p = Promise.resolve('R')
</script>
<button onclick={() => k = k + 1}>go</button>
<div id="box">{#key k}<span>{#await p}<i>?</i>{:then v}<b>{v}</b>{/await}</span>{/key}</div>`)

    const box = wrap.querySelector('#box')
    expect(box.textContent).toBe('R')
    await click(wrap, 'button')
    expect(box.querySelectorAll('b').length).toBe(1)
  })

  it('{#each} row containing a resolved {#await} — row removal', async () => {
    const wrap = await render(`<script>
  let items = [1, 2]
  const p = Promise.resolve('R')
</script>
<button onclick={() => items = [2]}>go</button>
<div id="box">{#each items as item (item)}{#await p}<i>?</i>{:then v}<b>{v}{item}</b>{/await}{/each}</div>`)

    const box = wrap.querySelector('#box')
    expect(box.textContent).toBe('R1R2')
    await click(wrap, 'button')
    expect(box.textContent).toBe('R2')
  })

  it('{#if} branch containing a resolved {#await} — branch removal', async () => {
    const wrap = await render(`<script>
  let show = true
  const p = Promise.resolve('R')
</script>
<button onclick={() => show = !show}>go</button>
<div id="box">{#if show}{#await p}<i>?</i>{:then v}<b>{v}</b>{/await}{/if}</div>`)

    const box = wrap.querySelector('#box')
    expect(box.textContent).toBe('R')
    await click(wrap, 'button')
    expect(box.textContent).toBe('')
  })
})

// <mesa:boundary> needs a top-level `await` in the component script, which the
// compiler turns into a bare call to an undeclared name rather than an import.
// Compiling to a Function with that name as a parameter is the only way to
// supply it — the temp-module path above cannot.
async function renderBoundary(src, fetchIt) {
  const ctx = await compileSource(src, { filename: '/B.mesa', dev: false, css: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  let code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  const Comp = new Function('$runtime', 'fetchIt', code)(runtime, fetchIt)

  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const label = document.createElement('span')
  wrap.appendChild(label)
  mount(label, Comp, { props: {} })
  flushSync(); await tick(); flushSync()
  return wrap
}

describe('compiled <mesa:boundary> teardown', () => {
  it('the swapped-out pending branch stops rendering', async () => {
    let resolveIt
    const p = new Promise((r) => { resolveIt = r })
    const wrap = await renderBoundary(`
<script>
let n = 0
const data = await fetchIt()
</script>
<mesa:boundary>
  {#snippet pending()}<p id="pending">{n}</p>{/snippet}
  <p id="content">{data}</p>
</mesa:boundary>
<button id="b" onclick={() => n = n + 1}>b</button>`, () => p)

    const pendingEl = wrap.querySelector('#pending')
    expect(pendingEl.textContent).toBe('0')
    await click(wrap, '#b')
    expect(pendingEl.textContent).toBe('1')   // live while pending

    resolveIt('DONE')
    await tick(); flushSync(); await tick()
    expect(wrap.querySelector('#content').textContent).toBe('DONE')
    expect(pendingEl.parentNode).toBeNull()

    // The detached pending <p> used to keep re-rendering on every write to
    // anything it read — its effects were parented to the boundary's own
    // effect node, which never disposes its children on re-run.
    await click(wrap, '#b')
    expect(pendingEl.textContent).toBe('1')
  })

  it('the pending branch DOM is gone once content mounts', async () => {
    let resolveIt
    const p = new Promise((r) => { resolveIt = r })
    const wrap = await renderBoundary(`
<script>
const data = await fetchIt()
</script>
<mesa:boundary>
  {#snippet pending()}<p id="pending">Loading</p>{/snippet}
  <p id="content">{data}</p>
</mesa:boundary>`, () => p)

    expect(wrap.querySelector('#pending')).toBeTruthy()
    resolveIt('DONE')
    await tick(); flushSync(); await tick()
    expect(wrap.querySelector('#pending')).toBeNull()
    expect(wrap.querySelector('#content').textContent).toBe('DONE')
  })
})
