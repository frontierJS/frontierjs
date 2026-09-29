/**
 * md-frontmatter-export.test.js
 *
 * A `.md` file's frontmatter became props, and a prop is only readable from
 * inside an instance. A page listing a directory of Markdown files — ksite's
 * reviews, each `reviewer:`/`rating:`/`source:` over a paragraph — could render
 * every body and read none of the fields around it. `compileMd` now also exports
 * the frontmatter at module scope as `frontmatter`, mdsvex's `metadata`.
 *
 * Run: npx vitest run md-frontmatter-export.test.js
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdir, writeFile, rm } from 'fs/promises'
import path from 'path'
import { parse } from 'acorn'
import { compileMd } from '../src/compiler-md.js'
import { renderComponent } from '../src/render-component.js'

const DIR = '/tmp/mesa-md-frontmatter'

beforeAll(async () => {
  await mkdir(DIR, { recursive: true })
  await writeFile(path.join(DIR, 'stacy.md'), '---\nreviewer: Stacy\nrating: 5\n---\n\nThe best in town.\n')
  await writeFile(path.join(DIR, 'plain.md'), 'No frontmatter here.\n')
})

afterAll(async () => {
  await rm(DIR, { recursive: true, force: true })
})

describe('a .md module exports its frontmatter', () => {
  it('as a module-scope `frontmatter`, and the output parses', async () => {
    const ctx = await compileMd('---\nreviewer: Stacy\nrating: 5\n---\n\nThe best.\n', { filename: 'stacy.md' })
    expect(ctx.analysis?.errors ?? []).toEqual([])
    const ast = parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
    const exported = ast.body
      .filter((n) => n.type === 'ExportNamedDeclaration' && n.declaration)
      .flatMap((n) => n.declaration.declarations?.map((d) => d.id.name) ?? [])
    expect(exported).toContain('frontmatter')
  })

  it('keeps each key a prop as well', async () => {
    const ctx = await compileMd('---\nreviewer: Stacy\n---\n\nBy {reviewer}.\n', { filename: 'p.md' })
    expect(ctx.analysis?.errors ?? []).toEqual([])
    expect(ctx.result).toMatch(/reviewer/)
  })

  it('reaches a parent that imports it, with the body still a component', async () => {
    const result = await renderComponent(
      `<script>\n  import Stacy, { frontmatter } from './stacy.md'\n  import Plain, { frontmatter as none } from './plain.md'\n</script>` +
      `<cite>{frontmatter.reviewer} {frontmatter.rating}</cite><Stacy /><b>{Object.keys(none).length}</b><Plain />`,
      { cwd: DIR, target: 'html' }
    )
    expect(result.html).toContain('<cite>Stacy 5</cite>')
    expect(result.html).toContain('The best in town.')
    expect(result.html).toContain('<b>0</b>')
    expect(result.html).toContain('No frontmatter here.')
  })
})
