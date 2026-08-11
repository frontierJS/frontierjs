/**
 * The component instance API — `export function` and `bind:this` (FJS-087).
 *
 * VISION §10.2 / RULE 36 promise that `bind:this` on a component hands the
 * parent the child's exported interface. Neither half existed: an exported
 * function was dropped from the emitted output entirely, and `bind:this` set
 * the variable to the child's anchor — a comment node.
 *
 * Both failures are invisible to a render test, because SSR dispatches no
 * events and a comment node renders as nothing. So every assertion here either
 * calls a method or reads a prop back after a mutation.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { compile } from '../src/compiler.js'

// ── harness ──────────────────────────────────────────────────────────────────
// Same shape as compiler.test.js's: strip the imports, hand the runtime in.

function execCompiled(compiledJs, runtime, userImports = {}) {
  const importNames = [], importValues = []
  const importRe = /^import\s+(.+?)\s+from\s+'([^']+)';$/gm
  let m
  while ((m = importRe.exec(compiledJs)) !== null) {
    const spec = m[1].trim(), src = m[2]
    if (src === '@frontierjs/mesa/runtime.js') continue
    const mock = userImports[src] || {}
    importNames.push(spec.trim())
    importValues.push(mock?.default ?? mock)
  }
  let code = compiledJs
    .replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .trim()
    .replace(/^export default\s+/m, 'const __component = ')
  code += '\nreturn __component'
  // eslint-disable-next-line no-new-func
  return new Function('$runtime', ...importNames, code)(runtime, ...importValues)
}

async function compileAndExec(source, runtime, userImports = {}) {
  const ctx = await compile(source, { debug: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  return execCompiled(ctx.result, runtime, userImports)
}

function mount(componentFn, runtime, props = {}) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.flushSync()
  componentFn(anchor, props, null)
  runtime.flushSync()
  return {
    text: () => container.textContent,
    find: sel => container.querySelector(sel),
    destroy() {
      container.innerHTML = ''
      container.parentNode?.removeChild(container)
    },
  }
}

const cx = src => compile(src, { debug: false, css: false })

// ── the declaration survives ─────────────────────────────────────────────────

describe('export function — emission', () => {
  it('emits the declaration', async () => {
    const out = await cx(`<script>let n = 0\nexport function reset() { n = 0 }</script><p>{n}</p>`)
    expect(out.result).toContain('function reset()')
    expect(out.result).not.toContain('export function')
  })

  it('rewrites assignments in the body through the signal setter', async () => {
    const out = await cx(`<script>let n = 0\nexport function bump() { n++ }</script><p>{n}</p>`)
    expect(out.result).toContain('$$set_n(')
  })

  it('registers the method for bind:this', async () => {
    const out = await cx(`<script>let n = 0\nexport function reset() { n = 0 }</script><p>{n}</p>`)
    expect(out.result).toContain('$runtime.registerExports({ reset });')
  })

  it('emits no registration when the component exports no method', async () => {
    const out = await cx(`<script>let n = 0</script><p>{n}</p>`)
    expect(out.result).not.toContain('registerExports')
  })

  it('a component may call its own exported function from the template', async () => {
    // The failure this closes: `on:click={bump}` referenced a name the output
    // never declared, so the first click threw ReferenceError.
    const runtime = await import('../src/runtime.js')
    const fn = await compileAndExec(
      `<script>let n = 0\nexport function bump() { n++ }</script>` +
      `<button on:click={bump}>{n}</button>`,
      runtime
    )
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.text()).toContain('1')
    app.destroy()
  })
})

// ── every other export form is refused by name ───────────────────────────────

describe('export forms an instance script does not have', () => {
  const refused = async src => (await cx(src)).analysis.errors

  it('refuses export { name }', async () => {
    const errs = await refused(`<script>function go() {}\nexport { go }</script><p>x</p>`)
    expect(errs.join('\n')).toMatch(/export let.*export function/s)
  })

  it('refuses export class', async () => {
    const errs = await refused(`<script>export class Thing {}</script><p>x</p>`)
    expect(errs.length).toBe(1)
  })

  it('still accepts export let as a prop', async () => {
    const out = await cx(`<script>export let value = 1</script><p>{value}</p>`)
    expect(out.analysis.errors).toEqual([])
    expect(out.result).toContain('makeExternalProperty')
  })
})

// ── bind:this on a component ─────────────────────────────────────────────────

describe('bind:this on a component', () => {
  let runtime
  beforeEach(async () => { runtime = await import('../src/runtime.js') })

  const CHILD = `<script>
    export let count = 0
    export function reset() { count = 0 }
    export function bump() { count++ }
  </script><p>{count}</p>`

  const parentWith = body => `<script>
    import Child from './Child.mesa'
    let ref = null
    ${body}
  </script><Child bind:this={ref} count={1} /><button on:click={act}>go</button>`

  async function pair(parentSource) {
    const child = await compileAndExec(CHILD, runtime)
    return compileAndExec(parentSource, runtime, { './Child.mesa': { default: child } })
  }

  it('hands over the exported interface, not the anchor node', async () => {
    let seen = null
    const fn = await pair(parentWith(`function act() { globalThis.__seen = ref }`))
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    seen = globalThis.__seen
    expect(seen).toBeTruthy()
    expect(seen.nodeType).toBeUndefined()      // used to be a Comment
    expect(typeof seen.reset).toBe('function')
    expect(typeof seen.bump).toBe('function')
    app.destroy()
  })

  it('calling a method through the ref changes the child', async () => {
    const fn = await pair(parentWith(`function act() { ref.bump() }`))
    const app = mount(fn, runtime)
    expect(app.text()).toContain('1')
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.text()).toContain('2')
    app.destroy()
  })

  it('a prop read through the ref is live, not a snapshot', async () => {
    const fn = await pair(parentWith(
      `function act() { ref.bump(); globalThis.__after = ref.count }`
    ))
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(globalThis.__after).toBe(2)
    app.destroy()
  })

  it('writing a prop through the ref reaches the child', async () => {
    const fn = await pair(parentWith(`function act() { ref.count = 9 }`))
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(app.text()).toContain('9')
    app.destroy()
  })

  it('a child that exports nothing still answers an object', async () => {
    const child = await compileAndExec(`<script>let n = 1</script><p>{n}</p>`, runtime)
    const fn = await compileAndExec(
      `<script>import Child from './Child.mesa'\nlet ref = null\n` +
      `function act() { globalThis.__bare = ref }</script>` +
      `<Child bind:this={ref} /><button on:click={act}>go</button>`,
      runtime, { './Child.mesa': { default: child } }
    )
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(globalThis.__bare).toEqual({})
    app.destroy()
  })
})

// ── bind:this on a DOM element is unchanged ──────────────────────────────────

describe('bind:this on a DOM element', () => {
  it('still captures the element itself', async () => {
    const runtime = await import('../src/runtime.js')
    const fn = await compileAndExec(
      `<script>let el = null\nfunction act() { globalThis.__el = el }</script>` +
      `<div bind:this={el} id="target"></div><button on:click={act}>go</button>`,
      runtime
    )
    const app = mount(fn, runtime)
    app.find('button').__click?.()
    runtime.flushSync()
    expect(globalThis.__el?.id).toBe('target')
    app.destroy()
  })
})
