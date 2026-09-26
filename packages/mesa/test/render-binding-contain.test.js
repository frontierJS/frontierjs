// render-binding-contain.test.js
//
// Every text and attribute binding at one level of a template is updated by one
// `render()` effect. An expression that threw stopped each binding after it from
// ever updating again, with the console the only report — part of one element
// row updated and the rest did not (`FJS-1330`).
//
// A binding is contained on its own: the throw is reported, the binding keeps
// the value it last showed, and the bindings after it still run (`FJS-D379`).
// Keeping is what a binding with an effect of its own — `class:`, `style:`,
// `{@html}` — already did, so the grouping stays invisible.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

async function compileComp(src, filename = '/C.mesa') {
  const ctx = await compileSource(src, { filename, dev: false, css: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  let code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  return { code: ctx.result, Comp: new Function('$$runtime', code)(runtime) }
}

let errors, origError
beforeEach(() => {
  document.body.innerHTML = ''
  errors = []
  origError = console.error
  console.error = (e) => errors.push(e)
})
afterEach(() => { console.error = origError })

function host() {
  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const a = document.createElement('span')
  wrap.appendChild(a)
  return { wrap, anchor: a }
}

const ROW = `
<script>
  export let api
  let n = 0
  let user = { name: 'ada' }
  api.inc = () => n++
  api.set = (u) => user = u
</script>
<p><b>{n}</b><i>{user.name}</i><u>{n}</u><s data-n={n}></s></p>`

const read = (wrap) => ({
  before: wrap.querySelector('b').textContent,
  name:   wrap.querySelector('i').textContent,
  after:  wrap.querySelector('u').textContent,
  attr:   wrap.querySelector('s').getAttribute('data-n'),
})

describe('a binding that throws in a shared render()', () => {
  it('is one render() effect for the whole row', async () => {
    const { code } = await compileComp(ROW)
    expect(code.match(/\$\$runtime\.render\(/g)).toHaveLength(1)
  })

  it('leaves the bindings after it updating, and keeps its own last value', async () => {
    const { Comp } = await compileComp(ROW)
    const { wrap, anchor } = host()
    const api = {}
    runtime.mount(anchor, Comp, { props: { api } })
    expect(read(wrap)).toEqual({ before: '0', name: 'ada', after: '0', attr: '0' })

    api.set(null)
    api.inc()
    runtime.flushSync()
    expect(read(wrap)).toEqual({ before: '1', name: 'ada', after: '1', attr: '1' })
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toMatch(/name/)

    api.inc()
    runtime.flushSync()
    expect(read(wrap)).toEqual({ before: '2', name: 'ada', after: '2', attr: '2' })
    expect(errors).toHaveLength(2)
  })

  it('shows the new value once the expression stops throwing', async () => {
    const { Comp } = await compileComp(ROW)
    const { wrap, anchor } = host()
    const api = {}
    runtime.mount(anchor, Comp, { props: { api } })
    api.set(null)
    runtime.flushSync()
    api.set({ name: 'grace' })
    runtime.flushSync()
    expect(read(wrap)).toEqual({ before: '0', name: 'grace', after: '0', attr: '0' })
  })

  it('still throws out of the first build', async () => {
    const { Comp } = await compileComp(`
<script>
  let user = null
</script>
<p><b>{user.name}</b></p>`)
    const { anchor } = host()
    expect(() => runtime.mount(anchor, Comp, {})).toThrow(/name/)
  })

  it('inside a boundary, replaces the content and leaves nothing subscribed', async () => {
    const { Comp } = await compileComp(`
<script>
  export let api, count
  let user = { name: 'ada' }
  api.set = (u) => user = u
</script>
<mesa:boundary>
  <p><i>{user.name}</i><u>{count()}</u></p>
  {#snippet failed(e)}<em>failed</em>{/snippet}
</mesa:boundary>`)
    const { wrap, anchor } = host()
    const api = {}
    const [count] = runtime.createSignal(0)
    runtime.mount(anchor, Comp, { props: { api, count } })
    await tick()
    expect(count._src._subs.size).toBe(1)

    api.set(null)
    runtime.flushSync()
    await tick()
    expect(wrap.querySelector('em')?.textContent).toBe('failed')
    expect(wrap.querySelector('u')).toBeNull()
    // The boundary disposed the render node mid-run, and the binding after the
    // throw read count() again; that read must not subscribe the dead node.
    expect(count._src._subs.size).toBe(0)
  })
})
