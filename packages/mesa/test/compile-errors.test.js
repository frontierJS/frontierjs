/**
 * compile-errors.test.js
 *
 * What an author is TOLD when a component does not compile.
 *
 * Three fail-opens met here (FJS-845, FJS-830, FJS-866). `analysis.errors` is
 * the only channel that fails a build, and until this the compiler reported it
 * before it was filled: parse-time errors were merged one line after the report
 * loop and every template-build error arrived long after it, so `config.warning`
 * saw a clean compile for a component the compiler had already refused.
 * `renderComponent` never read the list at all, so a prerender emitted the
 * broken markup and said nothing. And the most serious thing the compiler can
 * discover — this script does not parse — went to `warning` rather than to
 * `errors`, and traded the whole script for an empty program.
 *
 * Invariant 15: a clean compile is not proof of valid JS. Every case here is a
 * compile that reported success and emitted a module acorn refuses, or one that
 * emitted a component referencing names it had silently deleted.
 *
 * Run: npx vitest run compile-errors.test.js
 */

import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compile } from '../src/compiler.js'
import { renderComponent } from '../src/render-component.js'

/** Compile and collect both channels separately. */
async function cx(source, config = {}) {
  const warnings = []
  const ctx = await compile(source, {
    filename: 'Probe.mesa',
    warning: (w) => warnings.push(w.message ?? String(w)),
    ...config
  })
  return { ctx, warnings, errors: ctx.analysis?.errors ?? [] }
}

/** What the compile threw, as a string — '' when it did not. */
async function threw(source, config = {}) {
  try {
    await compile(source, { filename: 'Probe.mesa', warning: () => {}, ...config })
    return ''
  } catch (e) {
    return e.message
  }
}

// ─── FJS-845 · the report reaches the caller ─────────────────────────────────

describe('every collected error reaches the caller', () => {
  // Merged five lines AFTER the loop that reports it, so the callback was never
  // invoked and the Vite plugin re-reading the list was the entire safety net.
  it('reports a parse-time error, not only collects it', async () => {
    const { warnings, errors } = await cx('<b>{@attach foo}</b>')
    expect(errors.join('\n')).toMatch(/\{@attach\} is an element directive/)
    expect(warnings.join('\n')).toMatch(/\{@attach\} is an element directive/)
  })

  it('reports an unknown <mesa:*> element', async () => {
    const { warnings } = await cx('<mesa:frobnicate />')
    expect(warnings.join('\n')).toMatch(/<mesa:frobnicate> is not a Mesa element/)
  })

  // The template build runs long after the old report loop, so `bind:this` on a
  // non-`let`, `{@const}` with no assignment and `bind:group` on a non-variable
  // were collected into a list nobody read again.
  it('reports an error the template build finds', async () => {
    const { warnings } = await cx('<script>\nconst r = 1\n</script><b bind:this={r}></b>')
    expect(warnings.join('\n')).toMatch(/bind:this=\{r\} — 'r' must be a top-level let variable/)
  })

  it('reports {@const} with no assignment', async () => {
    const { warnings } = await cx('<script>\nlet xs = [1]\n</script>{#each xs as x}{@const y}{/each}')
    expect(warnings.join('\n')).toMatch(/\{@const\}: expected assignment form/)
  })
})

describe('renderComponent refuses a compile that collected errors', () => {
  // The prerender path read `ctx.result` and never `ctx.analysis.errors`, so a
  // component the compiler had refused was rendered and shipped.
  it('names the file and the error', async () => {
    let msg = ''
    try {
      await renderComponent('<b>{@attach foo}</b>', { filename: '/tmp/Attach.mesa' })
    } catch (e) { msg = e.message }
    expect(msg).toContain('/tmp/Attach.mesa')
    expect(msg).toMatch(/\{@attach\} is an element directive/)
  })

  it('still renders a clean component', async () => {
    const out = await renderComponent('<script>\nlet n = 1\n</script><b>{n}</b>', { filename: '/tmp/Ok.mesa' })
    expect(out.html).toContain('<b>1</b>')
  })

  // One throw for the whole tree. A prerender walks hundreds of components and
  // each error is independent, so failing at the first costs a rebuild per error.
  it('names every broken file in the tree, in one throw', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mesa-tree-'))
    await writeFile(path.join(dir, 'Child.mesa'), '<i>{@attach two}</i>\n')
    await writeFile(
      path.join(dir, 'Parent.mesa'),
      "<script>\nimport Child from './Child.mesa'\n</script><b>{@attach one}</b><Child />\n"
    )
    let msg = ''
    try {
      await renderComponent(null, { filename: path.join(dir, 'Parent.mesa') })
    } catch (e) { msg = e.message }
    expect(msg).toContain('Parent.mesa')
    expect(msg).toContain('Child.mesa')
    expect(msg).toContain('2 compile error(s) in 2 file(s)')
  })
})

// ─── FJS-830 · a script that is not JavaScript ───────────────────────────────

describe('a <script> the compiler cannot read', () => {
  // `lang` decided how the block was READ and nothing checked the answer: a
  // non-JS block was read as raw text, handed to acorn, and traded for an empty
  // program on the first type annotation — so the template was compiled against
  // a script declaring nothing and the browser threw ReferenceError at mount.
  it('refuses lang="ts" by name', async () => {
    const msg = await threw('<script lang="ts">let n: number = 0</script><b>{n}</b>')
    expect(msg).toContain('lang="ts"')
    expect(msg).toMatch(/Mesa compiles JavaScript only/)
  })

  it('refuses type="application/ld+json" by name', async () => {
    const msg = await threw('<script type="application/ld+json">{"a":1}</script><b>x</b>')
    expect(msg).toContain('application/ld+json')
  })

  it('points type="module" at the spelling that works', async () => {
    const msg = await threw('<script type="module">let n = 1</script><b>{n}</b>')
    expect(msg).toContain('<script module>')
  })

  it('accepts the JavaScript spellings', async () => {
    expect(await threw('<script type="text/javascript">let n = 1</script><b>{n}</b>')).toBe('')
    expect(await threw('<script>let n = 1</script><b>{n}</b>')).toBe('')
  })

  // acorn names a position and nothing else, in a file whose author has no
  // reason to think the compiler was reading JavaScript at that offset.
  it('names the block and the line in the .mesa when the script does not parse', async () => {
    const msg = await threw('<b>x</b>\n<script>\nlet n = 0\nlet = 5\n</script>')
    expect(msg).toContain('<script> does not parse')
    expect(msg).toContain('(4:0)')
  })
})

// ─── FJS-866 · export forms an instance script does not have ─────────────────

describe('an instance <script> may not export a default', () => {
  // Neither form carries a declaration, so the check that names `export class`
  // walked past both and the statement was emitted VERBATIM inside the
  // component function, where acorn refuses it at a line the author never wrote.
  it('refuses export default by name', async () => {
    const { errors } = await cx('<script>\nexport default 1\nlet n = 0\n</script><b>{n}</b>')
    expect(errors.join('\n')).toContain("'export default'")
    expect(errors.join('\n')).toMatch(/exports only props \(`export let`, `const`, `var`\)/)
  })

  it('refuses export * by name', async () => {
    const { errors } = await cx("<script>\nexport * from './x.js'\nlet n = 0\n</script><b>{n}</b>")
    expect(errors.join('\n')).toContain("'export *'")
  })

  it('still allows export let and export function', async () => {
    const { errors } = await cx(
      '<script>\nexport let qty = 1\nexport function bump() { qty++ }\n</script><b>{qty}</b>'
    )
    expect(errors).toEqual([])
  })

  // The emitted module already carries `export default function <Component>`,
  // so a second one is a duplicate acorn refuses.
  it('refuses export default in a <script module> too', async () => {
    const msg = await threw('<script module>export default 1</script><b>x</b>')
    expect(msg).toMatch(/<script module> cannot 'export default'/)
  })

  it('still allows a named module export', async () => {
    expect(await threw('<script module>export const subject = "hi"</script><b>x</b>')).toBe('')
  })
})

// ─── bind: on an immutable local ─────────────────────────────────────────────

// The setter is emitted as `name = $$v` whatever the target is, so a bare
// `const` or an import compiled clean and threw `TypeError: Assignment to
// constant variable` on the first keystroke. Invariant 15's blind spot: an
// assignment to a const is a RUNTIME error, so the output parses and every
// compiler test that only asserts parseability passes.
describe('bind: on a local binding that cannot hold a write', () => {
  // Every refusal is paired with the legitimate shape one character away, or a
  // guard that refused every bind: would satisfy the whole describe.
  it('refuses a derived const and names the writable derived form', async () => {
    const { errors } = await cx(
      "<script>\nlet name = ''\nconst greeting = name ? 'Hi ' + name : 'Hi'\n</script><input bind:value={greeting} />"
    )
    expect(errors.join('\n')).toMatch(/cannot two-way bind: `const greeting` is derived/)
    expect(errors.join('\n')).toMatch(/\$: greeting = \.\.\./)
  })

  it('refuses a static const and names let', async () => {
    const { errors } = await cx("<script>\nconst g = 'hi'\n</script><input bind:value={g} />")
    expect(errors.join('\n')).toMatch(/`const g` cannot be reassigned\. Declare it `let`/)
  })

  // `var` is Mesa's opt-out from reactivity (RULE 13), so this one does not
  // throw either: the write lands and no reader re-runs. What is missing is the
  // model->DOM half, so `bind:` here means half of what it means one line away,
  // selected by a keyword the template cannot see.
  it('refuses a top-level var', async () => {
    const { errors } = await cx("<script>\nvar g = 'hi'\n</script><input bind:value={g} />")
    expect(errors.join('\n')).toMatch(/`var g` is outside the reactive graph/)
  })

  // Write-without-re-render is a real thing to want, and `let` is not the
  // answer to it — so the refusal names the road instead of only the rule.
  it('names the write-only road rather than only `let`', async () => {
    const { errors } = await cx("<script>\nvar g = 'hi'\n</script><input bind:value={g} />")
    expect(errors.join('\n')).toMatch(/on:input=\{e => \{ g = e\.target\.value \}\}/)
  })

  // Advice that fails when taken is worse than none: the shape the message
  // hands the author is compiled here, not merely quoted.
  it('and that road compiles, with the var still untracked', async () => {
    const { ctx, errors, warnings } = await cx(
      "<script>\nvar g = 'hi'\n</script><input on:input={e => { g = e.target.value }} />"
    )
    expect(errors).toEqual([])
    expect(warnings).toEqual([])
    // untrack() is what keeps the write from re-rendering — the whole point of
    // reaching for `var`, so a `let` slipped in here would pass the two above.
    expect(String(ctx.result)).toMatch(/untrack/)
  })

  it('refuses an imported binding', async () => {
    const { errors } = await cx("<script>\nimport { g } from './x.js'\n</script><input bind:value={g} />")
    expect(errors.join('\n')).toMatch(/`g` is an imported binding/)
  })

  // This one does not throw — a function declaration is assignable — so the
  // control goes dead in silence, which is the worse of the two failures.
  it('refuses a function declaration', async () => {
    const { errors } = await cx('<script>\nfunction g() {}\n</script><input bind:value={g} />')
    expect(errors.join('\n')).toMatch(/`g` is a function, not reactive state/)
  })

  it('refuses bind:checked and bind:value alike', async () => {
    const { errors } = await cx(
      "<script>\nconst g = true\n</script><input type=\"checkbox\" bind:checked={g} />"
    )
    expect(errors.join('\n')).toMatch(/bind:checked=\{g\} — cannot two-way bind/)
  })

  it('still binds a let', async () => {
    const { errors } = await cx("<script>\nlet g = 'hi'\n</script><input bind:value={g} />")
    expect(errors).toEqual([])
  })

  // The `$:` assignment form exists precisely so a control can override a
  // derived default (VISION §4.5) — refusing it would delete the feature.
  it('still binds a $: writable derived', async () => {
    const { errors } = await cx('<script>\nlet n = 1\n$: g = n * 2\n</script><input bind:value={g} />')
    expect(errors).toEqual([])
  })

  // Only a bare identifier is graded: a write THROUGH a const object is how
  // every form bound to a draft record works.
  it('still binds a member of a const object', async () => {
    const { errors } = await cx(
      "<script>\nconst draft = { a: '' }\n</script><input bind:value={draft.a} />"
    )
    expect(errors).toEqual([])
  })

  it('still binds a computed index on a const object', async () => {
    const { errors } = await cx(
      "<script>\nconst draft = { a: '' }\nlet key = 'a'\n</script><input bind:value={draft[key]} />"
    )
    expect(errors).toEqual([])
  })
})

// ─── a `$:` assignment redeclared ────────────────────────────────────────────

// `$: name = expr` IS a declaration, and it is the only one JavaScript does not
// know about — acorn refuses `let x` twice at parse time, so this is the single
// duplicate binding that can reach the analyzer. Pass 1 walks `ast.body` in
// source order and only the `$:` side was guarded, so with the label FIRST the
// plain declaration overwrote the entry and the writable derived vanished with
// nothing said: a `bind:value` on it silently stopped being overridable.
describe('a name declared twice, once by $:', () => {
  it('refuses the declaration after the label', async () => {
    const { errors } = await cx(
      "<script>\nlet n = ''\n$: g = 'H' + n\nconst g = 'H' + n\n</script><p>{g}</p>"
    )
    expect(errors.join('\n')).toMatch(/'g' is already declared by '\$: g = \.\.\.'/)
  })

  it('refuses the label after the declaration', async () => {
    const { errors } = await cx(
      "<script>\nlet n = ''\nconst g = 'H' + n\n$: g = 'H' + n\n</script><p>{g}</p>"
    )
    expect(errors.join('\n')).toMatch(/'\$: g = \.\.\.' — 'g' is already declared/)
  })

  // `var` twice is legal JavaScript, so acorn lets it through — the label is
  // still a redeclaration.
  for (const kw of ['let', 'var', 'export let']) {
    it(`refuses \`${kw}\` after the label`, async () => {
      const { errors } = await cx(
        `<script>\nlet n = ''\n$: g = 'H' + n\n${kw} g = 'x'\n</script><p>{g}</p>`
      )
      expect(errors.join('\n')).toMatch(/'g' is already declared by/)
    })
  }

  // Destructuring reaches `vars` through a different writer, so the guard has
  // to sit on all four.
  it('refuses a destructured name that collides with the label', async () => {
    const { errors } = await cx(
      "<script>\nlet n = ''\n$: g = 'H' + n\nconst { g, h } = { g: 1, h: 2 }\n</script><p>{g}{h}</p>"
    )
    expect(errors.join('\n')).toMatch(/'g' is already declared by/)
  })

  it('refuses an array-destructured name that collides with the label', async () => {
    const { errors } = await cx(
      "<script>\nlet n = ''\n$: g = 'H' + n\nconst [g, h] = [1, 2]\n</script><p>{g}{h}</p>"
    )
    expect(errors.join('\n')).toMatch(/'g' is already declared by/)
  })

  it('leaves a label with no collision alone', async () => {
    const { errors } = await cx(
      "<script>\nlet n = ''\n$: g = 'H' + n\nconst { a, b } = { a: 1, b: 2 }\n</script><p>{g}{a}{b}</p>"
    )
    expect(errors).toEqual([])
  })
})

// ─── FJS-1109 · Svelte and React spellings refused by name ──────────────────

describe('a construct from another framework is refused by name', () => {
  it('refuses the one-line {#await p then v}', async () => {
    expect(await threw('<script>let p = Promise.resolve(1)</script>{#await p then v}<b>{v}</b>{/await}'))
      .toContain('one-line `then` form is not supported')
  })

  it('refuses JSX inside an expression', async () => {
    expect(await threw('<script>let ok = true</script>{ok && <b>x</b>}'))
      .toContain('JSX inside an expression is not supported')
    expect(await threw('<script>let ok = true</script>{ok ? <A/> : null}'))
      .toContain('JSX inside an expression')
  })

  it('leaves a comparison and a string holding a tag alone', async () => {
    expect(await threw('<script>let a = 1, b = 2</script><b>{a <b ? 1 : 2}</b>')).toBe('')
    expect(await threw("<script>let ok = true</script><b>{ok && '<b>'}</b>")).toBe('')
  })

  // An expression is emitted verbatim, so one that is not JavaScript compiled
  // clean and failed at import naming no file. The shape that found it: a
  // vendor's widget snippet with CSS in a data attribute (ksite's LeadForm.md).
  it('refuses an expression that is not JavaScript, in text and in an attribute', async () => {
    expect(await threw('<div data-styles="main { --x: 1; --y: 2;}"></div>'))
      .toContain('is not a JavaScript expression')
    expect(await threw('<p>{ --x: 1 }</p>')).toContain('is not a JavaScript expression')
    expect(await threw('<div data-x="{ a: 1 }"></div>')).toContain('is not a JavaScript expression')
  })

  it('leaves a sequence, an object literal and a template string alone', async () => {
    expect(await threw('<script>let a = 1</script><p>{(a, 2)}</p>')).toBe('')
    expect(await threw('<script>let a = 1</script><p>{JSON.stringify({ a })}</p>')).toBe('')
    expect(await threw('<script>let a = 1</script><p title={`x${a}`}>{a > 0 ? `y` : `z`}</p>')).toBe('')
    expect(await threw('<div data-styles="main &lbrace; --x: 1 }"></div>')).toBe('')
  })

  it('refuses assigning a derived const', async () => {
    const { errors } = await cx(
      '<script>let a = 1; const d = a * 2; function f() { d = 3 }</script><button onclick={f}>{d}</button>')
    expect(errors.join('\n')).toContain("'d' is a derived 'const'")
  })

  it('allows a local that shadows the derived', async () => {
    const { errors } = await cx(
      '<script>let a = 1; const d = a * 2; function f() { let d = 0; d = 3 }</script><button onclick={f}>{d}</button>')
    expect(errors).toEqual([])
  })

  // FJS-1570: a concise arrow returning a function has a `body.body` that is a
  // BlockStatement, not a statement list, and the shadow check threw on it.
  it('compiles a concise arrow that returns a function', async () => {
    const { errors } = await cx(
      '<script>let a = 1; const d = a * 2; const mk = (n) => () => { a = n }</script><button onclick={mk(2)}>{d}</button>')
    expect(errors).toEqual([])
  })
})

// ─── FJS-1495 · a tag that names nothing in scope ────────────────────────────

describe('a component tag must name a binding', () => {
  // It compiled to `Hero($$el0, …)` against an undeclared identifier. The dev
  // server shipped a ReferenceError at runtime and a prerender told the author
  // to guard a browser global with `typeof`, which ships the page with the block
  // silently missing.
  it('refuses <Hero /> with no import, naming the tag and both ways to bind it', async () => {
    const { errors } = await cx('<Hero />')
    const msg = errors.join('\n')
    expect(msg).toContain('<Hero>')
    expect(msg).toContain('import Hero from')
    expect(msg).toContain('autoImport')
  })

  it('names the tag nested in an element and inside a block', async () => {
    const { errors } = await cx('<script>let xs = [1]</script><main>{#if xs.length}<Card />{/if}</main>')
    expect(errors.join('\n')).toContain('<Card>')
  })

  it('names the root of a member tag', async () => {
    const { errors } = await cx('<Menu.Item />')
    expect(errors.join('\n')).toContain('<Menu.Item>')
  })

  it('accepts every way a name is bound', async () => {
    const bound = [
      "<script>import Hero from './Hero.mesa'</script><Hero />",
      "<script module>import Hero from './Hero.mesa'</script><Hero />",
      '<script module>export const Hero = () => {}</script><Hero />',
      '<script>const Hero = () => {}</script><Hero />',
      '<script>function Hero() {}</script><Hero />',
      '<script>let { Hero } = $.props()</script><Hero />',
      '<script>let xs = []</script>{#each xs as Item}<Item />{/each}',
      '<script>let xs = []</script>{#each xs as x, Idx}<Idx />{/each}',
      '{#snippet row(Cell)}<Cell />{/snippet}',
      '{#snippet Row()}<b>x</b>{/snippet}<Row />',
      '<script>let o = {}</script>{@const K = o.k}<K />',
      '<script>let p = 1</script>{#await p}a{:then V}<V />{/await}',
      "<script>import * as Kit from './kit.js'</script><Kit.Hero />",
    ]
    for (const src of bound) expect(await cx(src).then((r) => r.errors), src).toEqual([])
  })
})
