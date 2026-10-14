// dollar-self-write.test.js
//
// A `$:` block that calls a function reading and writing the same state
// (`const mine = ++seq`) was re-queued by its own write, because the call
// subscribed it to the counter it bumps: it ran 100 times and was abandoned
// with a message blaming two statements (`FJS-2652`). A `$:` block is woken by
// what it READS from outside itself, never by its own writes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as acorn from 'acorn'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { runtime.flushSync(); await tick(); runtime.flushSync() }

async function mount(src) {
  const ctx = await compileSource(src, { filename: `/C${Math.random()}.mesa`, dev: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
    .replace(/^export default\s+/m, 'const __c = ') + '\nreturn __c'
  const Comp = new Function('$$runtime', code)(runtime)
  const host = document.createElement('div')
  const anchor = document.createElement('span')
  host.appendChild(anchor)
  document.body.appendChild(host)
  runtime.mount(anchor, Comp, {})
  await settle()
  return host
}

const text = (host) => host.textContent.replace(/\s+/g, ' ').trim()

let errors
beforeEach(() => {
  document.body.innerHTML = ''
  errors = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => errors.mockRestore())

describe('a $: block and its own writes (FJS-2652)', () => {
  it('a called function bumping a counter it reads runs the block once', async () => {
    const host = await mount(`<script>
let value = 'a'
let seq = 0
let shown = ''
function ask(v) { const mine = ++seq; shown = v + ':' + mine }
$: { ask(value) }
</script>
<p>{shown}</p>`)
    expect(errors).not.toHaveBeenCalled()
    expect(text(host)).toBe('a:1')
  })

  it('still re-runs when a value it reads from outside itself changes', async () => {
    const host = await mount(`<script>
let value = 'a'
let seq = 0
let shown = ''
function ask(v) { const mine = ++seq; shown = v + ':' + mine }
$: { ask(value) }
</script>
<button onclick={() => value = 'b'}>go</button>
<p>{shown}</p>`)
    host.querySelector('button').click()
    await settle()
    expect(errors).not.toHaveBeenCalled()
    expect(text(host)).toContain('b:2')
  })

  it('a timer handle cleared and reassigned inside the called function does not loop', async () => {
    const host = await mount(`<script>
let value = 'a'
let timer
let fired = 0
function later(v) { clearTimeout(timer); timer = setTimeout(() => { fired++ }, 1) }
$: { later(value) }
</script>
<p>{fired}</p>`)
    await new Promise((r) => setTimeout(r, 10))
    await settle()
    expect(errors).not.toHaveBeenCalled()
    expect(text(host)).toBe('1')
  })
})
