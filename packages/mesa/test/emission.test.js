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
import { compileSource } from '../src/compiler.js'
import * as $rt from '../src/runtime.js'
import { parse as parseJs } from 'acorn'

const compile = (src, filename = 'T.mesa') =>
  compileSource(src, { filename, css: false, debug: false })

/** Compile, assert no errors, and instantiate — which is where invalid JS shows. */
const build = async (src, name, Child) => {
  const ctx = await compile(src, name)
  expect(ctx.analysis.errors, name).toEqual([])
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .replace(/^export default\s+/m, 'const __c = ')
    .replace(/^(\s*)export (function|class|const|let|var) /gm, '$1$2 ')
  return new Function('$$runtime', 'Child', code + '\nreturn __c')($rt, Child)
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

describe('++ and -- on a reactive let, as an expression', () => {
  // Every test on this pair asserted the emitted TEXT, and the text was wrong
  // in two ways that only a value can see: `$$runtime.set` answered nothing, so
  // `const a = ++n` bound `undefined`; and postfix compiled to the prefix form,
  // so `n++` would have answered the new value once it answered one at all.
  //
  // Found in `example`'s storefront, where `const mine = ++inflight` guarded a
  // search box against an out-of-order response: `mine` was `undefined`, the
  // guard `mine !== inflight` was therefore always true, and every answer the
  // shop gave was discarded. No error, no warning, an empty list.
  it('answers the value each form is defined to answer', async () => {
    const C = await build(`<script>
  let n = 0
  let out = ''
  function go() {
    const pre  = ++n          // 1 — the new value
    const post = n++          // 1 — the OLD value, n is now 2
    const comp = (n += 10)    // 12 — the new value
    out = [pre, post, comp, n].join(',')
  }
</script>
<button on:click={go}>go</button><p>{out}</p>`, 'Update.mesa')

    const c = mount(C)
    c.querySelector('button').click()
    $rt.flushSync()
    expect(c.querySelector('p').textContent).toBe('1,1,12,12')
    c.remove()
  })

  // The shape that made the first fix worse than the bug. Inlined as
  // `(($$v) => …)(…)`, this statement continued the `throw` above it — no
  // semicolons in this house — so it parsed as a call on the Error object and
  // the increment never ran on either path.
  it('runs as a statement under a line with no semicolon', async () => {
    const C = await build(`<script>
  let done = 0
  let fail = true
  function save() {
    if (fail) throw new Error('rejected')
    done++
  }
  function go() { try { save() } catch {} }
</script>
<button id="go" on:click={go}>go</button>
<button id="ok" on:click={() => fail = false}>ok</button>
<output>{done}</output>`, 'Save.mesa')

    const c = mount(C)
    const read = () => c.querySelector('output').textContent
    c.querySelector('#go').click(); $rt.flushSync()
    expect(read()).toBe('0')
    c.querySelector('#ok').click(); $rt.flushSync()
    c.querySelector('#go').click(); $rt.flushSync()
    expect(read()).toBe('1')
    c.remove()
  })

  it('still writes the signal when it is a statement', async () => {
    const C = await build(
      `<script>let n = 0</script><button on:click={() => n++}>go</button><p>{n}</p>`,
      'Bump.mesa')
    const c = mount(C)
    const read = () => c.querySelector('p').textContent
    expect(read()).toBe('0')
    c.querySelector('button').click()
    $rt.flushSync()
    expect(read()).toBe('1')
    c.querySelector('button').click()
    $rt.flushSync()
    expect(read()).toBe('2')
    c.remove()
  })
})

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

describe('$: fn(), handler — a post-call hook that writes state', () => {
  it('emits a signal write, and parseable JS', async () => {
    // The hook path parsed the handler at offset 0 and then let
    // rewriteAssignments slice ctx.script.source with those offsets — two
    // coordinate systems, so the output was spliced from unrelated characters
    // (`$$set_high(sa'`, taken from an import statement). Vite reported only
    // "contains invalid JS syntax" and named no line.
    const ctx = await compile(
      `<script>
        import { thing } from './x.js'
        let ceiling = 10
        let high = 0
        let seen = false
        function load() {}
        $: load(), () => { if (!seen) { high = ceiling; seen = true } }
      </script>
      <p>{high}</p>`)
    expect(ctx.analysis.errors).toEqual([])
    expect(ctx.result).toContain('$$set_high(')
    expect(ctx.result).not.toMatch(/\$\$set_high\([^)]*['"`]\s*$/m)
    parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  })

  it('runs the handler after every call to the watched function', async () => {
    const C = await build(
      `<script>
        let n = 0
        let hits = 0
        function bump() { n = n + 1 }
        $: bump(), () => { hits = hits + 1 }
      </script>
      <button on:click={bump}>go</button><p>{n}:{hits}</p>`, 'C.mesa')
    const c = mount(C)
    c.querySelector('button').click()
    $rt.flushSync()
    expect(c.querySelector('p').textContent).toBe('1:1')
    c.remove()
  })
})

describe('an attribute that depends on a {@const}', () => {
  it('updates — the const is a memo, not a constant', async () => {
    // Found in @frontierjs/ui's Steps: the step's class tracked the state and
    // its aria-current did not, so a completed step kept announcing itself as
    // the current one. A class binding is always an effect; an attribute is
    // grouped as static unless its expression looks reactive, and the memo
    // read `$$_const_status()` did not match that test.
    const C = await build(
      `<script>let step = 0</script>
{#each [0, 1] as i}
  {@const state = i === step ? 'active' : 'done'}
  <li aria-current={state === 'active' ? 'step' : null} data-state={state}></li>
{/each}
<button on:click={() => step = 1}>go</button>`, 'C.mesa')

    const c = mount(C)
    const li = () => [...c.querySelectorAll('li')]
    expect(li().map(x => x.getAttribute('aria-current'))).toEqual(['step', null])

    c.querySelector('button').click()
    $rt.flushSync()
    expect(li().map(x => x.getAttribute('data-state'))).toEqual(['done', 'active'])
    expect(li().map(x => x.getAttribute('aria-current'))).toEqual([null, 'step'])
    c.remove()
  })
})

describe('an assignment inside a component prop', () => {
  // `on:click` on an element has always passed ctx.setters to rewriteExpr; the
  // component-prop path did not, so the assignment target was rewritten as a
  // READ. Clean compile, module loads, and the click throws `Invalid left-hand
  // side in assignment` — found when a Modal's Cancel button did nothing.

  it('compiles to a signal write, not a read', async () => {
    const { result } = await compile(
      `<script>import C from './C.mesa'\n let open = true</script><C onclick={() => open = false} />`)
    expect(result).toContain('$$set_open(false)')
    expect(result).not.toMatch(/\$\$runtime\.get\(\$\$sig_open\)\s*=/)
    parseJs(result, { ecmaVersion: 'latest', sourceType: 'module' })   // throws if not
  })

  it('runs — the parent state actually changes', async () => {
    const Child = await build(
      `<script>export let onclick = undefined</script><button on:click={onclick}>go</button>`,
      'Child.mesa')
    const Parent = await build(
      `<script>import Child from './Child.mesa'\n let open = true</script>
<Child onclick={() => open = false} />
<p>{open ? 'open' : 'closed'}</p>`, 'Parent.mesa', Child)

    const c = mount(Parent)
    expect(c.querySelector('p').textContent).toBe('open')
    c.querySelector('button').click()
    $rt.flushSync()
    expect(c.querySelector('p').textContent).toBe('closed')
    c.remove()
  })
})

describe('$.attributes', () => {
  // VISION §12 calls it "all attributes passed to this component… use for
  // forwarding". It was `$$option.props` unfiltered — the same thing as $.props —
  // so forwarding it wrote every declared prop onto the DOM node.

  it('excludes declared props, and class', async () => {
    // `{class}` is the opt-in that merges the caller's classes; `$.attributes`
    // must not carry `class` as well, or the spread would REPLACE them.
    const Child = await build(
      `<script>export let tone = ''</script><i class="pill {tone}" {class} {...$.attributes}></i>`,
      'Child.mesa')
    const Parent = await build(
      `<script>import Child from './Child.mesa'</script>
<Child tone="danger" id="x" aria-label="Delete" class="extra" />`, 'Parent.mesa', Child)

    const c = mount(Parent)
    const el = c.querySelector('i')
    expect(el.id).toBe('x')
    expect(el.getAttribute('aria-label')).toBe('Delete')
    expect(el.getAttribute('tone')).toBe(null)          // declared — not an attribute
    expect(el.className).toContain('pill')              // class MERGES, never replaced
    expect(el.className).toContain('danger')
    expect(el.className).toContain('extra')
    c.remove()
  })
})

describe('a snippet declared inside a component tag', () => {
  // VISION §9.5 documents these as same-name props. They were not: the snippet
  // fell into the default slot, was hoisted as a local function in the SLOT's
  // scope, and nothing called it — so <Table>{#snippet row(r)}…{/snippet}</Table>
  // drew a head and an empty body with no error anywhere. Found reskinning
  // example/ with @frontierjs/ui, whose whole composition API is snippet props.

  it('is passed as a prop, not as slot content', async () => {
    const { result } = await compile(
      `<script>import C from './C.mesa'</script><C>{#snippet row(r)}<i>{r}</i>{/snippet}</C>`)
    expect(result).toMatch(/row: \$\$snip\d+_row/)
  })

  it('renders, and receives its argument', async () => {
    const Child = await build(
      `<script>export let row = null\n export let items = []</script>
<ul>{#each items as it}<li>{@render row?.(it)}</li>{/each}</ul>`, 'Child.mesa')
    const Parent = await build(
      `<script>import Child from './Child.mesa'\n const items = ['a', 'b']</script>
<Child items={items}>
  {#snippet row(name)}<b>{name}</b>{/snippet}
</Child>`, 'Parent.mesa', Child)

    const c = mount(Parent)
    expect([...c.querySelectorAll('li b')].map(b => b.textContent)).toEqual(['a', 'b'])
    c.remove()
  })

  it('re-renders when the argument changes — a snippet arg is a getter', async () => {
    // The second half of the same bug. Passing the snippet through fixed the
    // empty table; the rows then never changed again, because `{@render row(r)}`
    // read `r` once while building the block. A kit Table showed the first load
    // and ignored every one after it, with nothing in the console.
    const Child = await build(
      `<script>export let body = null\n export let value = 0</script><p>{@render body?.(value)}</p>`,
      'Child.mesa')
    const Parent = await build(
      `<script>import Child from './Child.mesa'\n let n = 1</script>
<Child value={n}>{#snippet body(v)}<i>{v}</i>{/snippet}</Child>
<button on:click={() => n = 2}>go</button>`, 'Parent.mesa', Child)

    const c = mount(Parent)
    expect(c.querySelector('i').textContent).toBe('1')
    c.querySelector('button').click()
    $rt.flushSync()
    expect(c.querySelector('i').textContent).toBe('2')
    c.remove()
  })

  it('re-renders each row when the list is replaced, index-keyed', async () => {
    // The shape @frontierjs/ui's Table uses: {#each rows as r, i (i)} around a
    // {@render row?.(r, i)}. An index key means the block is REUSED when the
    // array is replaced, so the only thing that can update the cells is the
    // argument being read reactively.
    const Child = await build(
      `<script>export let row = null\n export let rows = []</script>
<ul>{#each rows as r, i (i)}<li>{@render row?.(r, i)}</li>{/each}</ul>`, 'Child.mesa')
    const Parent = await build(
      `<script>import Child from './Child.mesa'\n let items = [{n:'a'}]</script>
<Child rows={items}>{#snippet row(r)}<b>{r.n}</b>{/snippet}</Child>
<button on:click={() => items = [{n:'z'}]}>go</button>`, 'Parent.mesa', Child)

    const c = mount(Parent)
    expect(c.querySelector('b').textContent).toBe('a')
    c.querySelector('button').click()
    $rt.flushSync()
    expect(c.querySelector('b').textContent).toBe('z')
    c.remove()
  })

  it('gives two components in one block their own `row` without collision', async () => {
    const { result } = await compile(
      `<script>import C from './C.mesa'</script>
<C>{#snippet row(r)}<i>{r}</i>{/snippet}</C>
<C>{#snippet row(r)}<b>{r}</b>{/snippet}</C>`)
    const names = [...result.matchAll(/const (\$\$snip\d+_row) =/g)].map(m => m[1])
    expect(names).toHaveLength(2)
    expect(new Set(names).size).toBe(2)
  })
})

describe('a valueless attribute on a component', () => {
  // Found by reskinning example/ with @frontierjs/ui: `<Table striped hover>`
  // threw `striped is not defined` on mount. The compiler had emitted the
  // attribute NAME as an expression, so the boolean form and the braced
  // shorthand `{striped}` meant the same thing — and the boolean form only
  // worked when the caller happened to have a variable of that name.

  it('is the boolean form — striped, not a reference to `striped`', async () => {
    const { result } = await compile(
      `<script>import C from './C.mesa'</script><C striped hover />`)
    expect(result).toContain('striped: true')
    expect(result).toContain('hover: true')
    expect(result).not.toMatch(/striped:\s*striped/)
  })

  it('reaches the child as true, and a same-named local does not leak into it', async () => {
    const Child = await build(
      `<script>export let striped = false</script><p>{striped ? 'on' : 'off'}</p>`, 'Child.mesa')
    const Parent = await build(
      // A local named `striped` — the shape that made the old behavior silent
      // rather than loud. The prop must still be true.
      `<script>import Child from './Child.mesa'\n const striped = false</script><Child striped />`,
      'Parent.mesa', Child)

    const c = mount(Parent)
    expect(c.querySelector('p').textContent).toBe('on')
    c.remove()
  })

  it('is NOT the boolean form when an empty string is stated explicitly', async () => {
    // Found by wiring @frontierjs/ui's <Select> into packages/basecamp:
    // `placeholder=""` is how the kit documents "suppress the placeholder",
    // and it compiled to placeholder={true} — so the <option> rendered the
    // word `true`. The parser has always distinguished the two forms
    // (value: undefined vs value: ''); inspectProp tested falsiness and lost it.
    const { result } = await compile(
      `<script>import C from './C.mesa'</script><C placeholder="" label="x" square />`)
    expect(result).not.toContain('placeholder: true')
    // All three forms in one call: explicit empty string, ordinary string, and
    // the valueless boolean — which must still be true.
    expect(result).toContain('placeholder: ``')
    expect(result).toContain('label: `x`')
    expect(result).toContain('square: true')
  })

  it('passes an explicit empty string through to the child as ""', async () => {
    const Child = await build(
      `<script>export let placeholder = 'fallback'</script><p>{placeholder ? placeholder : 'none'}</p>`,
      'Child.mesa')
    const Parent = await build(
      `<script>import Child from './Child.mesa'</script><Child placeholder="" />`,
      'Parent.mesa', Child)

    const c = mount(Parent)
    expect(c.querySelector('p').textContent).toBe('none')
    c.remove()
  })

  it('still passes the variable when the braced shorthand is used', async () => {
    const { result } = await compile(
      `<script>import C from './C.mesa'\n let striped = true</script><C {striped} />`)
    expect(result).not.toContain('striped: true')
    expect(result).toMatch(/striped:/)
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
    // The fix must not disable the optimization for the ordinary case.
    const { result } = await compile(
      `<script>let a = 1\n let b = 2</script><div id={a} title={b}>{a}</div>`)
    expect(result).toContain('$$runtime.render(')
    expect((result.match(/\$\$runtime\.render\(/g) ?? []).length).toBe(1)
  })
})

describe('bind: to a member expression', () => {
  /*
   * The setter's target was emitted verbatim while the getter was rewritten
   * through the accessors, so binding to a property of a reactive `let` produced
   *
   *   getter: () => ($$runtime.get($$sig_draft)[key])
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
    // `$$runtime.get($$sig_x) = $$v` would be a syntax error, so only member
    // expressions are rewritten.
    const { result } = await compile(
      `<script>export let value = ''</script><input bind:value={value} />`)
    expect(result).toContain('bindInput')
  })

  it('CURRENT BEHAVIOR: the mutation does not notify other readers', async () => {
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

describe('a const holding a function that writes to a reactive let', () => {
  /*
   * `const bump = () => { n = n + 1 }` is the most ordinary handler there is,
   * and until 2026-08-03 it emitted
   *
   *   const bump = $$runtime.trackDerived(() => (() => { $$runtime.get($$sig_n) = … }))
   *
   * — an invalid assignment target. analysis.errors was empty and the module
   * threw on load. The read was rewritten through the accessor; the *write* was
   * not, because the derived-const emitter called rewriteExpr without first
   * calling rewriteAssignments. `function bump() {}` was always fine, so the
   * bug was invisible to anyone who wrote handlers that way.
   *
   * Found via @frontierjs/ui, where it killed Accordion and Tabs outright.
   */
  it('rewrites the write through the setter, not the getter', async () => {
    const { result } = await compile(
      `<script>let n = 0\nconst bump = () => { n = n + 1 }</script><button on:click={bump}>{n}</button>`)
    expect(result).not.toMatch(/\$\$runtime\.get\([^)]*\)\s*=[^=]/)
    expect(result).toContain('$$set_n')
  })

  it('actually increments when clicked', async () => {
    const C = await build(
      `<script>let n = 0\nconst bump = () => { n = n + 1 }</script><button on:click={bump}>{n}</button>`,
      'Bump.mesa')
    const c = mount(C)
    const btn = c.querySelector('button')
    expect(btn.textContent).toBe('0')
    btn.click()
    $rt.flushSync()
    expect(btn.textContent).toBe('1')
    c.remove()
  })

  it('applies to a mutator provided through $.context', async () => {
    // How every compound component here shares state — Accordion/Tabs provide
    // a toggle down to their items. Same emitter path, same broken output.
    const { result } = await compile(
      `<script>let open = {}\n$.context.toggle = (id) => { open = { ...open, [id]: true } }</script><b>x</b>`)
    expect(result).not.toMatch(/\$\$runtime\.get\([^)]*\)\s*=[^=]/)
    expect(result).toContain('$$set_open')
  })

  it('leaves a destructured declarator alone', async () => {
    // A pattern declarator is expanded into flat vars with no initNode, and
    // rewriteAssignments needs a real node for its source offset. Guarding that
    // is what keeps this fix from throwing during compile.
    const { result } = await compile(
      `<script>const { a, b } = { a: 1, b: 2 }</script><b>{a}{b}</b>`)
    expect(result).toBeTruthy()
  })
})

describe('a destructuring assignment to reactive lets', () => {
  /*
   * `[a, b] = [b, a]` used to emit `[$$runtime.get($$sig_a), …] = …` — the same
   * invalid target the suite above covers, reached a different way: both
   * rewriters recognized only a bare Identifier on the left, so a pattern fell
   * through to the generic descent and every target was rewritten as a READ.
   * Clean compile, empty analysis.errors, module dead on load. The kit's
   * DatePicker used the swap idiom and threw before it rendered anything.
   *
   * The pattern is now mirrored into temps and each target written back
   * through whatever it is, so the cases below are about the leaves: what a
   * pattern can hold, and which half of it is reactive.
   *
   * Two paths, and each one broke on its own: a handler in the SCRIPT goes
   * through rewriteAssignments, a handler written inline on the element goes
   * through rewriteExpr. Every case here is driven inline for that reason.
   */

  /** Click the button, and report the <p> before and after. */
  const drive = async (name, script, template) => {
    const C = await build(`<script>${script}</script>${template}`, name)
    const c = mount(C)
    const p = c.querySelector('p')
    const before = p.textContent
    c.querySelector('button').click()
    $rt.flushSync()
    const after = p.textContent
    c.remove()
    return { before, after }
  }

  it('swaps two reactive lets', async () => {
    expect(await drive('Swap.mesa',
      `let a = 1\nlet b = 2`,
      `<p>{a}{b}</p><button on:click={() => { [a, b] = [b, a] }}>go</button>`
    )).toEqual({ before: '12', after: '21' })
  })

  it('swaps them from a const handler in the script', async () => {
    expect(await drive('SwapScript.mesa',
      `let a = 1\nlet b = 2\nconst swap = () => { [a, b] = [b, a] }`,
      `<p>{a}{b}</p><button on:click={swap}>go</button>`
    )).toEqual({ before: '12', after: '21' })
  })

  it('takes an object pattern, shorthand or keyed', async () => {
    expect(await drive('Obj.mesa',
      `let p = 1\nlet q = 2\nconst o = { p: 8, q: 9, r: 7 }`,
      `<p>{p}{q}</p><button on:click={() => { ({ p } = o); ({ r: q } = o) }}>go</button>`
    )).toEqual({ before: '12', after: '87' })
  })

  it('honors a default in the pattern', async () => {
    // The default is an ordinary expression and may read a signal, so it is
    // rewritten in place rather than carried across verbatim.
    expect(await drive('Default.mesa',
      `let fallback = 5\nlet a = 1\nlet b = 2`,
      `<p>{a}{b}</p><button on:click={() => { ({ a = fallback } = {}); [b = fallback + 1] = [] }}>go</button>`
    )).toEqual({ before: '12', after: '56' })
  })

  it('takes a hole, a rest element and a nested pattern', async () => {
    expect(await drive('Shapes.mesa',
      `let a = 0\nlet tail = []\nlet deep = 0`,
      `<p>{a}{tail.join('-')}{deep}</p>` +
      `<button on:click={() => { [, a, ...tail] = [1, 2, 3, 4]; [{ v: deep }] = [{ v: 9 }] }}>go</button>`
    )).toEqual({ before: '00', after: '23-49' })
  })

  it('writes a plain local and a member target in the same pattern', async () => {
    // Only one target being reactive is the case that decides the shape: the
    // others cannot go through a setter and must still land.
    expect(await drive('Mixed.mesa',
      `let a = 0\nlet seen = ''\nconst o = { x: 0 }`,
      `<p>{a}{seen}</p>` +
      `<button on:click={() => { let plain = 0; [a, plain, o.x] = [1, 2, 3]; seen = plain + ':' + o.x }}>go</button>`
    )).toEqual({ before: '0', after: '12:3' })
  })

  it('still evaluates to the right-hand value', async () => {
    expect(await drive('Value.mesa',
      `let a = 0\nlet seen = ''`,
      `<p>{a}{seen}</p><button on:click={() => { seen = JSON.stringify(([a] = [3])) }}>go</button>`
    )).toEqual({ before: '0', after: '3[3]' })
  })

  it('leaves a pattern that names nothing reactive exactly as written', async () => {
    const { result } = await compile(
      `<script>const o = { x: 0, y: 0 }\nconst f = () => { [o.x, o.y] = [1, 2] }</script><b>x</b>`)
    expect(result).toContain('[o.x, o.y] = [1, 2]')
    expect(result).not.toContain('$$dv')
  })

  it('emits JS that parses, whichever path rewrote it', async () => {
    for (const src of [
      `<script>let a = 1\nlet b = 2\nconst swap = () => { [a, b] = [b, a] }</script><b on:click={swap}>{a}{b}</b>`,
      `<script>let a = 1\nlet b = 2</script><b on:click={() => { [a, b] = [b, a] }}>{a}{b}</b>`,
      `<script>let a = 1\nlet o = {}\n$: { ({ a = 0, ...o } = { a: 3 }) }</script><b>{a}{o}</b>`,
    ]) {
      const { result, analysis } = await compile(src)
      expect(analysis.errors).toEqual([])
      expect(() => parseJs(result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
    }
  })
})

describe('{@const} inside {#each} reading the loop index', () => {
  /*
   * `{@const isLast = idx === list.length - 1}` compiles to `idx()`, which was
   * a defect while the index was a plain number and is correct now that it is
   * a signal in its own right (2026-08-04, the fix for stale indices after a
   * keyed move). The kit's Breadcrumbs still precomputes the flag in its
   * script because of the old failure.
   *
   * Pinned here because the two halves are owned in different files — the
   * compiler decides to CALL it, the runtime decides to hand over a getter —
   * and either one moving alone brings back `idx is not a function`.
   */
  const row = (each, label) =>
    `<script>let list = [{ id: 1, a: 'x' }, { id: 2, a: 'y' }]</script>` +
    `<ul>{#each ${each}}{@const last = idx === list.length - 1}<li>{${label}}:{last}</li>{/each}</ul>` +
    `<button on:click={() => { list = [...list, { id: 3, a: 'z' }] }}>go</button>`

  it('reads the index in a plain, a keyed and a destructured each', async () => {
    for (const [name, each, label] of [
      ['Plain.mesa',    `list as item, idx`,           'item.a'],
      ['Keyed.mesa',    `list as item, idx (item.id)`, 'item.a'],
      ['Destruct.mesa', `list as { a }, idx`,          'a'],
    ]) {
      const C = await build(row(each, label), name)
      const c = mount(C)
      expect(c.querySelector('ul').textContent, name).toBe('x:falsey:true')
      // …and after a rebind, which is where a plain index would have been
      // written over the getter.
      c.querySelector('button').click()
      $rt.flushSync()
      expect(c.querySelector('ul').textContent, name).toBe('x:falsey:falsez:true')
      c.remove()
    }
  })
})

describe('the {class} passthrough', () => {
  /*
   * `<button class="btn primary" {class}>` has to end up carrying all three
   * classes. Until 2026-08-03 the passthrough went through the general
   * attribute path, which REPLACES: with no class prop the element lost
   * `btn primary` entirely, and with one it kept only the consumer's.
   *
   * That is invisible in a way most bugs are not — the component still
   * renders, it just has no classes — and it silently unstyled every
   * component in @frontierjs/ui that combined a base class with `{class}`,
   * which is nearly all of them.
   */
  it('keeps the component’s own classes when no class prop is passed', async () => {
    const C = await build('<kbd class="kbd" {class}>x</kbd>', 'Kbd.mesa')
    const c = mount(C)
    expect(c.querySelector('kbd').classList.contains('kbd')).toBe(true)
    c.remove()
  })

  it('merges the consumer’s class rather than replacing', async () => {
    const C = await build('<kbd class="kbd" {class}>x</kbd>', 'Kbd.mesa')
    const c = document.createElement('div')
    document.body.appendChild(c)
    const l = document.createElement('span')
    c.appendChild(l)
    $rt.mount(l, C, { props: { $class: 'extra' } })
    $rt.flushSync()
    const el = c.querySelector('kbd')
    expect(el.classList.contains('kbd')).toBe(true)
    expect(el.classList.contains('extra')).toBe(true)
    c.remove()
  })

  it('removes only what it added when the prop changes', async () => {
    const { result } = await compile('<kbd class="kbd" {class}>x</kbd>')
    // The dedicated call is the fix; bindAttribute here would mean the
    // grouping pass rewrites it back into a replacing set_attribute.
    expect(result).toContain('bindClassPassthrough')
    expect(result).not.toMatch(/bindAttribute\([^,]+,\s*'class'/)
  })
})

/**
 * The component function is named after the FILE, and that name has to be a
 * legal, unused identifier at module scope. Sanitising invalid characters is
 * not enough — two ways it still produced code that would not parse:
 *
 *   new.mesa    → `export default function new(…)`  — a reserved word
 *   leads.mesa  → `export const leads = …` in <script module>,
 *                 then `export default function leads(…)` — a redeclaration
 *   404.mesa    → `export default function 404(…)`  — starts with a digit
 *
 * All three compiled cleanly and failed later. The second became the ordinary
 * case once Sierra resources moved to .mesa (repo invariant 18): a resource
 * file is named after the thing it exports. The third arrived with the `site/`
 * surface, where `404.mesa` is the ordinary name for a not-found page — the
 * character sweep allows digits, because every one of them is legal further
 * along an identifier, and only the FIRST is not.
 */
describe('the component function name', () => {
  const topLevelNames = (code) =>
    parseJs(code, { ecmaVersion: 'latest', sourceType: 'module' })
      .body.flatMap(n => {
        const d = n.type === 'ExportNamedDeclaration' || n.type === 'ExportDefaultDeclaration'
          ? n.declaration : n
        if (!d) return []
        if (d.type === 'VariableDeclaration') return d.declarations.map(x => x.id.name)
        if (d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') return [d.id.name]
        return []
      })

  it('does not collide with a <script module> export of the same name', async () => {
    const ctx = await compile(
      `<script module>export const leads = { n: 1 }</script><p>hi</p>`,
      'leads.mesa',
    )
    expect(ctx.analysis.errors).toEqual([])
    expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()

    const names = topLevelNames(ctx.result)
    expect(names.filter(n => n === 'leads')).toHaveLength(1)   // the export, not the component
    expect(new Set(names).size).toBe(names.length)             // nothing declared twice
  })

  it('does not collide with a <script module> import or plain declaration', async () => {
    for (const moduleScript of [
      `import { orders } from './x.js'`,
      `const orders = 1`,
      `function orders() {}`,
      `const { orders } = obj`,
      `export { orders }`,
    ]) {
      const ctx = await compile(`<script module>${moduleScript}</script><p>hi</p>`, 'orders.mesa')
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }), moduleScript)
        .not.toThrow()
      const names = topLevelNames(ctx.result)
      expect(new Set(names).size, moduleScript).toBe(names.length)
    }
  })

  it('is not a reserved word', async () => {
    for (const word of ['new', 'class', 'function', 'delete', 'await']) {
      const ctx = await compile(`<p>hi</p>`, `${word}.mesa`)
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }), word)
        .not.toThrow()
    }
  })

  it('does not start with a digit', async () => {
    // The character sweep passes digits, so this reached esbuild as
    // `export default function 404(` and came back as six parse errors about a
    // temp file nobody wrote. `404.mesa` is what a static site calls its
    // not-found page, so the surface that has one finds this immediately.
    for (const base of ['404', '500', '2026-review', '1']) {
      const ctx = await compile(`<p>hi</p>`, `${base}.mesa`)
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }), base)
        .not.toThrow()
      expect(topLevelNames(ctx.result).some(n => /^[0-9]/.test(n)), base).toBe(false)
    }
  })

  it('is left alone when nothing collides', async () => {
    const ctx = await compile(`<script module>export const rows = []</script><p>hi</p>`, 'Orders.mesa')
    expect(ctx.result).toContain('export default function Orders(')
  })

  it('keeps the readable name for dev tooling even when the identifier is renamed', async () => {
    const ctx = await compileSource(
      `<script module>export const leads = 1</script><p>hi</p>`,
      { filename: 'leads.mesa', css: false, debug: false, dev: true },
    )
    expect(ctx.result).toContain(`push_component('leads'`)
    expect(ctx.result).not.toContain('export default function leads(')
  })
})

/**
 * A builtin name declared by the author (FJS-471).
 *
 * The compiler injects `$.props`, `$.onMount` and eleven others as `const` into
 * the component factory scope. An instance script declaring one emitted a
 * second `const` of that name — a duplicate binding, so the module did not
 * parse — while the compile reported nothing, which is this file's premise
 * exactly. Measured before the fix: 27 silently-invalid combinations across
 * `const`, `var` and `function`; `let` survived only because a reactive `let`
 * is renamed to `$$sig_<name>` before emit.
 */
describe('a declaration colliding with an injected builtin', () => {
  const RESERVED = [
    '$$option', '$$slots', '$$props', '$$attributes', '$context', '$$emit',
    '$$onMount', '$$onDestroy', '$$onCleanup', '$mounted', '$inspect',
    '$$ctxProvide', '$$ctxRead',
  ]
  const forms = {
    let:      (n) => `<script>let show = true; let ${n} = 1</script>{#if show}<p>x</p>{/if}`,
    const:    (n) => `<script>let show = true; const ${n} = 1</script>{#if show}<p>x</p>{/if}`,
    var:      (n) => `<script>let show = true; var ${n} = 1</script>{#if show}<p>x</p>{/if}`,
    function: (n) => `<script>let show = true; function ${n}(){ return 1 }</script>{#if show}<p>x</p>{/if}`,
    destructured: (n) => `<script>let show = true; const { v: ${n} } = {}</script>{#if show}<p>x</p>{/if}`,
  }

  for (const [form, make] of Object.entries(forms)) {
    it(`is refused by name for every builtin, declared as ${form}`, async () => {
      for (const name of RESERVED) {
        await expect(compile(make(name), `${name}.mesa`), `${form} ${name}`)
          .rejects.toThrow(/is a Mesa builtin and cannot be declared/)
      }
    })
  }

  it('names the builtin and the declaration form it found', async () => {
    await expect(compile(forms.const('$$props'), 'T.mesa'))
      .rejects.toThrow(/'\$\$props' is a Mesa builtin and cannot be declared as a const/)
  })

  // The refusal is about the factory scope, so a nested function may still use
  // the name — over-refusing here would break ordinary code that never collides.
  it('leaves a nested declaration of the same name alone', async () => {
    const ctx = await compile(
      `<script>function f(){ const $props = 1; return $props }</script><p>{f()}</p>`, 'T.mesa')
    expect(ctx.analysis.errors).toEqual([])
    expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  })

  it('leaves USING a builtin alone', async () => {
    for (const src of [
      `<script>$.onMount(() => {})</script><p>x</p>`,
      `<script>$.context.a = 1</script><p>x</p>`,
      `<script>const n = $.props.x</script><p>{n}</p>`,
      `<script>let a = 1; $: a, (v) => v</script><p>{a}</p>`,
    ]) {
      const ctx = await compile(src, 'T.mesa')
      expect(ctx.analysis.errors, src).toEqual([])
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }), src).not.toThrow()
    }
  })
})

/**
 * `$` — the component's door (FJS-D132, phase 1).
 *
 * Both spellings work here: the injected `$.onMount` and the door `$.onMount`.
 * The old one dies in phase 4, so these cases are about the door existing and
 * behaving, not about the old one being gone.
 *
 * Most of the door is a plain value on a real object, which is why `$.props`
 * and `$.slots` need no compiler support. Four are compiled rather than read —
 * `$.context` becomes a provide/read call, `$.inspect` is tracked then stripped,
 * `$.mounted` is counted, `$.async` is generated — and each is asserted by its
 * EFFECT, because all four compile and parse whether or not they were wired.
 */
describe('the $ door', () => {
  const src = (body, tmpl = '<p>x</p>') => `<script>${body}</script>${tmpl}`

  it('splits into a shared half at module scope and an instance half', async () => {
    const ctx = await compile(src(`$.onMount(() => {})`), 'T.mesa')
    const out = ctx.result
    expect(out).toContain('const $$shared = {')
    expect(out).toContain('const $ = Object.create($$shared);')
    // shared is declared once, outside the component function
    expect(out.indexOf('const $$shared')).toBeLessThan(out.indexOf('export default function'))
    // and the instance half is inside it
    expect(out.indexOf('export default function')).toBeLessThan(out.indexOf('Object.create($$shared)'))
  })

  it('is not emitted at all by a component that does not use it', async () => {
    const ctx = await compile(src(`let count = 0`, '<p>{count}</p>'), 'T.mesa')
    expect(ctx.result).not.toContain('$$shared')
    expect(ctx.result).not.toContain('Object.create')
  })

  it('emits valid JS for every member of the door', async () => {
    const cases = [
      `$.onMount(() => {})`,
      `$.onDestroy(() => {})`,
      `$.onMount(() => $.tick(() => {}))`,
      `const p = $.props.x`,
      `function go() { $.emit('go', 1) }`,
      `const a = $.entrance({})`,
      `$.context.k = 1`,
      `const t = $.context.k`,
    ]
    for (const body of cases) {
      const ctx = await compile(src(body), 'T.mesa')
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }), body).not.toThrow()
    }
  })

  it('compiles $.context to a provide and a read, not a property set', async () => {
    // Left as a member access this would assign to the shared context object
    // and provide nothing — it would compile, parse, and do nothing.
    const provide = await compile(src(`$.context.k = 1`), 'T.mesa')
    expect(provide.result).toMatch(/\$\$ctxProvide\('k'/)
    const read = await compile(src(`const t = $.context.k`, '<p>{t}</p>'), 'T.mesa')
    expect(read.result).toMatch(/\$\$ctxRead\('k'/)
  })

  it('tracks $.inspect, and strips it when debug is off', async () => {
    const on = await compileSource(src(`let a = 1; $.inspect(a)`, '<p>{a}</p>'),
      { filename: 'T.mesa', css: false, debug: true })
    expect(on.result).toMatch(/\$inspect\(/)
    const off = await compile(src(`let a = 1; $.inspect(a)`, '<p>{a}</p>'), 'T.mesa')
    expect(off.result).not.toMatch(/\$inspect\(/)
  })

  it('counts $.mounted for its one-per-component rule', async () => {
    const one = await compile(src(`const m = $.mounted(async () => {})`, '<mesa:mounted></mesa:mounted>'), 'T.mesa')
    expect(one.analysis.mountedVar).toBe('m')
    const two = await compile(src(`const a = $.mounted(async()=>{}); const b = $.mounted(async()=>{})`), 'T.mesa')
    expect(two.analysis.errors.some((e) => /only be called once/.test(e))).toBe(true)
  })

  it('reaches $.async from a template, where the script rewrite cannot see it', async () => {
    const ctx = await compile(src(`const rows = await fetch('/x')`, '<p>{$.async.rows.loading}</p>'), 'T.mesa')
    expect(ctx.result).toContain('$.async = $$async;')
    // assigned beside its own declaration, not with the rest of `$`, which has
    // already run past by then
    expect(ctx.result.indexOf('const $$async = {}')).toBeLessThan(ctx.result.indexOf('$.async = $$async;'))
  })

  it('is refused in <script module>, which runs outside any instance', async () => {
    await expect(compile(`<script module>$.onMount(() => {})</script><p>x</p>`, 'T.mesa'))
      .rejects.toThrow(/not available in <script module>/)
    // a module block that does not reach for it is untouched
    const ok = await compile(`<script module>export const rows = []</script><p>x</p>`, 'T.mesa')
    expect(ok.analysis.errors).toEqual([])
  })

  // Phase 4: the bare spelling is gone. It was working alongside the door
  // through phases 1-3, which is what let the 120-file rewrite land separately
  // from the compiler change.
  // Seven of the twelve. The other five are the data bags and carry a bare
  // spelling of their own (`FJS-D135`) — the case below this one.
  it('refuses the bare spelling of a CALLED member, naming the replacement', async () => {
    for (const [bare, member] of [
      [`$onMount(() => {})`,          'onMount'],
      [`$onDestroy(() => {})`,        'onDestroy'],
      [`function g(){ $emit('x') }`,  'emit'],
      [`const t = $tick()`,           'tick'],
    ]) {
      await expect(compile(src(bare), 'T.mesa'), bare)
        .rejects.toThrow(new RegExp(`'\\$${member}' is no longer injected — write '\\$\\.${member}'`))
    }
  })

  it('refuses a called member in a template too, which does not parse as JS', async () => {
    await expect(compile(`<script>let a = 1</script><p>{$tick}</p>`, 'T.mesa'))
      .rejects.toThrow(/'\$tick' is no longer injected/)
  })

  // The spread is the shape the phase-3 codemod nearly missed: `...` puts a dot
  // straight before the `$`, so a guard against a preceding dot skipped 66 of
  // the files it was written for. It is now the CANONICAL spelling, and the
  // door one still compiles — one binding under two names, so a component
  // mixing them cannot end up with two of anything.
  it('accepts both spellings of a data bag, and they are one binding', async () => {
    for (const spread of ['{...$attributes}', '{...$.attributes}']) {
      const ok = await compile(`<script>export let a</script><div ${spread}>{a}</div>`, 'T.mesa')
      expect(() => parseJs(ok.result, { ecmaVersion: 'latest', sourceType: 'module' }), spread).not.toThrow()
      expect(ok.result, spread).toContain('$$runtime.restProps($$option.props')
    }
    // Both in one component: one restProps call, and the alias reads it.
    const mixed = await compile(
      `<script>const p = $props.x</script><div {...$.attributes}>{p}</div>`, 'T.mesa')
    expect(mixed.result.match(/restProps\(/g) ?? []).toHaveLength(1)
    expect(mixed.result).toContain('const $props = $$props;')
  })

  // The bare spelling is canonical, so the collision check has to reserve it —
  // a top-level `let $props` would otherwise shadow the injected one silently.
  it('reserves the bare spelling against a top-level declaration', async () => {
    await expect(compile(`<script>let $props = 1</script><p>{$props}</p>`, 'T.mesa'))
      .rejects.toThrow(/\$props/)
  })

  // A name the author declared for themselves is not the builtin, and the
  // factory-scope collision check deliberately allows it in a nested scope.
  it('leaves a local the author declared alone', async () => {
    const ctx = await compile(
      `<script>function f(){ const $props = 1; return $props }</script><p>{f()}</p>`, 'T.mesa')
    expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  })
})

/**
 * `$` may not be destructured, aliased or shadowed (FJS-D132, phase 2).
 *
 * All three compile without this, and each loses the door differently: a
 * destructure at script top reads `$.async` before it is assigned, a copy is
 * not what the compiler tracks when it rewrites `$.context`, and a shadow
 * leaves the name pointing somewhere else entirely.
 *
 * The rule that covers all of them is that `$` is legal only as the object of a
 * member expression. Anything else naming it hands out a reference the compiler
 * cannot follow — which is what catches `function f({ x } = $)`, a destructure
 * wearing a default value, that the three named checks each walked past.
 */
describe('$ is not the author’s to take', () => {
  const s = (body, tmpl = '<p>x</p>') => `<script>${body}</script>${tmpl}`

  const REFUSED = {
    'destructured as an object':   `const { props } = $`,
    'destructured as an array':    `const [a] = $`,
    'aliased':                     `const d = $`,
    'shadowed by const':           `const $ = 1`,
    'shadowed by let':             `let $ = 1`,
    'shadowed by var':             `var $ = 1`,
    'shadowed by a function':      `function $(){}`,
    'shadowed by a class':         `class $ {}`,
    'a parameter':                 `function f($) { return $ }`,
    'an arrow parameter':          `const f = ($) => $`,
    'a parameter of a nested fn':  `function o(){ return function i($){ return $ } }`,
    'a catch binding':             `try { } catch ($) { }`,
    'imported':                    `import $ from 'x'`,
    'assigned to':                 `$ = 1`,
    'a parameter default':         `function f({ x } = $) { return x }`,
    'passed as an argument':       `function f(v){ return v }; const r = f($)`,
  }
  for (const [what, body] of Object.entries(REFUSED)) {
    it(`is refused when ${what}`, async () => {
      await expect(compile(s(body), 'T.mesa')).rejects.toThrow(/'\$' cannot be/)
    })
  }

  // The reactive label wears the same character and is not a binding at all —
  // JavaScript keeps labels in their own namespace. 77 files in this repo use
  // one, so over-refusing here breaks most of the tree.
  it('leaves the reactive label alone', async () => {
    for (const body of [`let a = 1; $: a, (v) => v`, `let a = 1; $_watch: a, (v) => v`]) {
      const ctx = await compile(s(body, '<p>{a}</p>'), 'T.mesa')
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }), body).not.toThrow()
    }
  })

  it('leaves a property named $ alone', async () => {
    const ctx = await compile(s(`const o = { $: 1 }; const v = o.$`, '<p>{v}</p>'), 'T.mesa')
    expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  })

  it('leaves reaching through the door alone', async () => {
    const ctx = await compile(s(`$.onMount(() => {}); const p = $.props.x`, '<p>{p}</p>'), 'T.mesa')
    expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  })
})

/**
 * The documented door and the enforced door are the same door.
 *
 * `DOOR_MEMBERS` in the compiler is what a bare spelling is refused against;
 * VISION § 17's table is what a person reads. They were a hand-kept copy of each
 * other, and the copy lost: the table listed thirteen of eighteen members, with
 * `$.tick`, `$.fade`, `$.slide` and `$.fly` reachable and written down nowhere.
 * Phase 5 renamed that table without grading it against the list.
 */
describe('VISION documents every member of the door', () => {
  it('lists each one the compiler knows about', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))

    const vision = readFileSync(resolve(here, '../docs/VISION.md'), 'utf8')
    // Either spelling documents a member: the five data bags are listed under
    // their canonical BARE name (`FJS-D135`), the other twelve under the door.
    const documented = new Set(
      [...vision.matchAll(/^\| `\$\.?([a-zA-Z]+)/gm)].map((m) => m[1]))

    // Read off the compiler rather than restated — a second list is the bug.
    const src = readFileSync(resolve(here, '../src/compiler.js'), 'utf8')
    const members = new Set([
      ...src.match(/const DOOR_MEMBERS = \[([\s\S]*?)\]/)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1)),
      ...src.match(/\[\.\.\.DOOR_MEMBERS, ([^\]]*)\]/)[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1)),
    ])

    const undocumented = [...members].filter((m) => !documented.has(m))
    expect(undocumented, `reachable but absent from VISION § 17: ${undocumented.join(', ')}`).toEqual([])
  })
})

/**
 * A compiled door member emits a local, and the local must exist (`FJS-477`).
 *
 * `$.mounted` and `$.context` are rewritten to `$mounted` / `$context` before
 * the script is parsed, and the DECLARATION of those locals was gated on a
 * sniff that recognized one shape each. Every other shape emitted a reference
 * to a binding nothing declared — which compiles, parses, and throws
 * ReferenceError on first render. Invariant 15's failure exactly, so the
 * assertion is Invariant 15's shape: parse the output, then check that every
 * single-`$` name it USES it also DECLARES.
 */
describe('a compiled door member never emits an undeclared local', () => {
  const s = (body, tmpl = '<p>x</p>') => `<script>${body}</script>${tmpl}`

  /** Every `$name` (not `$$name`) the output reads must be declared in it. */
  const undeclared = (code) => {
    const used = [...new Set(code.match(/(?<![$\w])\$[a-zA-Z_][\w]*/g) || [])]
    return used.filter((n) => !new RegExp(`(?:const|let|var)\\s+\\${n}\\b`).test(code))
  }

  const wired = [
    ['$.mounted, assigned',   s(`const ready = $.mounted(() => 1)`, '<p>{ready}</p>')],
    ['$.context consume',     s(`const v = $.context.k`, '<p>{v}</p>')],
    ['$.context provide',     s(`$.context.k = 1`)],
    ['$.context.use',         s(`const v = $.context.use('k')`, '<p>{v}</p>')],
    ['$.context.provide',     s(`$.context.provide('k', () => 1)`)],
    ['$.context itself',      s(`const c = $.context`)],
    ['$.context.use, template', `<p>{$.context.use('k')}</p>`],
  ]
  for (const [label, src] of wired) {
    it(`compiles and declares what it uses — ${label}`, async () => {
      const ctx = await compile(src)
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
      expect(undeclared(ctx.result), label).toEqual([])
    })
  }

  // The shapes the compiler cannot wire. Each refuses by name AND names the
  // spelling that works — an error that only says no leaves the author guessing
  // which of the four forms was meant to be the one.
  const refused = [
    ['$.mounted as a bare call',    s(`$.mounted(() => 1)`),        /gates the template|const ready = \$\.mounted/],
    ['$.mounted as a reference',    s(`const m = $.mounted`),       /const ready = \$\.mounted/],
    ['$.mounted from the template', `<p>{$.mounted}</p>`,           /not readable from the template/],
    ['$.context sugar in template', `<p>{$.context.k}</p>`,         /compile step is script-only/],
  ]
  for (const [label, src, names] of refused) {
    it(`refuses by name — ${label}`, async () => {
      await expect(compile(src), label).rejects.toThrow(names)
    })
  }

  // The gate reads the AST the rewrite produced. A regex over the text is what
  // let three of the four above through, so a form that only an AST can tell
  // apart is pinned: `$mounted` inside a string is not a use of the builtin.
  it('does not refuse the spelling inside a string literal', async () => {
    const ctx = await compile(s(`const label = 'call $.mounted(fn) to gate'`, '<p>{label}</p>'))
    expect(undeclared(ctx.result)).toEqual([])
  })
})

/**
 * VISION's rules index is a second copy of its own rules, and it drifts.
 *
 * Three times now: RULE 31a kept "compiler-internal name" in the index after
 * the inline rule was corrected, and RULE 18's row still read "`$builtins` are
 * auto-injected — never manually imported" after `FJS-D132` retired exactly
 * that, with 18a and 18b never added at all. Each time the inline rule was
 * fixed and the table was not, because nothing reads the table.
 *
 * So: every `**RULE n**` written inline must have a row in the index. The
 * reverse is deliberately NOT asserted — a row for a rule stated as prose
 * rather than as a RULE block is a documentation choice, not a defect.
 */
describe("VISION's rules index carries every rule", () => {
  it('has a row for each inline RULE', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, resolve } = await import('node:path')
    const vision = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../docs/VISION.md'), 'utf8')

    const inline  = new Set([...vision.matchAll(/\*\*RULE (\d+[a-z]?)\*\*/g)].map((m) => m[1]))
    const indexed = new Set([...vision.matchAll(/^\| (\d+[a-z]?) \| /gm)].map((m) => m[1]))
    expect(inline.size, 'found no inline rules — the pattern moved').toBeGreaterThan(30)

    const missing = [...inline].filter((r) => !indexed.has(r))
    expect(missing, `stated inline but absent from the rules index: ${missing.join(', ')}`).toEqual([])
  })
})

/**
 * `bind:class` on an element is refused, because it never worked (`FJS-478`).
 *
 * It lands in the FORM-VALUE path, whose generic branch is `el[name] = v` —
 * and there is no `class` DOM property. Measured in a real DOM: after
 * `el.class = 'raised'`, both `getAttribute('class')` and `className` are
 * unchanged and only `el.class` reads back, which is a JS expando. So neither
 * direction touched the element. VISION § 10.8 documented it as the two-way
 * half of class passthrough for its whole life, and no `.mesa` file used it.
 *
 * The component form is a different mechanism and stays: there `bind:class` is
 * an ordinary two-way prop, wired with `bindProp`.
 */
describe('class passthrough — the accepted surface', () => {
  const wired = (code) => /bindClassPassthrough/.test(code)

  it('accepts the forms that merge', async () => {
    for (const el of [
      `<div class="own" {class}>x</div>`,
      `<div class="own" class={$class}>x</div>`,
      `<script>let t='a'</script><div class={t} {class}>x</div>`,
    ]) {
      const ctx = await compile(el, 'T.mesa')
      expect(wired(ctx.result), el).toBe(true)
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }), el).not.toThrow()
    }
  })

  // `bind:` on an element means the DOM writes back, and it does that for form
  // values and nothing else (`FJS-D136`). Everything else reached the generic
  // `el[name] = v` branch, which for any attribute whose DOM property is spelled
  // differently wrote an expando in BOTH directions.
  it('accepts the form values an element writes back on', async () => {
    for (const el of [
      `<script>let v=''</script><input bind:value={v} />`,
      `<script>let v=false</script><input type="checkbox" bind:checked={v} />`,
      `<script>let v=null</script><input type="file" bind:files={v} />`,
      `<script>let v=[]</script><input type="checkbox" bind:group={v} value="a" />`,
      `<script>let el</script><div bind:this={el}>x</div>`,
    ]) {
      const ctx = await compile(el, 'T.mesa')
      expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }), el).not.toThrow()
    }
  })

  it('refuses every other bind: on an element, naming the one-way form', async () => {
    for (const [attr, el] of [
      ['readonly',        `<script>let v=false</script><input bind:readonly={v} />`],
      ['contenteditable', `<script>let v=true</script><div bind:contenteditable={v}>x</div>`],
      ['innerHTML',       `<script>let v=''</script><div bind:innerHTML={v}>x</div>`],
    ]) {
      await expect(compile(el, 'T.mesa'), attr)
        .rejects.toThrow(new RegExp(`not a two-way binding[\\s\\S]*${attr}=\\{expr\\}`))
    }
  })

  // A component is a different mechanism and every one of these is legal there.
  it('leaves a component two-way prop alone, whatever it is called', async () => {
    for (const p of ['open', 'sort', 'readonly', 'record']) {
      const ctx = await compile(
        `<script>import C from './C.mesa'\nlet v = 1</script><C bind:${p}={v} />`, 'T.mesa')
      expect(ctx.result, p).toContain('bindProp(')
    }
  })

  it('refuses bind:class on an element, naming {class}', async () => {
    for (const el of [
      `<div class="own" bind:class>x</div>`,
      `<div class="own" :class>x</div>`,
      `<div class="own" bind:class={$class}>x</div>`,
    ]) {
      await expect(compile(el, 'T.mesa'), el).rejects.toThrow(/is not a DOM property[\s\S]*\{class\}/)
    }
  })

  // The same spelling on a COMPONENT is an ordinary two-way prop and must
  // survive — the refusal above is about the element path alone.
  it('leaves bind:class on a component alone', async () => {
    const ctx = await compile(
      `<script>import C from './C.mesa'\nlet t='a'</script><C bind:class={t} />`, 'T.mesa')
    expect(ctx.result).toContain(`bindProp(`)
    expect(ctx.result).toContain(`'$class'`)
  })

  // Shares a colon with bind:class and is a different feature entirely.
  it('leaves the class:name toggle alone', async () => {
    const ctx = await compile(`<script>let on=true</script><div class="own" class:active={on}>x</div>`, 'T.mesa')
    expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
    expect(wired(ctx.result)).toBe(false)
  })
})

/**
 * The calling convention is reserved too (`FJS-482`).
 *
 * `__anchor` and `__props` are the component function's own parameters,
 * `__block` is threaded into every `track()` call, and `__prev` is the render
 * callback's. A top-level declaration of one lands in the same scope and WINS,
 * which is a shadow rather than a redeclaration — so unlike `FJS-471`'s
 * builtins these compiled to valid JavaScript and failed later, or not at all:
 *
 *   function __anchor(){}   → throws at mount, `anchor.before is not a function`
 *   const __prev = 9        → renders `[object Object]`, silently
 *
 * A nested scope is untouched, exactly as it is for the `$$` builtins: a
 * parameter of the author's own function shadows nothing of the compiler's.
 */
describe('a component may not declare the calling convention', () => {
  for (const [label, body] of Object.entries({
    'function __anchor()': `function __anchor(){ return 1 }`,
    'function __block()':  `function __block(){ return 1 }`,
    'const __prev':        `const __prev = 9`,
    'let __props':         `let __props = 9`,
  })) {
    it(`refuses ${label}, naming what it is`, async () => {
      await expect(compile(`<script>${body}\nlet c = 7</script><p>v{c}</p>`, 'T.mesa'), label)
        .rejects.toThrow(/is part of how Mesa calls a component/)
    })
  }

  it('leaves a nested scope alone', async () => {
    const ctx = await compile(
      `<script>const f = (__anchor) => __anchor + 1\nlet c = 7</script><p>{f(c)}</p>`, 'T.mesa')
    expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  })
})
