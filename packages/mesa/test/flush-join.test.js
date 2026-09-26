/**
 * A flush started while one is running joins it.
 *
 * `batch()` ends in a synchronous flush, and so does `flushSync()`. Called from
 * inside a node the flush is running, that second flush drained the queue under
 * the first — and began a new generation, so every node's run count started
 * again at zero and the cycle guard could not trip. An effect writing its own
 * source through `batch` recursed until the stack gave out (`FJS-1329`).
 *
 * Nothing about that shape is rare: a parent hands a child its props through
 * `pushProps`, which is a `batch`, from inside the parent's own render — so a
 * cycle that passes through a component boundary was invisible to the guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'
import { createSignal, createEffect, batch, flushSync } from '../src/runtime.js'

let spy
beforeEach(() => {
  document.body.innerHTML = ''
  spy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => spy.mockRestore())

const errorText = () => spy.mock.calls.map((c) => String(c[0])).join('\n')

// Compiles each source as its own module, resolving `import X from './X.mesa'`
// to the component compiled from the source of that name.
async function compileAll(sources) {
  const out = {}
  for (const [name, src] of Object.entries(sources)) {
    const ctx = await compileSource(src, { filename: `/${name}.mesa`, dev: false, css: false })
    if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
    const deps = []
    let code = ctx.result.replace(/^import\s+(\w+)\s+from\s+'\.\/(\w+)\.mesa';$/gm, (_, local, file) => {
      deps.push([local, file])
      return ''
    })
    code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
    code = code.replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
    out[name] = { code, deps }
  }
  const built = {}
  const build = (name) => built[name] ??= new Function('$$runtime', ...out[name].deps.map((d) => d[0]), out[name].code)(
    runtime, ...out[name].deps.map((d) => build(d[1])),
  )
  for (const name of Object.keys(out)) build(name)
  return built
}

function host() {
  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const anchor = document.createElement('span')
  wrap.appendChild(anchor)
  return { wrap, anchor }
}

describe('batch() inside a running flush', () => {
  it('trips the cycle guard on an effect writing its own source', () => {
    const [v, set] = createSignal(0)
    let armed = false
    let runs = 0
    createEffect(function selfWriter() {
      const cur = v()
      if (!armed) return
      if (++runs > 5000) return
      batch(() => set(cur + 1))
    })
    armed = true
    set(1)
    flushSync()
    expect(runs).toBeLessThanOrEqual(100)
    expect(errorText()).toMatch(/Update cycle detected/)
    expect(errorText()).toMatch(/selfWriter/)
  })

  it('still lands its writes before the flush returns', () => {
    const [a, setA] = createSignal(0)
    const [b, setB] = createSignal(0)
    let seen = null
    createEffect(() => { const x = a(); batch(() => setB(x * 10)) })
    createEffect(() => { seen = b() })
    setA(2)
    flushSync()
    expect(seen).toBe(20)
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('a cycle through a child component', () => {
  it('is caught by the guard rather than recursing', async () => {
    const { Parent } = await compileAll({
      Child: `
<script>
  export let n, bump
  $: n, () => bump()
</script>
<i>{n}</i>`,
      Parent: `
<script>
  import Child from './Child.mesa'
  export let api
  let n = 0
  api.start = () => n = 1
</script>
<Child {n} bump={() => n++} />`,
    })
    const { anchor } = host()
    const api = {}
    runtime.mount(anchor, Parent, { props: { api } })
    flushSync()
    spy.mockClear()
    let thrown = null
    try { api.start(); flushSync() } catch (e) { thrown = e }
    expect(thrown).toBeNull()
    expect(errorText()).toMatch(/Update cycle detected/)
  })
})

describe('a parent effect reading a child it just updated', () => {
  it('sees the child DOM as it is after the push', async () => {
    const { Parent } = await compileAll({
      List: `
<script>
  export let items
</script>
<ul>{#each items as it}<li>{it}</li>{/each}</ul>`,
      Parent: `
<script>
  import List from './List.mesa'
  export let api
  let items = ['a']
  let el
  api.add = () => items = [...items, 'x']
  $: items, () => { globalThis.__liCount = el.querySelectorAll('li').length }
</script>
<div bind:this={el}><List {items} /></div>`,
    })
    const { anchor } = host()
    const api = {}
    runtime.mount(anchor, Parent, { props: { api } })
    flushSync()
    api.add()
    flushSync()
    expect(globalThis.__liCount).toBe(2)
    api.add()
    flushSync()
    expect(globalThis.__liCount).toBe(3)
    expect(spy).not.toHaveBeenCalled()
  })
})
