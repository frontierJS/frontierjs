/**
 * self-assign-parity.test.js — `o = o` notifies from every position a statement
 * can be written (FJS-1111, VISION RULE 43).
 *
 * The idiom means "I mutated this in place, notify anyway", and a signal write
 * whose reference is unchanged is skipped — so it must compile to a forced
 * write. The script and the template are rewritten by two different functions,
 * and the rule lived in only one of them: the same two statements re-rendered
 * from a `<script>` function and did nothing written inline in a handler or in
 * a `$:` watch handler. Every compile was clean and every module parsed, so the
 * only thing that can see it is a mount and a click.
 *
 * Each case is the same component with the statements moved. A mount that
 * bypasses `mount()` registers no delegation root and no click lands, so the
 * control case (`c++`) is here to prove the harness can see a change at all.
 *
 * Run: npx vitest run self-assign-parity.test.js
 */

import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import * as acorn from 'acorn'
import { compile, compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

let n = 0

async function build(src) {
  const ctx = await compileSource(src, { filename: `/SA${n}.mesa`, dev: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  const js = ctx.result.replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_tmp_selfassign_${n++}.mjs`)
  writeFileSync(file, js)
  try { return (await import('file://' + file)).default }
  finally { try { unlinkSync(file) } catch {} }
}

/** Mount, click the first button, and answer the text before and after. */
async function clickThrough(src) {
  const Comp = await build(src)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.mount(anchor, Comp, {})
  runtime.flushSync()
  const before = container.querySelector('p').textContent
  container.querySelector('button').click()
  runtime.flushSync()
  const after = container.querySelector('p').textContent
  container.remove()
  return [before, after]
}

const component = ({ script = '', handler, row = false }) => {
  const button = `<button on:click={${handler}}>go</button>`
  return `<script>
  let o = { n: 1 }
  let t = 0
${script}
</script>
${row ? `{#each [1] as i}${button}{/each}` : button}
<p>{o.n}</p>`
}

describe('o = o notifies from every position (FJS-1111)', () => {
  it('control: the harness sees an ordinary write', async () => {
    const src = `<script>\n  let c = 0\n</script>\n<button on:click={() => c++}>go</button>\n<p>{c}</p>`
    expect(await clickThrough(src)).toEqual(['0', '1'])
  })

  it('in a <script> function the handler names', async () => {
    const src = component({ script: '  function bump() { o.n = 2; o = o }', handler: 'bump' })
    expect(await clickThrough(src)).toEqual(['1', '2'])
  })

  it('inline in a template handler', async () => {
    const src = component({ handler: '() => { o.n = 2; o = o }' })
    expect(await clickThrough(src)).toEqual(['1', '2'])
  })

  it('inline in a handler inside {#each}', async () => {
    const src = component({ handler: '() => { o.n = 2; o = o }', row: true })
    expect(await clickThrough(src)).toEqual(['1', '2'])
  })

  it('in a $: watch handler', async () => {
    const src = component({ script: '  $: t, () => { o.n = 2; o = o }', handler: '() => t++' })
    expect(await clickThrough(src)).toEqual(['1', '2'])
  })
})

describe('what the rewrite leaves alone', () => {
  const cx = (src) => compile(src, { debug: false, css: false }).then((c) => c.result)

  it('a parameter shadowing the binding is not the binding', async () => {
    const out = await cx(component({ handler: '(o) => { o = o }' }))
    expect(out).toContain('(o) => { o = o }')
  })

  it('a watched import fires its proxy from a template handler too', async () => {
    const out = await cx(`<script>
  import { themeNew } from './store.js'
  $: themeNew
</script>
<button on:click={() => { themeNew = themeNew }}>go</button>
<p>{themeNew.style}</p>`)
    expect(out).toContain('$$fire_themeNew()')
    expect(out).not.toContain('themeNew = themeNew')
  })
})
