// @vitest-environment node
//
// render-cache.test.js — renderComponent compiles a tree once and reuses it
// (`FJS-1659`). Each call used to import the tree under fresh temp names, and
// a runtime keeps every module it imports: 1.25 MB per render, for the life
// of a server that renders per recipient or per email.
//
// A `<script module>` runs once per IMPORT, so a stamp it exports tells the
// two apart: equal across renders is one import.

import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { renderFile, renderComponent } from '../src/render-component.js'

async function tree() {
  const dir = await mkdtemp(path.join(tmpdir(), 'mesa-cache-'))
  await writeFile(path.join(dir, 'Child.mesa'), '<script>\nexport let who = ""\n</script><i>hello {who}</i>\n')
  await writeFile(path.join(dir, 'Parent.mesa'),
    "<script module>\nexport const stamp = Math.random()\n</script>\n<script>\nimport Child from './Child.mesa'\nexport let who = ''\n</script><b><Child who={who} /></b>\n")
  return dir
}

describe('the compiled tree', () => {
  it('is imported once, and each render still gets its own data', async () => {
    const dir = await tree()
    const a = await renderFile(path.join(dir, 'Parent.mesa'), { data: { who: 'Ada' } })
    const b = await renderFile(path.join(dir, 'Parent.mesa'), { data: { who: 'Cora' } })
    expect(a.html).toContain('hello Ada')
    expect(b.html).toContain('hello Cora')
    expect(b.exports.stamp).toBe(a.exports.stamp)
  })

  it('is compiled again when a file in it changes on disk', async () => {
    const dir = await tree()
    const a = await renderFile(path.join(dir, 'Parent.mesa'), { data: { who: 'Ada' } })
    await writeFile(path.join(dir, 'Child.mesa'), '<script>\nexport let who = ""\n</script><i>goodbye {who}</i>\n')
    const b = await renderFile(path.join(dir, 'Parent.mesa'), { data: { who: 'Ada' } })
    expect(b.html).toContain('goodbye Ada')
    expect(b.exports.stamp).not.toBe(a.exports.stamp)
  })

  it('is its own per source, so a different entry is never served from another', async () => {
    const one = await renderComponent('<p>one</p>', { filename: '/tmp/Same.mesa' })
    const two = await renderComponent('<p>two</p>', { filename: '/tmp/Same.mesa' })
    expect(one.html).toContain('one')
    expect(two.html).toContain('two')
  })

  it('is its own per target, so an email render never reuses an html one', async () => {
    const src = '<p class="x">hi</p>\n<style>\n.x { color: red; }\n</style>\n'
    const html  = await renderComponent(src, { filename: '/tmp/Target.mesa', target: 'html' })
    const email = await renderComponent(src, { filename: '/tmp/Target.mesa', target: 'email' })
    expect(html.html).toMatch(/<style>/)
    expect(email.html).toMatch(/style="[^"]*color:\s*red/)
  })

  // Six at once, over a tree of three imports: each used to move the shared
  // import regex under the others, and four of six imported a .mesa file raw
  // (`FJS-1661`). Now they share one compile.
  it('renders correctly when several calls arrive at once, and compiles once for all of them', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'mesa-cache-'))
    for (const x of ['B', 'C', 'D']) await writeFile(path.join(dir, `${x}.mesa`), `<i>${x}</i>\n`)
    await writeFile(path.join(dir, 'A.mesa'),
      "<script module>\nexport const stamp = Math.random()\n</script>\n<script>\nimport B from './B.mesa'\nimport C from './C.mesa'\nimport D from './D.mesa'\nexport let n = 0\n</script><p><B /><C /><D /> {n}</p>\n")
    const out = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => renderFile(path.join(dir, 'A.mesa'), { data: { n } })))
    out.forEach((o, i) => expect(o.html).toContain(`<i>B</i><i>C</i><i>D</i> ${i + 1}`))
    expect(new Set(out.map((o) => o.exports.stamp)).size).toBe(1)
  })
})
