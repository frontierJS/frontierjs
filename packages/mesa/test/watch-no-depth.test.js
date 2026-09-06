/**
 * watch-no-depth.test.js — `$: a` on a value that has nothing inside it.
 *
 * The bare `$: a` form is the DEEP-watch opt-in: it is what changes `a`'s
 * accessor from `$$runtime.get($$sig_a)` to `$$proxy_a`, so that a mutation
 * three levels down notifies. On an object that is exactly right.
 *
 * On a PRIMITIVE there is nothing to proxy. `localWatchProxy` hands the value
 * straight back, `$$proxy_a` is an ordinary local holding a snapshot, and every
 * read of `a` in the component compiles to a plain variable read — so the
 * render effect subscribes to nothing. The component stops updating for that
 * name, with the value correct and the screen stale, and with no error, no
 * warning and no console output anywhere.
 *
 * Both instances of it in this repo were found the same way — as a handler that
 * looked broken. `let discountInput = ''` with `$: (discountInput)` beside it
 * left an Apply button permanently disabled while the box filled underneath it;
 * `let handoffError = null` in the same app meant the alert for a spent
 * checkout link never appeared, whatever went wrong (`FJS-505`).
 *
 * It is REFUSED rather than repaired, and that is the part worth stating: the
 * declaration is not merely broken on a primitive, it is redundant. A local
 * `let` is already a signal, so a whole-value watch on one can only add
 * deep-mutation tracking, and a primitive has no depth. Nothing is lost.
 *
 * The refusal is conservative — only an initializer that is VISIBLY a primitive
 * refuses, because `let x = fetchCount()` has the same hole and is not
 * decidable here, and a rule that guessed would refuse `let rows = []`.
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import { flushSync, mount } from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))
let n = 0

/** Compile and answer the analysis errors, without building anything. */
async function errorsFor(script, markup = '<p>{1}</p>') {
  const src = `<script>\n${script}\n</script>\n${markup}`
  const ctx = await compileSource(src, { filename: `/W${n++}.mesa`, dev: false })
  return ctx.analysis?.errors ?? []
}

/** Compile, import and mount — the same path a real component takes. */
async function render(src) {
  const ctx = await compileSource(src, { filename: `/WR${n}.mesa`, dev: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  const js = ctx.result.replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'./src/runtime.js'`)
  const file = path.join(process.cwd(), `_tmp_watch_${n++}.mjs`)
  writeFileSync(file, js)
  let Comp
  try { Comp = (await import('file://' + file)).default }
  finally { try { unlinkSync(file) } catch {} }

  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const label = document.createElement('span')
  wrap.appendChild(label)
  mount(label, Comp, { props: {} })
  flushSync(); await tick(); flushSync(); await tick()
  return wrap
}

const click = async (wrap, sel) => {
  wrap.querySelector(sel).click()
  flushSync(); await tick(); flushSync(); await tick()
}

describe('$: on a local `let` with no depth is refused (FJS-505)', () => {

  it.each([
    ['a number',         'let n = 0',      '$: (n)'],
    ['a string',         "let s = ''",     '$: (s)'],
    ['a template string', 'let t = `x`',   '$: (t)'],
    ['a boolean',        'let b = false',  '$: (b)'],
    ['null',             'let e = null',   '$: (e)'],
    ['no initializer',   'let u',          '$: (u)'],
    ['undefined',        'let v = undefined', '$: (v)'],
    ['a negative number', 'let m = -1',    '$: (m)'],
  ])('refuses %s', async (_label, decl, watch) => {
    const errs = await errorsFor(`${decl}\n${watch}`)
    expect(errs.some((e) => /has no depth/.test(e))).toBe(true)
  })

  it('names the variable and both ways out', async () => {
    const [err] = await errorsFor("let discountInput = ''\n$: (discountInput)")
    // The name, because a component has several of these and the message is
    // read in a build log with no line highlighted.
    expect(err).toContain("'$: discountInput'")
    expect(err).toContain('discountInput')
    // Delete it — the assignment already notifies. That is the fix in both
    // real cases and has to be the first thing said.
    expect(err).toMatch(/Delete the line/)
    // …and the form that does what somebody reaching for this usually meant.
    expect(err).toContain('$: discountInput, () => { ... }')
  })

  it.each([
    ['an object literal',  'let o = { a: 1 }',   '$: (o)'],
    ['an array literal',   'let r = []',         '$: (r)'],
    ['a call — not decidable here', 'let c = make()', '$: (c)'],
    ['a dotted path',      'let d = { a: 1 }',   '$: (d.a)'],
    ['a watch with a body', 'let g = 0',         '$: g, () => { }'],
    ['a derivation',       'let h = 0',          '$: k = h + 1'],
  ])('allows %s', async (_label, decl, watch) => {
    const errs = await errorsFor(`function make() { return {} }\n${decl}\n${watch}`)
    expect(errs.filter((e) => /has no depth/.test(e))).toEqual([])
  })

  it('allows a path on a plain object the component did not declare', async () => {
    // The case the form exists for. An imported store has no signal of its own,
    // so the proxy is the only thing that can report a change in it.
    const errs = await errorsFor(
      "import { cart } from './cart.js'\n$: (cart.total)"
    )
    expect(errs.filter((e) => /has no depth/.test(e))).toEqual([])
  })
})

describe('the reactivity the refusal protects', () => {

  it('a local `let` re-renders on its own, which is why the watch was redundant', async () => {
    // The component the refusal points at. No `$:` anywhere, and the button's
    // own disabled state follows the value — which is exactly what the watch
    // was preventing.
    const wrap = await render(`<script>
  let text = ''
  function type() { text = 'typed' }
</script>
<button id="go" disabled={!text}>go</button>
<button id="type" onclick={type}>type</button>
<b>{text}</b>`)

    expect(wrap.querySelector('#go').disabled).toBe(true)
    await click(wrap, '#type')
    expect(wrap.querySelector('#go').disabled).toBe(false)
    expect(wrap.querySelector('b').textContent).toBe('typed')
  })

  it('a deep watch on an object still tracks a mutation inside it', async () => {
    // The half that must NOT regress. A local `let` notifies on ASSIGNMENT;
    // mutating a property of the object it holds is invisible without this,
    // and the bare form over an object is how a component asks for it.
    const wrap = await render(`<script>
  let draft = { name: 'a' }
  $: (draft)
  function edit() { draft.name = 'b' }
</script>
<b>{draft.name}</b>
<button id="edit" onclick={edit}>edit</button>`)

    expect(wrap.querySelector('b').textContent).toBe('a')
    await click(wrap, '#edit')
    expect(wrap.querySelector('b').textContent).toBe('b')
  })

  it('a deep watch on a named path tracks that path', async () => {
    const wrap = await render(`<script>
  let draft = { name: 'a', other: 'x' }
  $: (draft.name)
  function edit() { draft.name = 'b' }
</script>
<b>{draft.name}</b>
<button id="edit" onclick={edit}>edit</button>`)

    expect(wrap.querySelector('b').textContent).toBe('a')
    await click(wrap, '#edit')
    expect(wrap.querySelector('b').textContent).toBe('b')
  })
})
