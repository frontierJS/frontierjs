/**
 * md-layout.test.js — a `.md` file's `layout:` wraps its body
 *
 * `compileMd` parsed `layout:` into `ctx.layout` and nothing ever read it, so a
 * Markdown file could not say what it was a block OF — which is how every
 * ksite block is written (`layout: Block`, mdsvex's `layout` map) (FJS-1493).
 * The caller says which file a name means (`layouts`); Mesa does the wrap.
 *
 * Run: npx vitest run md-layout.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import path from 'path'
import { compileMd } from '../src/compiler-md.js'
import { renderComponent } from '../src/render-component.js'

const DIR = '/tmp/mesa/md-layout'
const layouts = {
  Slotted:   path.join(DIR, 'Slotted.mesa'),
  Snippeted: path.join(DIR, 'Snippeted.mesa'),
}
const errorsOf = (ctx) => (ctx.analysis?.errors ?? []).join('\n')
const strip = (html) => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/ class="[^"]*"/g, (m) => m.replace(/\s+m[a-z0-9]{8,}\b/g, ''))

async function render(md, use = '<Page />') {
  writeFileSync(path.join(DIR, 'Page.md'), md)
  const out = await renderComponent(`<script>\n  import Page from './Page.md'\n</script>\n${use}\n`, {
    cwd: DIR, filename: path.join(DIR, 'Entry.mesa'), compileOptions: { layouts },
  })
  return strip(out.html)
}

beforeAll(() => {
  mkdirSync(DIR, { recursive: true })
  writeFileSync(layouts.Slotted,
    "<script>\n  export let classes = ''\n  export let template = ''\n</script>\n" +
    '<section class="block {classes} {template}" {class}><slot /></section>\n')
  writeFileSync(layouts.Snippeted,
    "<script>\n  export let children = null\n  export let tone = ''\n</script>\n" +
    '<aside class="{tone}">{@render children?.()}</aside>\n')
})

afterAll(() => rmSync(DIR, { recursive: true, force: true }))

describe('layout: in a .md file', () => {
  it('wraps the body in a <slot /> layout, with the frontmatter as its props', async () => {
    const html = await render('---\nlayout: Slotted\nclasses: bg-block\ntemplate: with-media\n---\n\n# Hi\n')
    expect(html).toContain('<section class="block bg-block with-media"><h1 id="hi">Hi</h1></section>')
  })

  it('hands a {@render children} layout the same body', async () => {
    const html = await render('---\nlayout: Snippeted\ntone: warm\n---\n\nBody.\n')
    expect(html).toContain('<aside class="warm"><p>Body.</p></aside>')
  })

  it("passes the parent's class and its values over the file's own", async () => {
    const html = await render('---\nlayout: Slotted\nclasses: bg-block\n---\n\nX\n', '<Page class="extra" classes="override" />')
    expect(html).toContain('<section class="block override extra"><p>X</p></section>')
  })

  it('refuses a name the map does not hold, listing the ones it does', async () => {
    const ctx = await compileMd('---\nlayout: Nope\n---\n\nX\n', { filename: 'Nope.md', layouts })
    expect(errorsOf(ctx)).toMatch(/layout: Nope names no layout\. Known: Slotted, Snippeted/)
  })

  // The negative controls: no map is the old behavior, and `false` opts out.
  it('with no map, layout: is metadata and wraps nothing', async () => {
    const ctx = await compileMd('---\nlayout: Slotted\n---\n\nX\n', { filename: 'NoMap.md' })
    expect(errorsOf(ctx)).toBe('')
    expect(ctx.result).not.toContain('MarkdownLayout')
    expect(ctx.layout).toBe('Slotted')
  })

  it('layout: false wraps nothing', async () => {
    const html = await render('---\nlayout: false\n---\n\nPlain.\n')
    expect(html).toContain('<p>Plain.</p>')
    expect(html).not.toContain('<section')
  })
})
