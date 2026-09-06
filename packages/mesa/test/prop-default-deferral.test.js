/**
 * prop-default-deferral.test.js — a prop's fallback may name the script's own
 * variables.
 *
 * A prop signal is declared in the component's head, which runs before any of
 * the script's declarations, so a fallback that names one reads a binding in
 * its temporal dead zone. `export let` was given a deferred default years ago
 * and applies it through its setter once the declarations exist; `export const`
 * and `export var` had no such step and took the component down at mount with
 * a `ReferenceError` naming neither the prop nor the file (`FJS-899`).
 *
 * `export const` has no setter and must not grow one (`FJS-D209`) — the write
 * goes straight into the signal, which is a thing the compiler can spell and
 * the child cannot.
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as $rt from '../src/runtime.js'

const compile = (src, filename = 'T.mesa') =>
  compileSource(src, { filename, css: false, debug: false })

const build = async (src, name) => {
  const ctx = await compile(src, name)
  expect(ctx.analysis.errors, name).toEqual([])
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .replace(/^export default\s+/m, 'const __c = ')
  return new Function('$$runtime', code + '\nreturn __c')($rt)
}

const mount = (Comp, props = {}) => {
  const c = document.createElement('div')
  document.body.appendChild(c)
  const l = document.createElement('span')
  c.appendChild(l)
  $rt.mount(l, Comp, { props })
  $rt.flushSync()
  return c
}

describe('a prop fallback that names a reactive variable (FJS-899)', () => {
  it('mounts an `export const` prop whose fallback reads a let', async () => {
    const C = await build(`<script>
  let base = 10
  export const label = 'n' + base
</script>
<p>{label}</p>`, 'ConstDefault.mesa')
    expect(mount(C).textContent).toBe('n10')
  })

  it('still lets the parent win over that fallback', async () => {
    const C = await build(`<script>
  let base = 10
  export const label = 'n' + base
</script>
<p>{label}</p>`, 'ConstDefaultProp.mesa')
    expect(mount(C, { label: 'given' }).textContent).toBe('given')
  })

  it('does not declare a setter for the const prop', async () => {
    // The deferred write is the compiler's own, not a binding the child can
    // reach: a `$$set_label` here would hand back what FJS-D209 removed.
    const ctx = await compile(`<script>
  let base = 10
  export const label = 'n' + base
</script>
<p>{label}</p>`, 'ConstNoSetter.mesa')
    expect(ctx.result).not.toContain('$$set_label')
    expect(ctx.result).toContain('read-only prop')
  })

  it('mounts an `export var` prop whose fallback reads a let', async () => {
    // `var` is the snapshot form (RULE 56) — the value is still taken at
    // mount, only after the declarations rather than before them.
    const C = await build(`<script>
  let base = 4
  export var snap = base * 2
</script>
<p>{snap}</p>`, 'VarDefault.mesa')
    expect(mount(C).textContent).toBe('8')
  })

  it('mounts an `export let` prop whose fallback reads a let', async () => {
    const C = await build(`<script>
  let base = 3
  export let label = 'n' + base
</script>
<p>{label}</p>`, 'LetDefault.mesa')
    expect(mount(C).textContent).toBe('n3')
  })

  it('leaves a fallback that names nothing reactive in the head', async () => {
    // The negative control: deferring every default would move a plain literal
    // out of the declaration for no reason, and the parent-or-fallback choice
    // is one expression when it can be.
    const ctx = await compile(`<script>
  export const label = 'x'
</script>
<p>{label}</p>`, 'StaticDefault.mesa')
    expect(ctx.result).toContain(`$$option.props.label : 'x'`)
  })
})
