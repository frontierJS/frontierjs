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
    expect(result).not.toMatch(/\$runtime\.get\(\$\$sig_open\)\s*=/)
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

describe('$attributes', () => {
  // VISION §12 calls it "all attributes passed to this component… use for
  // forwarding". It was `$option.props` unfiltered — the same thing as $props —
  // so forwarding it wrote every declared prop onto the DOM node.

  it('excludes declared props, and class', async () => {
    // `{class}` is the opt-in that merges the caller's classes; `$attributes`
    // must not carry `class` as well, or the spread would REPLACE them.
    const Child = await build(
      `<script>export let tone = ''</script><i class="pill {tone}" {class} {...$attributes}></i>`,
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
      // A local named `striped` — the shape that made the old behaviour silent
      // rather than loud. The prop must still be true.
      `<script>import Child from './Child.mesa'\n const striped = false</script><Child striped />`,
      'Parent.mesa', Child)

    const c = mount(Parent)
    expect(c.querySelector('p').textContent).toBe('on')
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

describe('a const holding a function that writes to a reactive let', () => {
  /*
   * `const bump = () => { n = n + 1 }` is the most ordinary handler there is,
   * and until 2026-08-03 it emitted
   *
   *   const bump = $runtime.trackDerived(() => (() => { $runtime.get($$sig_n) = … }))
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
    expect(result).not.toMatch(/\$runtime\.get\([^)]*\)\s*=[^=]/)
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

  it('applies to a mutator provided through $context', async () => {
    // How every compound component here shares state — Accordion/Tabs provide
    // a toggle down to their items. Same emitter path, same broken output.
    const { result } = await compile(
      `<script>let open = {}\n$context.toggle = (id) => { open = { ...open, [id]: true } }</script><b>x</b>`)
    expect(result).not.toMatch(/\$runtime\.get\([^)]*\)\s*=[^=]/)
    expect(result).toContain('$$set_open')
  })

  it('CURRENT GAP: a destructuring assignment is not rewritten', async () => {
    /*
     * `[a, b] = [b, a]` to two reactive lets emits `$runtime.get(sig) = …`,
     * the same invalid target the tests above cover — rewriteAssignments only
     * recognises a bare Identifier on the left. Unlike those, this one is NOT
     * fixed: it is pinned here so the gap is discoverable rather than found
     * again by a module that throws on load. Write a temp-variable swap.
     * If this is ever implemented, delete this test — do not adjust it.
     */
    const { result } = await compile(
      `<script>let a = 1\nlet b = 2\nconst swap = () => { [a, b] = [b, a] }</script><b>{a}{b}</b>`)
    // The reads are rewritten, the assignment target is not — so the emitted
    // pattern is `[$runtime.get(…), $runtime.get(…)] = …`, which does not parse.
    expect(result).toContain('[$runtime.get($$sig_a), $runtime.get($$sig_b)] =')
    expect(() => parseJs(result, { ecmaVersion: 'latest', sourceType: 'module' })).toThrow()
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
 *
 * Both compiled cleanly, ran in dev, and failed only at `vite build`. The
 * second became the ordinary case once Sierra resources moved to .mesa (repo
 * invariant 18): a resource file is named after the thing it exports.
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
