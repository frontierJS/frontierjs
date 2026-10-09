/**
 * FJS-1676 — `$: ({ a, b } = obj)` declares a and b, as `$: a = obj.a` does.
 *
 * It used to compile to a bare effect writing two names nothing declared, and
 * the render died with 'a is not defined' plus a hint blaming the browser.
 */

import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

function execCompiled(code) {
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ')
  code += '\nreturn __component'
  return new Function('$$runtime', code)(runtime)
}

async function mount(src, props = {}) {
  const ctx = await compile(src, { debug: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  const Component = execCompiled(ctx.result)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.createRoot(() => {
    Component(anchor, props, null)
    runtime.registerComponentAnchor(anchor)
  })
  runtime.flushSync()
  return {
    text: () => container.textContent,
    push(next) { runtime.pushProps(anchor, next); runtime.flushSync() }
  }
}

const errorsOf = async (script) =>
  (await compile(`<script>\n${script}\n</script>\n<p>x</p>`, { debug: false, css: false })).analysis.errors

describe('a destructuring $: declares its names (FJS-1676)', () => {
  it('renders an object pattern and follows its source', async () => {
    const m = await mount(`<script>
  export let r
  $: ({ a, b } = r)
</script>
<p>{a}|{b}</p>`, { r: { a: 1, b: 2 } })
    expect(m.text()).toBe('1|2')
    m.push({ r: { a: 10, b: 20 } })
    expect(m.text()).toBe('10|20')
  })

  it('renames, defaults and nests', async () => {
    const m = await mount(`<script>
  export let r
  $: ({ a: x, d = 9, n: { c } } = r)
</script>
<p>{x}|{d}|{c}</p>`, { r: { a: 1, n: { c: 3 } } })
    expect(m.text()).toBe('1|9|3')
  })

  it('renders an array pattern', async () => {
    const m = await mount(`<script>
  export let pair
  $: ([p, q] = pair)
</script>
<p>{p}|{q}</p>`, { pair: [1, 2] })
    expect(m.text()).toBe('1|2')
  })

  it('parenthesizes a right side that is not a plain reference', async () => {
    const m = await mount(`<script>
  export let on
  export let one
  export let two
  $: ({ a } = on ? one : two)
</script>
<p>{a}</p>`, { on: true, one: { a: 1 }, two: { a: 2 } })
    expect(m.text()).toBe('1')
    m.push({ on: false })
    expect(m.text()).toBe('2')
  })

  it('leaves a pattern over names already declared as the effect it was', async () => {
    expect(await errorsOf(`let a = 0\nlet b = 0\nexport let r = { a: 1, b: 2 }\n$: ({ a, b } = r)`)).toEqual([])
  })

  it('refuses a mix of declared and undeclared names, naming the single-name form', async () => {
    const errs = await errorsOf(`let a = 0\nexport let r = { a: 1, b: 2 }\n$: ({ a, b } = r)`)
    expect(errs.join('\n')).toContain("'a' is already declared")
  })

  it('refuses a rest or computed key, naming the single-name form', async () => {
    const rest = await errorsOf(`export let r = { a: 1 }\n$: ({ a, ...others } = r)`)
    expect(rest.join('\n')).toContain('$: a = r.a')
    const computed = await errorsOf(`export let r = { a: 1 }\nconst k = 'a'\n$: ({ [k]: v } = r)`)
    expect(computed.join('\n')).toContain('$: v = ')
  })
})
