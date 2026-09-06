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
    expect(errors.join('\n')).toMatch(/exports only `export let`/)
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
