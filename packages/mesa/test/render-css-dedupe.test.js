/**
 * @vitest-environment node
 *
 * render-css-dedupe.test.js — the build-time CSS collector (FJS-871).
 *
 * The scope id is a hash of the style content and nothing else (Invariant 12),
 * so two components with byte-identical CSS share one id. That is the point:
 * it is what lets a component compiled twice — once by this renderer, once by
 * Vite for its client chunk — land on one `<style id=…>` the runtime's
 * `addStyles` recognizes. The collector did not use it: it concatenated each
 * module's CSS blindly, so a design system's one style block shipped once per
 * component that used it.
 *
 * The negative control is the whole test. A collector that dropped every
 * duplicate SELECTOR, or that emitted one block for the tree, passes the
 * "no copies" assertion and ships a page with missing styles — so every
 * dedupe case here is paired with a distinct-CSS case that must survive.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderComponent } from '../src/render-component.js'

/** Write a component tree to a throwaway directory and render its entry. */
async function tree(files, entry, options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mesa-css-'))
  for (const [name, src] of Object.entries(files)) writeFileSync(path.join(dir, name), src)
  return renderComponent(entry, { cwd: dir, filename: path.join(dir, 'Page.mesa'), target: 'html', ...options })
}

const SHARED = '<style>\n  .btn { color: red }\n</style>'
const PAGE   = `<script>\n  import A from './A.mesa'\n  import B from './B.mesa'\n</script>\n<A /><B />\n`

describe('two components with byte-identical CSS', () => {
  it('collects the rules once', async () => {
    const r = await tree({
      'A.mesa': `<div class="btn">A</div>\n${SHARED}\n`,
      'B.mesa': `<div class="btn">B</div>\n${SHARED}\n`,
    }, PAGE)
    expect(r.css.match(/color: red/g)).toHaveLength(1)
  })

  it('reports one style block, under the shared id', async () => {
    const r = await tree({
      'A.mesa': `<div class="btn">A</div>\n${SHARED}\n`,
      'B.mesa': `<div class="btn">B</div>\n${SHARED}\n`,
    }, PAGE)
    expect(r.styles).toHaveLength(1)
    expect(r.styles[0].id).toBeTruthy()
  })

  it('emits the <style> tag once', async () => {
    const r = await tree({
      'A.mesa': `<div class="btn">A</div>\n${SHARED}\n`,
      'B.mesa': `<div class="btn">B</div>\n${SHARED}\n`,
    }, PAGE)
    expect(r.html.match(/color: red/g)).toHaveLength(1)
  })

  // Both components still carry the shared scope class, so dropping the second
  // copy costs neither of them its styling.
  it('both components still carry the scope class', async () => {
    const r = await tree({
      'A.mesa': `<div class="btn">A</div>\n${SHARED}\n`,
      'B.mesa': `<div class="btn">B</div>\n${SHARED}\n`,
    }, PAGE)
    const id = r.styles[0].id
    expect(r.html.match(new RegExp(id, 'g'))).toHaveLength(3)  // the block plus both elements
  })
})

describe('the negative control — distinct CSS must all survive', () => {
  it('keeps both components rules', async () => {
    const r = await tree({
      'A.mesa': '<div class="btn">A</div>\n<style>\n  .btn { color: red }\n</style>\n',
      'B.mesa': '<div class="btn">B</div>\n<style>\n  .btn { color: blue }\n</style>\n',
    }, PAGE)
    expect(r.styles).toHaveLength(2)
    expect(r.css).toContain('color: red')
    expect(r.css).toContain('color: blue')
  })

  it('a shared block and a distinct one land together', async () => {
    const r = await tree({
      'A.mesa': `<div class="btn">A</div>\n${SHARED}\n`,
      'B.mesa': `<div class="btn">B</div>\n${SHARED}\n`,
      'C.mesa': '<div class="tag">C</div>\n<style>\n  .tag { color: green }\n</style>\n',
    }, `<script>\n  import A from './A.mesa'\n  import B from './B.mesa'\n  import C from './C.mesa'\n</script>\n<A /><B /><C />\n`)
    expect(r.styles).toHaveLength(2)
    expect(r.css.match(/color: red/g)).toHaveLength(1)
    expect(r.css.match(/color: green/g)).toHaveLength(1)
  })
})

describe('the inlining targets', () => {
  // email and fragment de-scope, so identical CSS flattens to identical
  // selectors — the same id still keys the dedupe.
  it('fragment collects a shared block once', async () => {
    const r = await tree({
      'A.mesa': `<div class="btn">A</div>\n${SHARED}\n`,
      'B.mesa': `<div class="btn">B</div>\n${SHARED}\n`,
    }, PAGE, { target: 'fragment' })
    expect(r.css.match(/color: red/g)).toHaveLength(1)
  })
})
