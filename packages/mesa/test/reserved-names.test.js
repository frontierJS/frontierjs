/**
 * `$$` is the compiler's prefix and an author may not declare one (`FJS-883`).
 *
 * The refusal used to be a LIST — `BUILTIN_LOCALS` — presented as closed. It
 * could not be: three of the colliding families are built from the author's own
 * identifiers (`$$sig_<name>`, `$$set_<name>`, `$$snippet_<name>`) and two from
 * a counter (`$$tpl<n>`, `$$el<n>`), so no set of literals reaches them. Both
 * failure modes were live and neither was reported — a name the emitter also
 * declares is a duplicate binding, so the output does not parse; a name it only
 * imports is shadowed, so the output parses and the component throws at mount
 * inside generated code.
 *
 * The second half of this file is what keeps the first half honest: every name
 * refused is asserted to be a name the emitter STILL generates. A refusal over
 * a name nothing emits protects nothing, and reads identically from the
 * refused side.
 *
 * Svelte shipped the list version of this and it did not hold. Svelte 4's
 * `reserved_keywords.js` was three names — `$$props`, `$$restProps`, `$$slots`
 * — and #4587, #5355 and #6718 are three reports of one failure: a name the
 * compiler used that the list did not know about. #6718 is the one to read,
 * because the maintainers REFUSED to add the missing name rather than growing
 * the list again. Their standing rule is the prefix (`dollar_prefix_invalid`,
 * shipped in 3.0.0), with everything unprefixed run through a uniquifier
 * instead; #3272 is where they chose to error at compile time rather than make
 * codegen dodge the name, which is the choice made here too.
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { parse as parseJs } from 'acorn'
import { compileSource } from '../src/compiler.js'
import { mount, flushSync } from '../src/runtime.js'

const compile = (src, filename = 'T.mesa') =>
  compileSource(src, { filename, css: false, debug: false, dev: false })

// Every construct at once, so one compile carries every generated family.
const RICH = `<script>
  let x = 1
  export let p = 2
</script>
{#snippet card(a)}<i>{a}</i>{/snippet}
<div>{x}{p}</div>
{#if x}<b>y</b>{/if}
{@render card(1)}
`

describe('the names the compiler generates', () => {
  // The refused list and the emitted list are the same list, read two ways.
  const FAMILIES = {
    '$$runtime':      'the module namespace import every emitted line calls through',
    '$$tpl0':         'the first template',
    '$$el0':          'the first bound element',
    '$$sig_x':        'the signal behind a reactive `let x`',
    '$$set_x':        'its setter',
    '$$snippet_card': 'a {#snippet card}',
  }

  it('are all still emitted — the control for every refusal below', async () => {
    const out = (await compile(RICH)).result
    for (const [name, what] of Object.entries(FAMILIES)) {
      expect(out, `${name} — ${what}`).toContain(name)
    }
  })

  const forms = {
    const:    (n) => `const ${n} = 1`,
    let:      (n) => `let ${n} = 1`,
    var:      (n) => `var ${n} = 1`,
    function: (n) => `function ${n}(){ return 1 }`,
    class:    (n) => `class ${n} {}`,
    destructured: (n) => `const { v: ${n} } = {}`,
  }

  for (const [form, make] of Object.entries(forms)) {
    it(`refuses a declaration of one, as a ${form}`, async () => {
      for (const name of Object.keys(FAMILIES)) {
        await expect(
          compile(`<script>let x = 1\n${make(name)}</script><div>{x}</div>`),
          `${form} ${name}`,
        ).rejects.toThrow(/'\$\$/)
      }
    })
  }

  it('names the prefix and both failures, not one of them', async () => {
    // An author cannot tell from their own source which of the two they hit —
    // whether the name they chose is one the emitter declares or one it only
    // imports — so the message says both.
    await expect(compile(`<script>const $$whatever = 1</script><p>x</p>`))
      .rejects.toThrow(/'\$\$whatever' cannot be declared as a const — '\$\$' is reserved/)
    await expect(compile(`<script>const $$whatever = 1</script><p>x</p>`))
      .rejects.toThrow(/SyntaxError in the output, or shadows one, which throws at mount/)
  })
})

describe('what the prefix rule must NOT reach', () => {
  it('a nested declaration, which shadows nothing at the factory scope', async () => {
    const ctx = await compile(
      `<script>function f(){ const $$tmp = 1; return $$tmp }</script><p>{f()}</p>`)
    expect(ctx.analysis.errors).toEqual([])
    expect(() => parseJs(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow()
  })

  it('a name that merely contains the prefix', async () => {
    const ctx = await compile(`<script>const a$$b = 1</script><p>{a$$b}</p>`)
    expect(ctx.result).toContain('a$$b')
  })

  it('a single-$ builtin, which is the other rule and keeps its own message', async () => {
    await expect(compile(`<script>const $context = 1</script><p>x</p>`))
      .rejects.toThrow(/'\$context' is a Mesa builtin/)
  })
})

describe('the name the rename freed', () => {
  // `el0` was the one generated identifier with no sigil, so `const el0 = 1`
  // emitted a duplicate binding and the compile said nothing. Renaming it to
  // `$$el0` is what lets the refusal be a prefix rather than a list with an
  // ordinary-looking word in it — and it hands `el0` back to the author.
  it('an author may now declare el0, and it mounts', async () => {
    const src = `<script>const el0 = 'kept'</script><p>{el0}</p>`
    const out = (await compile(src, 'ElName.mesa')).result
    expect(out).toContain('$$el0')

    const DIR = process.cwd()
    const f = path.join(DIR, '_reserved_el.mjs')
    writeFileSync(f, out.replace(/'@frontierjs\/mesa\/runtime\.js'/g,
      `'${path.join(DIR, 'src/runtime.js')}'`))
    try {
      const C = (await import('file://' + f)).default
      const host = document.createElement('div')
      document.body.appendChild(host)
      const anchor = document.createElement('span')
      host.appendChild(anchor)
      mount(anchor, C, { props: {} })
      flushSync()
      expect(host.innerHTML).toContain('kept')
    } finally { try { unlinkSync(f) } catch {} }
  })
})
