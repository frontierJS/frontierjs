/**
 * md-script.test.js
 *
 * A `.md` body is content, and `extractScript` decides which part of it is code.
 * It used to take the FIRST <script> found anywhere at any depth, splice it into
 * the component factory and delete the element, so a static build imported and
 * RAN a script sitting in a paragraph — with full filesystem, network and
 * `process` access — and served a page that looked clean (FJS-834).
 *
 * Run: npx vitest run md-script.test.js
 */

import { describe, it, expect } from 'vitest'
import { compileMd } from '../src/compiler-md.js'
import { renderComponent } from '../src/render-component.js'

const errorsOf = ctx => (ctx.analysis?.errors ?? []).join('\n')

describe('a <script> in a Markdown body', () => {
  it('promotes a leading block to the component script', async () => {
    const ctx = await compileMd(
      '---\ntitle: T\n---\n<script>\n  let greeting = 1\n</script>\n\n# Hi {greeting}\n',
      { filename: 'Lead.md' }
    )
    expect(errorsOf(ctx)).toBe('')
    expect(ctx.result).toContain('greeting')
  })

  it('promotes a leading block when there is no frontmatter', async () => {
    const ctx = await compileMd('<script>\n  let y = 2\n</script>\n\nHello {y}\n', { filename: 'Bare.md' })
    expect(errorsOf(ctx)).toBe('')
  })

  it('refuses a block that follows content, and does not emit it', async () => {
    const ctx = await compileMd(
      'Hello\n\n<script>globalThis.__mdScriptRan = 1</script>\n\nbye\n',
      { filename: 'Later.md' }
    )
    expect(errorsOf(ctx)).toMatch(/only the block before any content/)
    expect(ctx.result).not.toContain('__mdScriptRan')
  })

  // The compiler parses whatever <script> it finds as JavaScript, so a non-JS
  // type is not a safe passenger either: promoted it executes JSON, passed
  // through it dies as a parse error further down naming nothing.
  it('refuses a leading block that declares a non-JavaScript type', async () => {
    const ctx = await compileMd(
      '<script type="application/ld+json">{"@type":"Article"}</script>\n\nhi\n',
      { filename: 'Ld.md' }
    )
    expect(errorsOf(ctx)).toMatch(/may not declare another type/)
    expect(errorsOf(ctx)).toContain('application/ld+json')
  })

  it('names every refused block rather than the first', async () => {
    const ctx = await compileMd('a\n\n<script>one()</script>\n\nb\n\n<script>two()</script>\n', { filename: 'Two.md' })
    expect(ctx.analysis.errors).toHaveLength(2)
  })

  // The measurement that matters: renderComponent imports the compiled module
  // under Bun/Node, so a promoted script is remote code execution at build time.
  // Two mechanisms, asserted apart. The strip is what stops the execution, and
  // it would hold on its own; the refusal is what stops a page being rendered
  // with content silently deleted from it. Asserting only the first passed
  // while `renderComponent` still rendered such a page and said nothing
  // (FJS-845).
  it('does not execute a mid-body script during a server render, and refuses the render', async () => {
    delete globalThis.__mdScriptRan
    await expect(renderComponent(
      'Hello <img src="x" alt="a"> and <script>globalThis.__mdScriptRan = 1</script> end.',
      { filename: 'Pwn.md', target: 'fragment' }
    )).rejects.toThrow(/Pwn\.md[\s\S]*only the block before any content/)
    expect(globalThis.__mdScriptRan).toBeUndefined()
  })
})
