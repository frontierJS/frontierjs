/**
 * export-const-prop.test.js — `export const` is a prop the child may not write
 * (FJS-867, FJS-D209, VISION RULE 56).
 *
 * It used to compile to a plain `const` seeded from `props`: a prop the author
 * had written down as fixed, that the parent could set once and then never
 * update, and that a child write failed on at runtime with *Assignment to
 * constant variable* — naming neither the prop nor the file. Nothing in the DOM,
 * the console or the compile output told either side.
 *
 * It now compiles to what `export let` compiles to minus the setter. Immutable
 * describes the CHILD, not time, so the half that has to be asserted by MOUNTING
 * something is that the parent's later values still arrive: a value frozen at
 * mount is a silently stale screen, which is the failure this replaces rather
 * than the one it fixes.
 *
 * `<script module>` is untouched — there `export const` is an ordinary ES export,
 * and all 66 uses of the form in this repo are that one.
 *
 * Run: npx vitest run export-const-prop.test.js
 */

import { describe, it, expect } from 'vitest'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const cx = (src) => compile(src, { debug: false, css: false })

/** Every message the compiler reported, both channels. */
async function errorsOf(src) {
  const warned = []
  const ctx = await compile(src, {
    debug: false, css: false, warning: (w) => warned.push(w?.message ?? String(w))
  })
  return { errors: ctx.analysis.errors, warned, out: ctx.result }
}

// ── the harness: a real parent mounting a real child ─────────────────────────
// Same shape as component-api.test.js's — strip the imports, hand the runtime
// and the child module in by name.

function execCompiled(js, userImports = {}) {
  const importNames = [], importValues = []
  const importRe = /^import\s+(.+?)\s+from\s+'([^']+)';$/gm
  let m
  while ((m = importRe.exec(js)) !== null) {
    if (m[2] === '@frontierjs/mesa/runtime.js') continue
    importNames.push(m[1].trim())
    importValues.push(userImports[m[2]])
  }
  const code = js
    .replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .trim()
    .replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  // eslint-disable-next-line no-new-func
  return new Function('$$runtime', ...importNames, code)(runtime, ...importValues)
}

async function mountPair(childSrc, parentSrc) {
  const child = execCompiled((await cx(childSrc)).result)
  const parentCtx = await cx(parentSrc)
  if (parentCtx.analysis.errors.length) throw new Error(parentCtx.analysis.errors[0])
  const parent = execCompiled(parentCtx.result, { './Child.mesa': child })
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.flushSync()
  parent(anchor, {}, null)
  runtime.flushSync()
  return {
    text: () => container.textContent,
    destroy: () => container.remove()
  }
}

// ── emission ─────────────────────────────────────────────────────────────────

describe('export const emits the export let shape, minus the setter', () => {
  it('is a tracked signal with the initializer as its fallback', async () => {
    const { out } = await errorsOf(`<script>export const label = 'hi'</script><p>{label}</p>`)
    expect(out).toContain(
      `const $$sig_label = $$runtime.track($$option.props?.label !== undefined ? $$option.props.label : 'hi'`
    )
    expect(out).toContain('$$runtime.get($$sig_label)')
  })

  it('declares no setter', async () => {
    const { out } = await errorsOf(`<script>export const label = 'hi'</script><p>{label}</p>`)
    expect(out).not.toContain('$$set_label')
  })

  it('is registered, so the parent can still push', async () => {
    const { out } = await errorsOf(`<script>export const label = 'hi'</script><p>{label}</p>`)
    expect(out).toContain(`$$runtime.makeExternalProperty('label'`)
  })

  it('emits parseable JS', async () => {
    const { out } = await errorsOf(`<script>export const label = 'hi'</script><p>{label}</p>`)
    expect(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  })

  it('leaves <script module> alone — there it is an ordinary ES export', async () => {
    const { out, errors } = await errorsOf(
      `<script module>export const rows = [1, 2]</script><p>x</p>`
    )
    expect(errors).toEqual([])
    expect(out).toContain('export const rows = [1, 2]')
    expect(out).not.toContain('$$sig_rows')
  })
})

// ── what the child may not do ────────────────────────────────────────────────

describe('a write in the child is refused at compile time, naming the prop', () => {
  it('refuses an assignment in the script', async () => {
    const { errors } = await errorsOf(
      `<script>export const label = 'hi'\nfunction go() { label = 'x' }</script><p>{label}</p>`
    )
    expect(errors.join('\n')).toMatch(/'label' is declared `export const`/)
  })

  it('refuses an assignment in a template handler', async () => {
    const { errors } = await errorsOf(
      `<script>export const label = 'hi'</script><button on:click={() => label = 'x'}>b</button>`
    )
    expect(errors.join('\n')).toMatch(/'label' is declared `export const`/)
  })

  it('refuses ++', async () => {
    const { errors } = await errorsOf(
      `<script>export const n = 1\nfunction go() { n++ }</script><p>{n}</p>`
    )
    expect(errors.join('\n')).toMatch(/'n' is declared `export const`/)
  })

  it('reaches the warning channel too, which is what a build reads', async () => {
    const { warned } = await errorsOf(
      `<script>export const label = 'hi'\nfunction go() { label = 'x' }</script><p>{label}</p>`
    )
    expect(warned.join('\n')).toMatch(/'label' is declared `export const`/)
  })

  it('says nothing when nobody writes it — the negative control', async () => {
    const { errors } = await errorsOf(
      `<script>export const label = 'hi'\nfunction go() { return label }</script><p>{label}</p>`
    )
    expect(errors).toEqual([])
  })

  it('a LOCAL of the same name shadowing the prop is not the prop', async () => {
    const { errors } = await errorsOf(
      `<script>export const label = 'hi'</script><button on:click={() => { let label = 1; label = 2 }}>b</button>`
    )
    expect(errors).toEqual([])
  })

  it('bind: on it is still refused — RULE 22 wants a writable prop on both sides', async () => {
    const { errors } = await errorsOf(
      `<script>export const v = ''</script><input bind:value={v} />`
    )
    expect(errors.join('\n')).toMatch(/export const v/)
  })
})

// ── what the parent may do ───────────────────────────────────────────────────

const CHILD = `<script>export const label = 'fallback'</script><span>[{label}]</span>`

describe('the parent, mounting it', () => {
  it('the initializer is the fallback when nothing is passed', async () => {
    const m = await mountPair(CHILD, `<script>import Child from './Child.mesa'</script><Child />`)
    expect(m.text()).toBe('[fallback]')
    m.destroy()
  })

  it('a passed value wins over the fallback', async () => {
    const m = await mountPair(
      CHILD,
      `<script>import Child from './Child.mesa'\nlet v = 'given'</script><Child label={v} />`
    )
    expect(m.text()).toBe('[given]')
    m.destroy()
  })

  // The write is driven from the script rather than from a click: this file's
  // `mount` registers no delegation root, so no handler in a vitest suite here
  // can be made to fire.
  it("a LATER value still reaches the child — immutable is the child, not time", async () => {
    const m = await mountPair(
      CHILD,
      `<script>import Child from './Child.mesa'\nlet v = 'first'\n` +
      `globalThis.__setV = (x) => { v = x }</script><Child label={v} />`
    )
    expect(m.text()).toBe('[first]')
    globalThis.__setV('second')
    runtime.flushSync()
    expect(m.text()).toBe('[second]')
    delete globalThis.__setV
    m.destroy()
  })

  it('and may not write it through bind:this', async () => {
    const m = await mountPair(
      CHILD,
      `<script>import Child from './Child.mesa'\nlet ref = null\n` +
      `$: ref, () => { if (ref) globalThis.__constRef = ref }</script><Child bind:this={ref} />`
    )
    runtime.flushSync()
    const ref = globalThis.__constRef
    expect(ref.label).toBe('fallback')
    expect(() => { ref.label = 'x' }).toThrow(/export const/)
    expect(m.text()).toBe('[fallback]')
    delete globalThis.__constRef
    m.destroy()
  })
})
