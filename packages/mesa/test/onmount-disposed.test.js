// onmount-disposed.test.js
//
// `$.onMount` callbacks run a microtask after the component is built, and the
// component can be destroyed in between. They ran anyway, and the teardown each
// returned went onto a root that had already been disposed, so it never ran: an
// `onMount` opening a socket or adding a `window` listener did it for a
// component that was gone, and nothing closed it (`FJS-1335`).
//
// Through the compiler, because the two mount paths differ — a compiled child
// goes through `pop_component`, a component handed to `mount()` through
// `makeComponent` — and each needed the check.

import { describe, it, expect, beforeEach } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

async function compileComp(src, globals = {}, filename = '/C.mesa') {
  const ctx = await compileSource(src, { filename, dev: false, css: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  let code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  const names = Object.keys(globals)
  return new Function('$$runtime', ...names, code)(runtime, ...names.map((k) => globals[k]))
}

let log
beforeEach(() => {
  document.body.innerHTML = ''
  log = []
})

const child = () => compileComp(`
<script>
  export let log
  $.onMount(() => { log.push('mount'); return () => log.push('cleanup') })
</script>
<p>child</p>`, {}, '/Child.mesa')

function anchor() {
  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const a = document.createElement('span')
  wrap.appendChild(a)
  return a
}

describe('onMount for a component destroyed before it mounted', () => {
  it('does not run when a $: closes the branch in the flush that opened it', async () => {
    const Child = await child()
    const Parent = await compileComp(`
<script>
  import Child from './Child.mesa'
  export let api, log
  let show = false
  api.open = () => show = true
  $: show, () => { if (show) show = false }
</script>
{#if show}<Child {log} />{/if}`, { Child })

    const api = {}
    runtime.mount(anchor(), Parent, { props: { api, log } })
    await tick()
    api.open()
    await tick()
    await tick()
    expect(log).toEqual([])
  })

  it('does not run when mount() is destroyed before the tick', async () => {
    const Child = await child()
    const inst = runtime.mount(anchor(), Child, { props: { log } })
    inst.destroy()
    await tick()
    expect(log).toEqual([])
  })

  it('runs, and its teardown runs on destroy, for a component that mounted', async () => {
    const Child = await child()
    const inst = runtime.mount(anchor(), Child, { props: { log } })
    await tick()
    expect(log).toEqual(['mount'])
    inst.destroy()
    expect(log).toEqual(['mount', 'cleanup'])
  })

  it('calls the teardown at once when the callback itself destroyed the component', async () => {
    const Comp = await compileComp(`
<script>
  export let log, destroy
  $.onMount(() => { destroy(); return () => log.push('cleanup') })
</script>
<p>x</p>`)
    let inst
    inst = runtime.mount(anchor(), Comp, { props: { log, destroy: () => inst.destroy() } })
    await tick()
    expect(log).toEqual(['cleanup'])
  })
})
