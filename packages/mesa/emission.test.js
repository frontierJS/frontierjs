/**
 * emission.test.js — the compiler must emit JavaScript that PARSES.
 *
 * Compiling without errors and emitting valid code are different claims, and
 * the gap between them hid two bugs until 2026-08-02. Both produced a clean
 * compile, an empty `analysis.errors`, and a module that threw on load:
 *
 *   1. `bind:` on a component put the raw attribute name in the props object —
 *      `Child(el, {bind:value: …}, null)`. VISION §3.4 documents the feature;
 *      nothing in the repo used it, so it appears never to have worked.
 *   2. A multi-line interpolated attribute was truncated at the newline,
 *      leaving an unterminated template literal. `_renderGroup` is regex
 *      surgery over generated source, and a CSS `;` at end-of-line looks
 *      exactly like a statement terminator.
 *
 * Each shipped REPL example that used the form was broken by it — `uiComponents`
 * by the first, `guiTimer` by the second.
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from './compiler.js'
import * as $rt from './runtime.js'

const compile = (src, filename = 'T.mesa') =>
  compileSource(src, { filename, css: false, debug: false })

/** Compile, assert no errors, and instantiate — which is where invalid JS shows. */
const build = async (src, name, Child) => {
  const ctx = await compile(src, name)
  expect(ctx.analysis.errors, name).toEqual([])
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .replace(/^export default\s+/m, 'const __c = ')
    .replace(/^(\s*)export (function|class|const|let|var) /gm, '$1$2 ')
  return new Function('$runtime', 'Child', code + '\nreturn __c')($rt, Child)
}

const mount = (Comp) => {
  const c = document.createElement('div')
  document.body.appendChild(c)
  const l = document.createElement('span')
  c.appendChild(l)
  $rt.mount(l, Comp, { props: {} })
  $rt.flushSync()
  return c
}

describe('bind: on a component prop', () => {
  it('is two-way — parent to child, and child back to parent', async () => {
    const Child = await build(
      `<script>export let value = ''</script><input bind:value={value} />`, 'Child.mesa')
    const Parent = await build(
      `<script>import Child from './Child.mesa'\n let name = 'start'</script>
<Child bind:value={name} />
<p>parent: {name}</p>
<button on:click={() => name = 'from-parent'}>set</button>`, 'Parent.mesa', Child)

    const c = mount(Parent)
    const read = () => c.querySelector('p').textContent.replace('parent: ', '')
    const input = c.querySelector('input')

    expect(read()).toBe('start')
    expect(input.value).toBe('start')          // parent → child, initial

    input.value = 'typed'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    $rt.flushSync()
    expect(read()).toBe('typed')               // child → parent

    c.querySelector('button').click()
    $rt.flushSync()
    expect(read()).toBe('from-parent')
    expect(input.value).toBe('from-parent')    // parent → child, update
    c.remove()
  })

  it('emits the prop under its real name, never `bind:value`', async () => {
    const { result } = await compile(
      `<script>import C from './C.mesa'\n let n = ''</script><C bind:value={n} />`)
    expect(result).toContain('bindProp')
    expect(result).not.toContain('bind:value:')
  })

  it('rejects binding to something that is not a writable let', async () => {
    const ctx = await compile(
      `<script>import C from './C.mesa'\n const n = 1</script><C bind:value={n} />`)
    expect(ctx.analysis.errors.join(' ')).toMatch(/must be a writable top-level/)
  })

  it('leaves bind:this alone', async () => {
    const { result } = await compile(
      `<script>import C from './C.mesa'\n let el = null</script><C bind:this={el} />`)
    expect(result).not.toContain('bindProp')
    expect(result).not.toContain('bind:this:')
  })
})

describe('multi-line interpolated attributes', () => {
  // The preceding text binding is load-bearing. It is what pulls the attribute's
  // first line into the same grouping run, so the run is rewritten and the
  // attribute's continuation line is orphaned. Without a binding before it the
  // multi-line attribute compiles fine even on the broken compiler — which is
  // why a synthetic one-element fixture did not reproduce.
  const MULTILINE = `<script>
  let done = true
  let pct = 40
</script>
<label>at {pct} percent</label>
<div style="background:{done ? '#22c55e' : '#4f46e5'};
            width:{pct}%;transition:width .1s"></div>`

  it('emit valid JavaScript', async () => {
    const Comp = await build(MULTILINE, 'Multi.mesa')
    expect(typeof Comp).toBe('function')
  })

  it('keep the whole attribute value, not just the first line', async () => {
    const c = mount(await build(MULTILINE, 'Multi.mesa'))
    const style = c.querySelector('div').getAttribute('style')
    expect(style).toContain('background:')
    expect(style).toContain('width:40%')       // the part after the newline
    c.remove()
  })

  it('still group single-line bindings into one render() block', async () => {
    // The fix must not disable the optimisation for the ordinary case.
    const { result } = await compile(
      `<script>let a = 1\n let b = 2</script><div id={a} title={b}>{a}</div>`)
    expect(result).toContain('$runtime.render(')
    expect((result.match(/\$runtime\.render\(/g) ?? []).length).toBe(1)
  })
})

describe('bind: to a member expression', () => {
  /*
   * The setter's target was emitted verbatim while the getter was rewritten
   * through the accessors, so binding to a property of a reactive `let` produced
   *
   *   getter: () => ($runtime.get($$sig_draft)[key])
   *   setter: ($$v) => { draft[key] = $$v }
   *
   * — valid JavaScript referring to a name that no longer exists. It parsed, it
   * mounted, and it threw `ReferenceError: draft is not defined` on the first
   * keystroke. A form bound to an object, which is what every form is, could not
   * accept input at all.
   */

  it('writes back through a static member — obj.field', async () => {
    // The write is observed by READING the object in an event handler, not by
    // watching the template: mutating an object held by a signal does not
    // notify (see the note at the end of this block). What is being pinned here
    // is that the assignment happens at all.
    const C = await build(
      `<script>let draft = { name: 'start' }\n let seen = ''</script>
<input bind:value={draft.name} />
<button on:click={() => seen = draft.name}>read</button>
<p>{seen}</p>`, 'Static.mesa')

    const c = mount(C)
    const input = c.querySelector('input')
    expect(input.value).toBe('start')

    input.value = 'typed'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    $rt.flushSync()
    c.querySelector('button').click()
    $rt.flushSync()

    expect(c.querySelector('p').textContent).toBe('typed')
    c.remove()
  })

  it('writes back through a computed member — obj[key]', async () => {
    const C = await build(
      `<script>let draft = { a: '' }\n const key = 'a'\n let seen = ''</script>
<input bind:value={draft[key]} />
<button on:click={() => seen = draft.a}>read</button>
<p>{seen}</p>`, 'Computed.mesa')

    const c = mount(C)
    const input = c.querySelector('input')

    input.value = 'via-key'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    $rt.flushSync()
    c.querySelector('button').click()
    $rt.flushSync()

    expect(c.querySelector('p').textContent).toBe('via-key')
    c.remove()
  })

  it('rewrites the setter target, not just the getter', async () => {
    const { result } = await compile(
      `<script>let draft = {}</script><input bind:value={draft.x} />`)
    const bind = result.split('\n').find(l => l.includes('bindInput'))
    expect(bind).toBeTruthy()
    // The old output contained a bare `draft.x = $$v`.
    expect(bind).not.toMatch(/\(\$\$v\) => \{ draft\./)
    expect(bind).toContain('$$sig_draft')
  })

  it('still emits a plain assignment for a non-reactive bare identifier', async () => {
    // `$runtime.get($$sig_x) = $$v` would be a syntax error, so only member
    // expressions are rewritten.
    const { result } = await compile(
      `<script>export let value = ''</script><input bind:value={value} />`)
    expect(result).toContain('bindInput')
  })

  it('CURRENT BEHAVIOUR: the mutation does not notify other readers', async () => {
    // Documenting, not endorsing. The setter assigns into the object the signal
    // holds; the signal itself is not replaced, so an effect reading
    // `draft.name` does not re-run and a live preview stays stale. That follows
    // from Mesa's plain-object rule (replacement is the reactive operation,
    // RULE 43) but it is surprising for bind:, where the whole point is
    // two-way. If this is ever changed, delete this test — do not adjust it.
    const C = await build(
      `<script>let draft = { name: 'start' }</script>
<input bind:value={draft.name} />
<p>{draft.name}</p>`, 'NoNotify.mesa')

    const c = mount(C)
    const input = c.querySelector('input')
    input.value = 'typed'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    $rt.flushSync()

    expect(input.value).toBe('typed')                        // the control is fine
    expect(c.querySelector('p').textContent).toBe('start')   // the preview is not
    c.remove()
  })
})
