// boundary-catch.test.js
//
// A throw during a flush goes to the nearest `<mesa:boundary>` with a `failed`
// snippet, found up the owner tree (`FJS-D372`, `FJS-D374`), and the content
// that threw is disposed and replaced by `failed(error, reset)` (`FJS-D375`).
// Before this, `_runNode` sent every throw to the console and the boundary read
// only the `.error` of its `$async` states, so a render that threw left a
// half-drawn region still subscribed to whatever it read (`FJS-1326`).
//
// Through the compiler rather than `boundaryBlock` directly: what a boundary
// can catch depends on which owner the compiled content's nodes hang off, and
// that is decided by the emitted code.
//
// Each case throws from a different place D372 names — a render effect, a
// derivation, a `$:` effect, and the content's own first build — because each
// reaches the boundary by a different path: a node's throw through `_runNode`,
// a derivation's through the nodes that read it, and the first build through
// the boundary effect's own try.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'
import { flushSync, mount } from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { flushSync(); await tick(); flushSync() }

// A top-level `await` compiles to a bare call to an undeclared name, so the
// component is built as a Function taking that name — see
// block-teardown-compiled.test.js, which this follows.
async function compileComp(src, globals = {}, filename = '/B.mesa') {
  const ctx = await compileSource(src, { filename, dev: false, css: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  let code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  const names = Object.keys(globals)
  return new Function('$$runtime', ...names, code)(runtime, ...names.map((k) => globals[k]))
}

async function render(src, globals = {}) {
  const Comp = await compileComp(src, globals)
  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const label = document.createElement('span')
  wrap.appendChild(label)
  mount(label, Comp, { props: {} })
  await settle()
  return wrap
}

const click = async (wrap, sel) => { wrap.querySelector(sel).click(); await settle() }
const text  = (wrap, sel) => wrap.querySelector(sel)?.textContent ?? null

let errorSpy
beforeEach(() => {
  document.body.innerHTML = ''
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { errorSpy.mockRestore() })

const FAILED = `{#snippet failed(error, reset)}<p id="failed">{error.message}</p><button id="reset" onclick={reset}>again</button>{/snippet}`

describe('a boundary catches a throw during a flush', () => {
  it('from a render effect', async () => {
    const wrap = await render(`
<script>
  let user = { name: 'Ada' }
</script>
<mesa:boundary>
  <p id="content">{user.name.toUpperCase()}</p>
  ${FAILED}
</mesa:boundary>
<button id="break" onclick={() => user = {}}>break</button>`)

    expect(text(wrap, '#content')).toBe('ADA')
    await click(wrap, '#break')
    expect(wrap.querySelector('#content')).toBeNull()
    expect(text(wrap, '#failed')).toMatch(/toUpperCase|undefined/)
    // Caught is not swallowed: the throw is still reported.
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('from a derivation', async () => {
    const wrap = await render(`
<script>
  let items = [{ name: 'first' }]
  const head = items[0].name
</script>
<mesa:boundary>
  <p id="content">{head}</p>
  ${FAILED}
</mesa:boundary>
<button id="empty" onclick={() => items = []}>empty</button>`)

    expect(text(wrap, '#content')).toBe('first')
    await click(wrap, '#empty')
    expect(wrap.querySelector('#content')).toBeNull()
    expect(wrap.querySelector('#failed')).not.toBeNull()
  })

  it('from a {@const} inside a child block', async () => {
    const wrap = await render(`
<script>
  let n = 0
  const check = (v) => { if (v > 1) throw new Error('too many: ' + v) }
</script>
<mesa:boundary>
  {#if true}
    {@const _ = check(n)}
    <p id="content">{n}</p>
  {/if}
  ${FAILED}
</mesa:boundary>
<button id="inc" onclick={() => n = n + 1}>inc</button>`)

    await click(wrap, '#inc')
    expect(text(wrap, '#content')).toBe('1')
    await click(wrap, '#inc')
    expect(text(wrap, '#failed')).toBe('too many: 2')
  })

  // A `$:` is owned by its component's script, so the boundary that catches it
  // is one around the component — here a child rendered inside it.
  it('from a $: effect in a child component', async () => {
    const Child = await compileComp(`
<script>
  export let n
  $: n, () => { if (n > 1) throw new Error('effect saw ' + n) }
</script>
<p id="content">{n}</p>`, {}, '/Child.mesa')
    const wrap = await render(`
<script>
  import Child from './Child.mesa'
  let n = 0
</script>
<mesa:boundary>
  <Child {n} />
  ${FAILED}
</mesa:boundary>
<button id="inc" onclick={() => n = n + 1}>inc</button>`, { Child })

    await click(wrap, '#inc')
    expect(text(wrap, '#content')).toBe('1')
    await click(wrap, '#inc')
    expect(text(wrap, '#failed')).toBe('effect saw 2')
    expect(wrap.querySelector('#content')).toBeNull()
  })

  it('from the content\'s first build', async () => {
    const wrap = await render(`
<script>
  let user = null
</script>
<mesa:boundary>
  <p id="content">{user.name}</p>
  ${FAILED}
</mesa:boundary>`)

    expect(wrap.querySelector('#content')).toBeNull()
    expect(wrap.querySelector('#failed')).not.toBeNull()
  })

  it('leaves everything outside the boundary running', async () => {
    const wrap = await render(`
<script>
  let user = { name: 'Ada' }
  let n = 0
</script>
<mesa:boundary>
  <p id="content">{user.name.length + n}</p>
  ${FAILED}
</mesa:boundary>
<p id="outside">{n}</p>
<button id="break" onclick={() => user = {}}>break</button>
<button id="inc" onclick={() => n = n + 1}>inc</button>`)

    await click(wrap, '#break')
    await click(wrap, '#inc')
    await click(wrap, '#inc')
    expect(text(wrap, '#outside')).toBe('2')
    // The disposed content is not re-run by writes to what it read.
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})

describe('reset', () => {
  it('builds the content again', async () => {
    const wrap = await render(`
<script>
  let user = { name: 'Ada' }
</script>
<mesa:boundary>
  <p id="content">{user.name}</p>
  ${FAILED}
</mesa:boundary>
<button id="break" onclick={() => user = null}>break</button>
<button id="fix" onclick={() => user = { name: 'Grace' }}>fix</button>`)

    await click(wrap, '#break')
    expect(wrap.querySelector('#failed')).not.toBeNull()
    // Nothing retries on its own: the content was disposed, so the fix alone
    // changes nothing until the author's `reset` asks for it (`FJS-D375`).
    await click(wrap, '#fix')
    expect(wrap.querySelector('#content')).toBeNull()
    await click(wrap, '#reset')
    expect(text(wrap, '#content')).toBe('Grace')
    expect(wrap.querySelector('#failed')).toBeNull()
  })

  it('shows failed again when the rebuild throws too', async () => {
    const wrap = await render(`
<script>
  let user = { name: 'Ada' }
</script>
<mesa:boundary>
  <p id="content">{user.name}</p>
  ${FAILED}
</mesa:boundary>
<button id="break" onclick={() => user = null}>break</button>`)

    await click(wrap, '#break')
    await click(wrap, '#reset')
    expect(wrap.querySelector('#content')).toBeNull()
    expect(wrap.querySelectorAll('#failed').length).toBe(1)
  })
})

describe('which boundary catches', () => {
  it('a boundary with no failed snippet passes the throw to the one above', async () => {
    const wrap = await render(`
<script>
  let user = { name: 'Ada' }
</script>
<mesa:boundary>
  <section id="outer">
    <mesa:boundary>
      <p id="content">{user.name}</p>
    </mesa:boundary>
  </section>
  ${FAILED}
</mesa:boundary>
<button id="break" onclick={() => user = null}>break</button>`)

    await click(wrap, '#break')
    expect(wrap.querySelector('#outer')).toBeNull()
    expect(wrap.querySelector('#failed')).not.toBeNull()
  })

  it('with none above, the console has it and the page keeps running', async () => {
    const wrap = await render(`
<script>
  let user = { name: 'Ada' }
  let n = 0
</script>
{#if user !== undefined}<p id="content">{user.name}</p>{/if}
<p id="outside">{n}</p>
<button id="break" onclick={() => user = null}>break</button>
<button id="inc" onclick={() => n = n + 1}>inc</button>`)

    // Inside `{#if}` so the throwing binding is its own node: a template's
    // bindings at one level share a render effect, and a throw in one stops
    // the rest of that effect.
    await click(wrap, '#break')
    expect(errorSpy).toHaveBeenCalledTimes(1)
    await click(wrap, '#inc')
    expect(text(wrap, '#outside')).toBe('1')
  })

  // A throw in a handler leaves the DOM as it was, so there is nothing for a
  // boundary to replace (`FJS-D372`).
  it('an event handler\'s throw is not caught', async () => {
    const wrap = await render(`
<script>
  const boom = () => { throw new Error('handler') }
</script>
<mesa:boundary>
  <button id="content" onclick={boom}>go</button>
  ${FAILED}
</mesa:boundary>`)

    try { wrap.querySelector('#content').click() } catch {}
    await settle()
    expect(wrap.querySelector('#content')).not.toBeNull()
    expect(wrap.querySelector('#failed')).toBeNull()
  })
})

describe('waiting', () => {
  // A boundary written to catch holds nothing back while the component's
  // awaits are still loading (`FJS-D378`).
  it('a boundary that reads no async value shows its content at once', async () => {
    const never = new Promise(() => {})
    const wrap = await render(`
<script>
  const reports = await load()
</script>
<mesa:boundary>
  <p id="content">here</p>
  ${FAILED}
</mesa:boundary>`, { load: () => never })

    expect(text(wrap, '#content')).toBe('here')
  })
})
